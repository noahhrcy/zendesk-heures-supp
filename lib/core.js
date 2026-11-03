/* ------------------------------------------------------------------
   Heures supp Zendesk — logique pure

   Aucune dépendance à chrome.* : ce module est partagé par le service
   worker, les pages de l'extension et les tests (tests/core.test.html).
   Horaires, jours fériés, calcul de la suggestion, formatage, totaux,
   construction du mail (.eml / mailto) et export CSV.
   ------------------------------------------------------------------ */

export const MIN_MS = 60 * 1000;
export const HOUR_MS = 60 * MIN_MS;
export const DAY_MS = 24 * HOUR_MS;

// Dépôt public d'où viennent les mises à jour (vérifiées, jamais installées seules).
export const GITHUB_REPO = 'noahhrcy/zendesk-heures-supp';
export const GITHUB_PAGE = `https://github.com/${GITHUB_REPO}`;
export const REMOTE_MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/manifest.json`;

// Un appel (ou un affichage du ticket) plus ancien que ça n'est plus une
// référence crédible pour estimer le temps passé.
export const MAX_REF_AGE_MS = 12 * HOUR_MS;

// Aucune donnée propre à une entreprise ici : destinataire, prénom, nom et
// adresse Zendesk se règlent dans les options (ou via config.local.json,
// fichier facultatif qui n'est jamais publié).
const DEFAULTS = {
  slots: [{ start: '08:30', end: '12:30' }, { start: '14:00', end: '17:00' }],
  workDays: [1, 2, 3, 4, 5],          // 0 = dimanche … 6 = samedi
  holidaysOff: true,                  // jours fériés = hors horaires
  clipToOutOfHours: true,             // ne proposer que la partie hors horaires
  testModeUntil: 0,                   // horodatage ; 0 = mode test désactivé
  recipientEmail: '',
  recipientName: '',
  senderName: '',
  mailMethod: 'eml',                  // 'eml' (Outlook, tableau) | 'mailto' (texte)
  zendeskOrigin: '',                  // https://<sous-domaine>.zendesk.com, relevé automatiquement
  animations: true,                   // animations de l'interface (même si Windows les réduit)
};

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const HM_RE = /^(\d{1,2}):(\d{2})$/;
const ZENDESK_ORIGIN_RE = /^https:\/\/[a-z0-9][a-z0-9-]*\.zendesk\.com$/;

export function isZendeskOrigin(v) {
  return typeof v === 'string' && ZENDESK_ORIGIN_RE.test(v);
}

// Lien vers un ticket, ou '' si l'adresse Zendesk est inconnue.
export function ticketUrl(origin, id) {
  return isZendeskOrigin(origin) && /^\d+$/.test(String(id)) ? `${origin}/agent/tickets/${id}` : '';
}

// « 1.2.10 » > « 1.2.9 » ; renvoie -1, 0 ou 1.
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/* ----------------------------- réglages ---------------------------- */

export function defaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

export function parseHM(str) {
  const m = HM_RE.exec(String(str ?? '').trim());
  if (!m) return NaN;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return NaN;
  return h * 60 + min;
}

function toHM(minutes) {
  return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
}

// Renvoie un message d'erreur, ou null si les créneaux sont valides.
export function validateSlots(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return 'Indiquez au moins un créneau de travail.';
  if (slots.length > 6) return 'Six créneaux au maximum.';
  const parsed = [];
  for (const sl of slots) {
    const start = parseHM(sl && sl.start), end = parseHM(sl && sl.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Heure invalide : utilisez le format HH:MM.';
    if (start >= end) return 'Chaque créneau doit finir après son début.';
    parsed.push({ start, end });
  }
  parsed.sort((a, b) => a.start - b.start);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].start < parsed[i - 1].end) return 'Les créneaux se chevauchent.';
  }
  return null;
}

export function normalizeSettings(raw) {
  const s = defaultSettings();
  if (!raw || typeof raw !== 'object') return s;

  if (Array.isArray(raw.slots)) {
    const slots = raw.slots.map(x => ({ start: String((x && x.start) ?? '').trim(), end: String((x && x.end) ?? '').trim() }));
    if (validateSlots(slots) === null) {
      s.slots = slots
        .map(x => ({ start: toHM(parseHM(x.start)), end: toHM(parseHM(x.end)) }))
        .sort((a, b) => parseHM(a.start) - parseHM(b.start));
    }
  }
  if (Array.isArray(raw.workDays)) {
    s.workDays = [...new Set(raw.workDays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  }
  for (const k of ['holidaysOff', 'clipToOutOfHours', 'animations']) {
    if (typeof raw[k] === 'boolean') s[k] = raw[k];
  }
  if (Number.isFinite(raw.testModeUntil) && raw.testModeUntil >= 0) s.testModeUntil = raw.testModeUntil;
  if (typeof raw.recipientEmail === 'string') {
    const v = raw.recipientEmail.trim();
    if (v === '' || EMAIL_RE.test(v)) s.recipientEmail = v;
  }
  if (typeof raw.recipientName === 'string') s.recipientName = raw.recipientName.trim().slice(0, 60);
  if (typeof raw.senderName === 'string') s.senderName = raw.senderName.trim().slice(0, 80);
  if (raw.mailMethod === 'eml' || raw.mailMethod === 'mailto') s.mailMethod = raw.mailMethod;
  if (isZendeskOrigin(raw.zendeskOrigin)) s.zendeskOrigin = raw.zendeskOrigin;
  return s;
}

export function isValidEmail(str) {
  return EMAIL_RE.test(String(str ?? '').trim());
}

export function isTestModeActive(s, now = Date.now()) {
  return s.testModeUntil > now;
}

function isTestModeAt(ts, s) {
  return s.testModeUntil > 0 && ts <= s.testModeUntil;
}

/* --------------------------- jours fériés -------------------------- */

// Dimanche de Pâques (algorithme de Meeus/Jones/Butcher, calendrier grégorien).
export function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

const holidayCache = new Map();

// Jours fériés de France métropolitaine : clé « AAAA-MM-JJ » → nom.
export function frenchHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const map = new Map();
  const add = (d, name) => map.set(dateKey(d.getTime()), name);
  const fixed = [[0, 1, 'Jour de l’an'], [4, 1, 'Fête du Travail'], [4, 8, 'Victoire 1945'],
    [6, 14, 'Fête nationale'], [7, 15, 'Assomption'], [10, 1, 'Toussaint'],
    [10, 11, 'Armistice'], [11, 25, 'Noël']];
  for (const [mo, da, name] of fixed) add(new Date(year, mo, da), name);
  const easter = easterSunday(year);
  const plus = n => new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() + n);
  add(plus(1), 'Lundi de Pâques');
  add(plus(39), 'Ascension');
  add(plus(50), 'Lundi de Pentecôte');
  holidayCache.set(year, map);
  return map;
}

export function holidayName(ts) {
  const d = new Date(ts);
  return frenchHolidays(d.getFullYear()).get(dateKey(ts)) || null;
}

/* ------------------------- horaires de travail --------------------- */

function slotMinutes(s) {
  return s.slots.map(sl => ({ start: parseHM(sl.start), end: parseHM(sl.end) }))
    .filter(sl => Number.isFinite(sl.start) && Number.isFinite(sl.end) && sl.start < sl.end)
    .sort((a, b) => a.start - b.start);
}

function minuteOfDay(d) {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60000;
}

// Horodatage du jour `day` (Date) à `minutes` après minuit, heure locale.
// Passer par le constructeur Date garde le calcul juste aux changements d'heure.
function atMinutes(day, minutes) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60).getTime();
}

function isWorkDay(d, s) {
  if (!s.workDays.includes(d.getDay())) return false;
  return !(s.holidaysOff && holidayName(d.getTime()));
}

export function isWorkingTime(ts, s) {
  const d = new Date(ts);
  if (!isWorkDay(d, s)) return false;
  const mod = minuteOfDay(d);
  return slotMinutes(s).some(sl => mod >= sl.start && mod < sl.end);
}

// Classe un instant : { outOfHours, reason, holiday? }
// reason ∈ horaires | avant | pause | apres | jour | ferie | test
export function classifyTime(ts, s) {
  const d = new Date(ts);
  let natural;
  const holiday = s.holidaysOff ? holidayName(ts) : null;
  if (holiday) natural = { outOfHours: true, reason: 'ferie', holiday };
  else if (!s.workDays.includes(d.getDay())) natural = { outOfHours: true, reason: 'jour' };
  else {
    const mod = minuteOfDay(d);
    const slots = slotMinutes(s);
    if (!slots.length) natural = { outOfHours: true, reason: 'apres' };
    else if (slots.some(sl => mod >= sl.start && mod < sl.end)) natural = { outOfHours: false, reason: 'horaires' };
    else if (mod < slots[0].start) natural = { outOfHours: true, reason: 'avant' };
    else if (mod >= slots[slots.length - 1].end) natural = { outOfHours: true, reason: 'apres' };
    else natural = { outOfHours: true, reason: 'pause' };
  }
  if (!natural.outOfHours && isTestModeAt(ts, s)) return { outOfHours: true, reason: 'test' };
  return natural;
}

// « 8h30 », « 17h »
export function formatHourFr(hm) {
  const v = parseHM(hm);
  if (!Number.isFinite(v)) return String(hm);
  const h = Math.floor(v / 60), m = v % 60;
  return m ? `${h}h${pad2(m)}` : `${h}h`;
}

export function describeReason(cls, ts, s) {
  const slots = s.slots;
  switch (cls.reason) {
    case 'test': return 'mode test : compté comme hors horaires';
    case 'ferie': return `jour férié (${cls.holiday})`;
    case 'jour': return `${DAY_NAMES[new Date(ts).getDay()]}, jour non travaillé`;
    case 'avant': return `avant ${formatHourFr(slots[0].start)}`;
    case 'apres': return `après ${formatHourFr(slots[slots.length - 1].end)}`;
    case 'pause': {
      const mod = minuteOfDay(new Date(ts));
      for (let i = 1; i < slots.length; i++) {
        if (mod >= parseHM(slots[i - 1].end) && mod < parseHM(slots[i].start)) {
          return `pendant la pause (${formatHourFr(slots[i - 1].end)} – ${formatHourFr(slots[i].start)})`;
        }
      }
      return 'entre deux créneaux';
    }
    default: return 'pendant les horaires';
  }
}

// Début de la plage hors horaires qui contient `ts` : fin du dernier créneau
// de travail écoulé (ex. 17:00 pour une résolution à 17:20, 12:30 pour
// 12:50, vendredi 17:00 pour un samedi). Renvoie `ts` s'il est dans les
// horaires.
export function outOfHoursPeriodStart(ts, s) {
  if (isWorkingTime(ts, s)) return ts;
  const ref = new Date(ts);
  const slots = slotMinutes(s);
  for (let back = 0; back <= 21; back++) {
    const day = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - back);
    if (!isWorkDay(day, s)) continue;
    let best = null;
    for (const sl of slots) {
      const end = atMinutes(day, sl.end);
      if (end <= ts && (best === null || end > best)) best = end;
    }
    if (best !== null) return best;
  }
  return ts - DAY_MS; // aucun créneau sur 3 semaines : on borne à 24 h
}

function toMinutes(ms) {
  return Math.max(0, Math.round(ms / MIN_MS));
}

// Suggestion de durée pour une résolution.
// Référence : dernier appel trouvé dans le ticket, sinon première fois où le
// ticket a été affiché dans l'onglet. Hors mode test, on ne garde que la
// partie hors horaires (réglage « clipToOutOfHours ») et on démarre au plus
// tôt à la résolution précédente de la même plage (`notBefore`) : un même
// quart d'heure n'est jamais proposé deux fois.
export function computeSuggestion({ resolvedAt, lastCallAt, shownSince, notBefore }, s) {
  const cls = classifyTime(resolvedAt, s);
  const usable = t => Number.isFinite(t) && t > 0 && t <= resolvedAt + MIN_MS && resolvedAt - t <= MAX_REF_AGE_MS;
  let refAt = null, refSource = null;
  if (usable(lastCallAt)) { refAt = Math.min(lastCallAt, resolvedAt); refSource = 'appel'; }
  else if (usable(shownSince)) { refAt = Math.min(shownSince, resolvedAt); refSource = 'affichage'; }

  const fullGapMin = refAt === null ? null : toMinutes(resolvedAt - refAt);
  const clip = s.clipToOutOfHours && cls.outOfHours && cls.reason !== 'test';
  let periodStart = null, suggestedMin, start = refAt, boundBy = null;
  if (refAt === null) suggestedMin = 0;
  else if (!clip) suggestedMin = fullGapMin;
  else {
    periodStart = outOfHoursPeriodStart(resolvedAt, s);
    if (periodStart > start) { start = periodStart; boundBy = 'plage'; }
    if (Number.isFinite(notBefore) && notBefore < resolvedAt && notBefore >= periodStart && notBefore > start) {
      start = notBefore; boundBy = 'precedente';
    }
    suggestedMin = toMinutes(resolvedAt - start);
  }
  return {
    cls, refAt, refSource, fullGapMin, suggestedMin, periodStart, start, boundBy,
    clipped: boundBy !== null,
  };
}

/* ----------------------------- formatage --------------------------- */

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatDuration(min) {
  const v = Math.round(Number(min) || 0);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v), h = Math.floor(a / 60), m = a % 60;
  if (h === 0) return `${sign}${m} min`;
  if (m === 0) return `${sign}${h} h`;
  return `${sign}${h} h ${pad2(m)}`;
}

// Texte du badge de l'icône (4 caractères maximum).
export function formatBadge(min) {
  const v = Math.max(0, Math.round(min));
  if (v < 60) return `${v}m`;
  const h = Math.floor(v / 60);
  if (h >= 100) return `${h}h`;
  if (h >= 10) return `${h}h`;
  return `${h}:${pad2(v % 60)}`;
}

export function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function formatDate(ts) {
  const d = new Date(ts);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function formatDateShort(ts) {
  const d = new Date(ts);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function sameDay(a, b) {
  return dateKey(a) === dateKey(b);
}

// « 1h30 », « 1 h 30 », « 1:30 », « 90 », « 90 min », « 1,5 h », « 2h » → minutes.
// Un nombre entier sans unité est lu en minutes ; un décimal sans unité en heures.
export function parseDuration(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : NaN;
  const s = String(input ?? '').trim().toLowerCase().replace(/,/g, '.').replace(/\s+/g, '');
  if (!s) return NaN;
  let m;
  if ((m = /^(\d+(?:\.\d+)?)h(?:(\d{1,2})(?:m|min|mn)?)?$/.exec(s))) {
    const mins = m[2] === undefined ? 0 : Number(m[2]);
    if (mins > 59 || (m[2] !== undefined && m[1].includes('.'))) return NaN;
    return Math.round(Number(m[1]) * 60) + mins;
  }
  if ((m = /^(\d+):(\d{2})$/.exec(s))) {
    if (Number(m[2]) > 59) return NaN;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  if ((m = /^(\d+)(?:m|min|mn|mins|minutes?)?$/.exec(s))) return Number(m[1]);
  if ((m = /^(\d+\.\d+)$/.exec(s))) return Math.round(Number(m[1]) * 60);
  return NaN;
}

/* ------------------------- entrées et totaux ----------------------- */

export const ENTRY_KINDS = ['overtime', 'use', 'adjust'];

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function str(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// Valide et nettoie une entrée (ajout, modification, import). null si invalide.
//  overtime : heures supp effectuées (minutes > 0)
//  use      : heures supp utilisées / récupérées (minutes > 0, retirées du solde)
//  adjust   : report ou correction du solde (minutes ≠ 0, signe libre)
export function sanitizeEntry(e) {
  if (!e || typeof e !== 'object' || !ENTRY_KINDS.includes(e.kind)) return null;
  const minutes = Math.round(Number(e.minutes));
  if (!Number.isFinite(minutes) || minutes === 0) return null;
  if (e.kind === 'adjust' ? Math.abs(minutes) > 100000 : (minutes < 0 || minutes > 24 * 60)) return null;
  const at = Number(e.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const tid = String(e.ticketId ?? '').trim().replace(/^#/, '');
  const overtime = e.kind === 'overtime';
  return {
    id: typeof e.id === 'string' && e.id ? e.id.slice(0, 40) : uid(),
    kind: e.kind,
    minutes,
    at,
    ticketId: /^\d{1,12}$/.test(tid) ? tid : null,
    subject: str(e.subject, 200),
    org: str(e.org, 160),
    requester: str(e.requester, 160),
    note: str(e.note, 300),
    origin: isZendeskOrigin(e.origin) ? e.origin : '',
    declared: overtime ? !!e.declared : false,
    declaredAt: overtime && e.declared && Number.isFinite(e.declaredAt) ? e.declaredAt : null,
    source: e.source === 'auto' ? 'auto' : 'manuel',
    test: !!e.test,
    createdAt: Number.isFinite(e.createdAt) ? e.createdAt : at,
  };
}

export function computeTotals(entries) {
  const t = { earned: 0, used: 0, adjust: 0, balance: 0, undeclared: 0, undeclaredCount: 0, testCount: 0, testMinutes: 0 };
  for (const e of entries || []) {
    if (e.test) { t.testCount++; if (e.kind === 'overtime') t.testMinutes += e.minutes; }
    if (e.kind === 'overtime') {
      t.earned += e.minutes;
      if (!e.declared) { t.undeclared += e.minutes; t.undeclaredCount++; }
    } else if (e.kind === 'use') t.used += e.minutes;
    else if (e.kind === 'adjust') t.adjust += e.minutes;
  }
  t.balance = t.earned + t.adjust - t.used;
  return t;
}

export function undeclaredEntries(entries) {
  return (entries || []).filter(e => e.kind === 'overtime' && !e.declared).sort((a, b) => a.at - b.at);
}

// Lignes du mail au chef : les vraies heures supp à déclarer. Les lignes de
// test n'y vont jamais avec de vraies lignes ; seules, elles donnent un mail
// de test (objet « [TEST] »).
export function mailRows(entries) {
  const rows = undeclaredEntries(entries);
  const real = rows.filter(e => !e.test);
  return { rows: real.length ? real : rows, testOnly: !real.length && rows.length > 0, skippedTests: real.length ? rows.length - real.length : 0 };
}

/* ------------------------------- mail ------------------------------ */

export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Contenu du mail de déclaration pour les entrées données (déjà filtrées).
// includeSignature : ajoute le nom sous « Bonne journée » (Outlook n'ajoute
// pas la signature automatique à un brouillon ouvert depuis un .eml).
export function buildDeclaration(rows, s, { includeSignature = true } = {}) {
  rows = [...(rows || [])].sort((a, b) => a.at - b.at);
  if (!rows.length) return null;
  const total = rows.reduce((n, e) => n + e.minutes, 0);
  const hasTest = rows.some(e => e.test);
  const first = rows[0].at, last = rows[rows.length - 1].at;
  const period = sameDay(first, last) ? formatDate(first) : `du ${formatDate(first)} au ${formatDate(last)}`;
  const subject = `${hasTest ? '[TEST] ' : ''}Heures supplémentaires${s.senderName ? ' – ' + s.senderName : ''} – ${period}`;
  const hello = s.recipientName ? `Bonjour ${s.recipientName},` : 'Bonjour,';
  const intro = rows.length > 1
    ? 'Voici les heures supplémentaires que j’ai effectuées sur les tickets suivants :'
    : 'Voici les heures supplémentaires que j’ai effectuées sur le ticket suivant :';
  const signature = includeSignature && s.senderName ? s.senderName : '';
  const closing = signature ? 'Bonne journée,' : 'Bonne journée';
  const hasNotes = rows.some(e => e.note);

  const head = ['N° ticket', 'Client', 'Date', 'Heure', 'Temps supp'];
  if (hasNotes) head.push('Commentaire');
  const cells = rows.map(e => {
    const r = [(e.ticketId ? '#' + e.ticketId : '—') + (e.test ? ' (test)' : ''), e.org || '—', formatDate(e.at), formatTime(e.at), formatDuration(e.minutes)];
    if (hasNotes) r.push(e.note || '');
    return r;
  });

  const text = [
    hello, '',
    intro, '',
    head.join('\t'),
    ...cells.map(r => r.join('\t')),
    `Total : ${formatDuration(total)}`, '',
    closing,
    ...(signature ? [signature] : []),
  ].join('\n');

  const td = 'border:1px solid #9fb0c2;padding:4px 10px;vertical-align:top;';
  const th = td + 'background:#e7eef6;text-align:left;font-weight:bold;';
  const htmlRows = rows.map((e, i) => {
    const r = cells[i].map((c, j) => {
      const link = j === 0 && e.ticketId ? ticketUrl(e.origin || s.zendeskOrigin, e.ticketId) : '';
      if (link) return `<td style="${td}white-space:nowrap"><a href="${escapeHtml(link)}">#${e.ticketId}</a>${e.test ? ' (test)' : ''}</td>`;
      const right = j === 4 ? 'text-align:right;white-space:nowrap;' : (j === 2 || j === 3 ? 'white-space:nowrap;' : '');
      return `<td style="${td}${right}">${escapeHtml(c)}</td>`;
    });
    return `<tr>${r.join('')}</tr>`;
  });
  const span = 4;
  const totalRow = `<tr><td colspan="${span}" style="${th}text-align:right">Total</td>` +
    `<td style="${th}text-align:right;white-space:nowrap">${escapeHtml(formatDuration(total))}</td>` +
    (hasNotes ? `<td style="${th}"></td>` : '') + '</tr>';
  const html =
    '<div style="font-family:Aptos,Calibri,Arial,sans-serif;font-size:11pt;color:#000000">' +
    `<p style="margin:0 0 12px">${escapeHtml(hello)}</p>` +
    `<p style="margin:0 0 12px">${escapeHtml(intro)}</p>` +
    '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Aptos,Calibri,Arial,sans-serif;font-size:10.5pt">' +
    `<thead><tr>${head.map(c => `<th style="${th}">${escapeHtml(c)}</th>`).join('')}</tr></thead>` +
    `<tbody>${htmlRows.join('')}${totalRow}</tbody></table>` +
    `<p style="margin:16px 0 0">${escapeHtml(closing)}${signature ? '<br>' + escapeHtml(signature) : ''}</p>` +
    '</div>';

  return { subject, text, html, total, count: rows.length, hasTest, entryIds: rows.map(e => e.id) };
}

function utf8Base64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function wrap76(b64) {
  return b64.replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, '');
}

// En-tête RFC 2047 : mots encodés de 45 octets UTF-8 au plus (75 caractères).
export function encodeMimeHeader(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words = [];
  let chunk = '';
  for (const ch of value) {
    if (new TextEncoder().encode(chunk + ch).length > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => `=?UTF-8?B?${utf8Base64(w)}?=`).join('\r\n ');
}

// Brouillon .eml : « X-Unsent: 1 » fait ouvrir le fichier par Outlook comme un
// nouveau message prêt à envoyer (destinataire, objet et tableau remplis).
export function buildEml({ to, subject, text, html }, boundary = 'hs-' + uid()) {
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  return [
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8Base64(text.replace(/\r?\n/g, '\r\n'))),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8Base64(doc)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export function emlDataUrl(eml) {
  return 'data:message/rfc822;base64,' + utf8Base64(eml);
}

export function buildMailto({ to, subject, text }) {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.replace(/\r?\n/g, '\r\n'))}`;
}

export function mailFileName(now = Date.now()) {
  const d = new Date(now);
  return `Heures supp ${dateKey(now)} ${pad2(d.getHours())}h${pad2(d.getMinutes())}.eml`;
}

/* ------------------------------ exports ---------------------------- */

const KIND_LABELS = { overtime: 'Heures supp', use: 'Heures utilisées', adjust: 'Ajustement' };
export function kindLabel(kind) {
  return KIND_LABELS[kind] || kind;
}

function csvCell(v, { text = true } = {}) {
  let s = String(v ?? '');
  // Texte venu de Zendesk : Excel ne doit jamais l'évaluer comme une formule.
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV pour Excel (séparateur « ; », BOM UTF-8).
export function buildCsv(entries) {
  const head = ['Date', 'Heure', 'Type', 'Ticket', 'Client', 'Sujet', 'Durée (min)', 'Durée', 'Déclarée au chef', 'Commentaire', 'Test'];
  const lines = [...(entries || [])].sort((a, b) => a.at - b.at).map(e => {
    const signed = e.kind === 'use' ? -e.minutes : e.minutes;
    const cells = [formatDate(e.at), formatTime(e.at), kindLabel(e.kind), e.ticketId ? '#' + e.ticketId : '', e.org, e.subject,
      signed, formatDuration(signed).replace(/^-/, '−'), e.kind === 'overtime' ? (e.declared ? 'oui' : 'non') : '', e.note, e.test ? 'oui' : ''];
    return cells.map((c, i) => csvCell(c, { text: i !== 6 })).join(';');
  });
  return '﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
}
