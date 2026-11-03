/* ------------------------------------------------------------------
   Heures supp Zendesk — service worker (MV3)

   Seul endroit qui écrit dans le stockage : les pages et le script de
   contenu envoient des messages, traités ici les uns après les autres
   (pas d'écritures concurrentes).

   Stockage (chrome.storage.local) :
     settings  réglages (horaires, destinataire, mode test…)
     entries   mouvements : heures supp (overtime), heures utilisées (use),
               ajustements du solde (adjust)
     pending   résolutions hors horaires en attente de réponse
     mails     déclarations envoyées au chef (historique)
     lastMail  dernier mail préparé, en attente de confirmation d'envoi
     update    dernière vérification de version sur GitHub
     seed      empreinte du config.local.json déjà appliqué
   ------------------------------------------------------------------ */
import {
  normalizeSettings, classifyTime, computeSuggestion, describeReason, computeTotals, formatBadge,
  formatDuration, formatTime, isTestModeActive, sanitizeEntry, uid, isZendeskOrigin, compareVersions,
  outOfHoursPeriodStart, MAX_REF_AGE_MS, REMOTE_MANIFEST_URL,
} from './lib/core.js';

const ZENDESK_AGENT = 'https://*.zendesk.com/agent*';
const PROMPT_PAGE = 'prompt.html';
const PROMPT_SIZE = { width: 480, height: 760 };
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const UPDATE_ALARM = 'verifier-github';
const UPDATE_PERIOD_MIN = 6 * 60;
const DISK_ALARM = 'verifier-fichiers';
const DISK_PERIOD_MIN = 5;
const NOTIF_UPDATE = 'maj-disponible';

/* ------------------------------ stockage --------------------------- */

let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function readState() {
  const raw = await chrome.storage.local.get(['settings', 'entries', 'pending', 'mails', 'lastMail']);
  return {
    settings: normalizeSettings(raw.settings),
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    pending: Array.isArray(raw.pending) ? raw.pending : [],
    mails: Array.isArray(raw.mails) ? raw.mails : [],
    lastMail: raw.lastMail && typeof raw.lastMail === 'object' ? raw.lastMail : null,
  };
}

// Lit l'état, applique `fn` (qui modifie l'objet), puis enregistre le tout.
function mutate(fn) {
  return serialize(async () => {
    const st = await readState();
    const result = await fn(st);
    await chrome.storage.local.set({
      settings: st.settings, entries: st.entries, pending: st.pending, mails: st.mails, lastMail: st.lastMail,
    });
    return result || {};
  });
}

/* ----------------------- configuration locale ---------------------- */

// config.local.json (facultatif, jamais publié) : préremplit les réglages
// propres au poste — destinataire, prénom, nom, mode test… Il n'est appliqué
// qu'à l'installation ou quand son contenu change.
async function readLocalConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL('config.local.json'), { cache: 'no-store' });
    if (!res.ok) return null;
    const text = (await res.text()).replace(/^﻿/, '');   // fichier enregistré avec BOM
    return { text, data: JSON.parse(text) };
  } catch (e) {
    return null;
  }
}

async function applyLocalConfig() {
  const cfg = await readLocalConfig();
  if (!cfg || !cfg.data || typeof cfg.data !== 'object') return;
  const { seed } = await chrome.storage.local.get('seed');
  if (seed === cfg.text) return;
  const d = cfg.data;
  await mutate(st => {
    const patch = {};
    for (const k of ['recipientEmail', 'recipientName', 'senderName', 'mailMethod', 'slots', 'workDays', 'holidaysOff', 'clipToOutOfHours', 'zendeskOrigin']) {
      if (k in d) patch[k] = d[k];
    }
    if (typeof d.testModeUntil === 'string') {
      const t = Date.parse(d.testModeUntil);       // « 2026-11-02T23:59:59 » = heure locale
      if (Number.isFinite(t) && t > Date.now()) patch.testModeUntil = t;
    }
    st.settings = normalizeSettings({ ...st.settings, ...patch });
  });
  await chrome.storage.local.set({ seed: cfg.text, installDir: typeof d.installDir === 'string' ? d.installDir.slice(0, 260) : '' });
}

/* ------------------------------- badge ----------------------------- */

async function refreshBadge() {
  const st = await readState();
  const t = computeTotals(st.entries);
  let text = '', color = '#1f73b7', title;
  if (st.pending.length) {
    text = String(st.pending.length);
    color = '#d9480f';
    title = `${st.pending.length} résolution(s) hors horaires à confirmer`;
  } else if (t.undeclared > 0) {
    text = formatBadge(t.undeclared);
    title = `Non déclarées au chef : ${formatDuration(t.undeclared)} · Solde : ${formatDuration(t.balance)}`;
  } else {
    title = `Solde d’heures supp : ${formatDuration(t.balance)}`;
  }
  if (isTestModeActive(st.settings)) title += ` · MODE TEST jusqu’à ${formatTime(st.settings.testModeUntil)}`;
  const { update } = await chrome.storage.local.get('update');
  if (update && update.available) title += ` · Mise à jour ${update.latest} disponible`;
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title: 'Heures supp — ' + title });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.entries || changes.pending || changes.settings || changes.update)) refreshBadge().catch(() => {});
});

/* ------------------------- fenêtre de question --------------------- */

async function promptWindowOpen() {
  const { promptWindowId } = await chrome.storage.session.get('promptWindowId');
  if (!Number.isInteger(promptWindowId)) return null;
  try { await chrome.windows.get(promptWindowId); return promptWindowId; } catch (e) { return null; }
}

// Ouvre (ou ramène au premier plan) la fenêtre de question, sur la question
// `focusId` si elle est donnée. Les appels sont sérialisés : deux résolutions
// quasi simultanées n'ouvrent qu'une seule fenêtre.
let opening = Promise.resolve();
function openPromptWindow(opts = {}) {
  const run = opening.then(() => doOpenPromptWindow(opts), () => doOpenPromptWindow(opts));
  opening = run.catch(() => {});
  return run;
}

async function doOpenPromptWindow({ preview = false, focusId = null } = {}) {
  const url = chrome.runtime.getURL(preview ? `${PROMPT_PAGE}?apercu=1` : PROMPT_PAGE);
  if (!preview) {
    if (focusId) await chrome.storage.session.set({ promptFocus: { id: focusId, at: Date.now() } });
    const id = await promptWindowOpen();
    if (id !== null) {
      try {
        await chrome.windows.update(id, { focused: true, drawAttention: true });
        return;
      } catch (e) { /* fenêtre fermée entre-temps */ }
    }
  }
  const opts = { url, type: 'popup', width: PROMPT_SIZE.width, height: PROMPT_SIZE.height, focused: true };
  try {
    const w = await chrome.windows.getLastFocused();
    // Centrée sur la fenêtre active, y compris sur un second écran (coordonnées négatives).
    if (w && Number.isFinite(w.left) && Number.isFinite(w.width)) {
      opts.left = Math.round(w.left + (w.width - PROMPT_SIZE.width) / 2);
      opts.top = Math.round(w.top + Math.max(0, (w.height - PROMPT_SIZE.height) / 2));
    }
  } catch (e) { /* pas de fenêtre de référence : position par défaut */ }
  let win;
  try { win = await chrome.windows.create(opts); }
  catch (e) { delete opts.left; delete opts.top; win = await chrome.windows.create(opts); }
  if (!preview) await chrome.storage.session.set({ promptWindowId: win.id });
}

chrome.windows.onRemoved.addListener(async (id) => {
  const { promptWindowId } = await chrome.storage.session.get('promptWindowId');
  if (id === promptWindowId) await chrome.storage.session.remove('promptWindowId');
});

/* ------------------------- résolution détectée --------------------- */

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function handleSolved(data) {
  const ticketId = String(data && data.ticketId || '').trim();
  const newTicket = !ticketId && !!(data && data.newTicket);   // ticket créé et résolu d'un coup, n° inconnu
  if (!newTicket && !/^\d{1,12}$/.test(ticketId)) throw new Error('Numéro de ticket invalide');
  const resolvedAt = num(data.resolvedAt) || Date.now();
  const info = {
    ticketId,
    newTicket,
    origin: isZendeskOrigin(data.origin) ? data.origin : '',
    subject: cleanText(data.subject, 200),
    org: cleanText(data.org, 160),
    requester: cleanText(data.requester, 160),
    lastCallAt: num(data.lastCallAt),
    lastCallLabel: cleanText(data.lastCallLabel, 120),
    shownSince: num(data.shownSince),
    resolvedAt,
    confirmedBy: cleanText(data.confirmedBy, 40),
  };

  const res = await mutate(st => {
    const s = st.settings;
    if (info.origin && s.zendeskOrigin !== info.origin) s.zendeskOrigin = info.origin;
    const cls = classifyTime(resolvedAt, s);
    if (!cls.outOfHours) return { ignored: 'pendant les horaires' };

    // Même résolution signalée deux fois (double clic, page dupliquée…).
    const sameTicket = x => ticketId ? x.ticketId === ticketId : (x.newTicket && x.subject === info.subject);
    const twin = st.entries.find(e => e.source === 'auto' && sameTicket(e) && Math.abs((e.resolvedAt || e.at) - resolvedAt) < DUPLICATE_WINDOW_MS);
    if (twin) return { ignored: 'déjà enregistré' };

    // Même résolution déjà en attente (double signalement) : on garde la première.
    const dup = ticketId ? st.pending.find(p => p.ticketId === ticketId && Math.abs(p.resolvedAt - resolvedAt) < DUPLICATE_WINDOW_MS) : null;
    if (dup) return { pendingId: dup.id, duplicate: true };

    // Une même plage hors horaires n'est proposée qu'une fois : on démarre au
    // plus tôt à la dernière résolution déjà enregistrée ou en attente. En mode
    // test (pendant les horaires), la « plage » est la journée.
    const periodStart = cls.reason === 'test'
      ? new Date(new Date(resolvedAt).setHours(0, 0, 0, 0)).getTime()
      : outOfHoursPeriodStart(resolvedAt, s);
    const existing = ticketId ? st.pending.find(p => p.ticketId === ticketId && p.resolvedAt >= periodStart) : null;
    let notBefore = null;
    for (const x of [...st.entries.filter(e => e.source === 'auto'), ...st.pending]) {
      if (x === existing) continue;
      const t = x.resolvedAt || x.at;
      if (t < resolvedAt && resolvedAt - t <= MAX_REF_AGE_MS && (notBefore === null || t > notBefore)) notBefore = t;
    }

    const sug = computeSuggestion({ ...info, notBefore }, s);
    const item = {
      ...info,
      reason: cls.reason,
      reasonText: describeReason(cls, resolvedAt, s),
      refAt: sug.refAt,
      refSource: sug.refSource,
      fullGapMin: sug.fullGapMin,
      suggestedMin: sug.suggestedMin,
      periodStart: sug.periodStart,
      startAt: sug.start,
      boundBy: sug.boundBy,
      clipped: sug.clipped,
      test: cls.reason === 'test',
      createdAt: Date.now(),
    };
    // Une question par ticket et par plage hors horaires. Même résolution
    // signalée deux fois : on garde la première. Ticket rouvert puis re-résolu
    // dans la même plage : la nouvelle résolution remplace l'ancienne, sans
    // perdre les informations déjà connues. Autre plage (autre soir) : nouvelle question.
    if (existing) {
      for (const k of ['origin', 'subject', 'org', 'requester']) if (!item[k]) item[k] = existing[k];
      Object.assign(existing, item);
      return { pendingId: existing.id, replaced: true };
    }
    item.id = uid();
    st.pending.push(item);
    return { pendingId: item.id };
  });

  if (res.pendingId) await openPromptWindow({ focusId: res.pendingId });
  return res;
}

// Retire des déclarations et du mail en préparation les lignes supprimées.
function pruneMails(st) {
  const known = new Set(st.entries.map(e => e.id));
  st.mails = st.mails
    .map(m => {
      const ids = (m.entryIds || []).filter(id => known.has(id));
      const rows = st.entries.filter(e => ids.includes(e.id));
      return { ...m, entryIds: ids, count: rows.length, total: rows.reduce((n, e) => n + e.minutes, 0) };
    })
    .filter(m => m.entryIds.length);
  if (st.lastMail) {
    st.lastMail.entryIds = st.lastMail.entryIds.filter(id => known.has(id));
    if (!st.lastMail.entryIds.length) st.lastMail = null;
    else st.lastMail.total = st.entries.filter(e => st.lastMail.entryIds.includes(e.id)).reduce((n, e) => n + e.minutes, 0);
  }
}

/* --------------------------- mises à jour -------------------------- */

// Vérifie la version publiée sur GitHub et prévient l'utilisateur. Rien
// n'est téléchargé ni installé automatiquement.
async function checkGithub({ notify = true } = {}) {
  const current = chrome.runtime.getManifest().version;
  const { update: prev } = await chrome.storage.local.get('update');
  const info = { current, checkedAt: Date.now(), latest: prev && prev.latest || null, available: false, error: '' };
  try {
    const res = await fetch(REMOTE_MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('GitHub a répondu ' + res.status);
    const remote = await res.json();
    if (typeof remote.version !== 'string') throw new Error('version introuvable');
    info.latest = remote.version;
    info.available = compareVersions(remote.version, current) > 0;
  } catch (e) {
    info.error = String(e && e.message || e);
  }
  info.notifiedVersion = prev && prev.notifiedVersion || null;
  if (notify && info.available && info.notifiedVersion !== info.latest && chrome.notifications) {
    try {
      await chrome.notifications.create(NOTIF_UPDATE, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Heures supp : mise à jour disponible',
        message: `La version ${info.latest} est disponible (vous avez la ${current}). Cliquez pour voir comment l’installer.`,
        priority: 1,
      });
      info.notifiedVersion = info.latest;
    } catch (e) { /* notifications bloquées : le bandeau du popup suffit */ }
  }
  await chrome.storage.local.set({ update: info });
  return info;
}

// Fichiers remplacés sur le disque (« Mettre-a-jour.bat ») : on recharge
// l'extension pour appliquer la nouvelle version, sauf si une question est
// affichée (on réessaiera au prochain passage).
async function checkDisk() {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const disk = await res.json();
    const running = chrome.runtime.getManifest().version;
    if (compareVersions(disk.version, running) <= 0) return { reload: false, running, disk: disk.version };
    if (await promptWindowOpen() !== null) return { reload: false, waiting: true, running, disk: disk.version };
    setTimeout(() => chrome.runtime.reload(), 300);
    return { reload: true, running, disk: disk.version };
  } catch (e) {
    return { reload: false, error: String(e && e.message || e) };
  }
}

function scheduleAlarms() {
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: UPDATE_PERIOD_MIN });
  chrome.alarms.create(DISK_ALARM, { delayInMinutes: DISK_PERIOD_MIN, periodInMinutes: DISK_PERIOD_MIN });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkGithub().catch(() => {});
  else if (alarm.name === DISK_ALARM) checkDisk().catch(() => {});
});

if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((id) => {
    if (id !== NOTIF_UPDATE) return;
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html#mise-a-jour') });
    chrome.notifications.clear(id);
  });
}

/* ----------------------------- messages ---------------------------- */

function requireEntry(raw) {
  const e = sanitizeEntry(raw);
  if (!e) throw new Error('Entrée invalide (durée ou date incorrecte).');
  return e;
}

const handlers = {
  async ticketSolved(msg) {
    return handleSolved(msg.data || {});
  },

  async answerPending({ pendingId, minutes, note }) {
    return mutate(st => {
      const i = st.pending.findIndex(p => p.id === pendingId);
      if (i < 0) return { gone: true };
      const p = st.pending[i];
      const m = Math.round(Number(minutes));
      if (!Number.isFinite(m) || m <= 0 || m > 24 * 60) throw new Error('Durée invalide (entre 1 min et 24 h).');
      const entry = requireEntry({
        kind: 'overtime', minutes: m, at: p.resolvedAt, ticketId: p.ticketId, subject: p.subject, origin: p.origin,
        org: p.org, requester: p.requester, note, source: 'auto', test: p.test, createdAt: Date.now(),
      });
      entry.resolvedAt = p.resolvedAt;
      entry.suggestedMin = p.suggestedMin;
      if (p.newTicket) entry.newTicket = true;
      st.entries.push(entry);
      st.pending.splice(i, 1);
      return { entryId: entry.id };
    });
  },

  async dismissPending({ pendingId }) {
    return mutate(st => {
      st.pending = st.pending.filter(p => p.id !== pendingId);
    });
  },

  async addEntry({ entry }) {
    return mutate(st => {
      const e = requireEntry({ ...entry, id: undefined, origin: st.settings.zendeskOrigin, source: 'manuel', declared: false, createdAt: Date.now() });
      st.entries.push(e);
      return { entryId: e.id };
    });
  },

  async updateEntry({ id, patch }) {
    return mutate(st => {
      const i = st.entries.findIndex(e => e.id === id);
      if (i < 0) throw new Error('Entrée introuvable.');
      const old = st.entries[i];
      const allowed = {};
      for (const k of ['minutes', 'at', 'note', 'ticketId', 'org']) if (patch && k in patch) allowed[k] = patch[k];
      const next = requireEntry({ ...old, ...allowed });
      st.entries[i] = { ...old, ...next };
    });
  },

  async deleteEntry({ id }) {
    return mutate(st => {
      st.entries = st.entries.filter(e => e.id !== id);
      pruneMails(st);
    });
  },

  async deleteTestEntries() {
    return mutate(st => {
      const before = st.entries.length;
      st.entries = st.entries.filter(e => !e.test);
      st.pending = st.pending.filter(p => !p.test);
      pruneMails(st);
      return { removed: before - st.entries.length };
    });
  },

  async mailPrepared({ entryIds, total, method, downloadId }) {
    return mutate(st => {
      const ids = (entryIds || []).filter(id => st.entries.some(e => e.id === id));
      st.lastMail = { id: uid(), at: Date.now(), entryIds: ids, total: Number(total) || 0, method, downloadId: Number.isInteger(downloadId) ? downloadId : null };
      return { mailId: st.lastMail.id };
    });
  },

  async forgetMail() {
    return mutate(st => { st.lastMail = null; });
  },

  async markDeclared({ entryIds }) {
    return mutate(st => {
      const ids = new Set(entryIds || (st.lastMail ? st.lastMail.entryIds : []));
      const at = Date.now();
      let total = 0, count = 0;
      for (const e of st.entries) {
        if (ids.has(e.id) && e.kind === 'overtime' && !e.declared) {
          e.declared = true; e.declaredAt = at; total += e.minutes; count++;
        }
      }
      if (count) st.mails.push({ id: uid(), at, entryIds: [...ids], total, count });
      st.lastMail = null;
      return { count, total };
    });
  },

  async undoDeclaration({ mailId }) {
    return mutate(st => {
      const mail = st.mails.find(m => m.id === mailId);
      if (!mail) throw new Error('Déclaration introuvable.');
      const ids = new Set(mail.entryIds);
      for (const e of st.entries) if (ids.has(e.id)) { e.declared = false; e.declaredAt = null; }
      st.mails = st.mails.filter(m => m.id !== mailId);
    });
  },

  async saveSettings({ patch }) {
    return mutate(st => {
      st.settings = normalizeSettings({ ...st.settings, ...(patch || {}) });
      return { settings: st.settings };
    });
  },

  async openPrompt() {
    await openPromptWindow();
  },

  async previewPrompt() {
    await openPromptWindow({ preview: true });
  },

  async checkUpdate() {
    return { update: await checkGithub({ notify: false }) };
  },

  async checkDisk() {
    return checkDisk();
  },

  async importData({ data, mode }) {
    if (!data || data.format !== 'heures-supp-zendesk' || !Array.isArray(data.entries)) {
      throw new Error('Fichier de sauvegarde non reconnu.');
    }
    const entries = data.entries.map(sanitizeEntry).filter(Boolean);
    return mutate(st => {
      let added = 0;
      if (mode === 'replace') {
        st.entries = entries;
        st.mails = Array.isArray(data.mails) ? data.mails.filter(m => m && typeof m.id === 'string' && Array.isArray(m.entryIds)) : [];
        st.lastMail = null;
        if (data.settings) st.settings = normalizeSettings({ ...data.settings, zendeskOrigin: data.settings.zendeskOrigin || st.settings.zendeskOrigin });
        added = entries.length;
      } else {
        const known = new Set(st.entries.map(e => e.id));
        for (const e of entries) if (!known.has(e.id)) { st.entries.push(e); added++; }
      }
      pruneMails(st);
      return { imported: added, rejected: data.entries.length - entries.length, already: mode === 'replace' ? 0 : entries.length - added };
    });
  },

  async resetAll() {
    return mutate(st => {
      st.entries = []; st.pending = []; st.mails = []; st.lastMail = null;
    });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string' || !handlers[msg.type]) return false;
  // Le script de contenu ne peut que signaler une résolution.
  if (sender.tab && !String(sender.url || '').startsWith(chrome.runtime.getURL('')) && msg.type !== 'ticketSolved') return false;
  handlers[msg.type](msg).then(
    r => sendResponse({ ok: true, ...(r || {}) }),
    err => sendResponse({ ok: false, error: String((err && err.message) || err) }),
  );
  return true;
});

/* ----------------------------- démarrage --------------------------- */

// Après installation ou mise à jour, le script de contenu n'est pas présent
// dans les onglets Zendesk déjà ouverts : on l'y injecte.
async function injectIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ZENDESK_AGENT });
    for (const tab of tabs) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch (e) { /* onglet non prêt */ }
    }
  } catch (e) { /* rien à faire */ }
}

chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  await applyLocalConfig();
  if (reason === 'update' && previousVersion && previousVersion !== chrome.runtime.getManifest().version) {
    await chrome.storage.local.set({ justUpdated: { from: previousVersion, to: chrome.runtime.getManifest().version, at: Date.now() } });
  }
  scheduleAlarms();
  await injectIntoOpenTabs();
  await refreshBadge();
  checkGithub().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms();
  applyLocalConfig().then(refreshBadge).catch(() => {});
});

// Extension désactivée puis réactivée (ou rechargée) : onInstalled ne se
// déclenche pas toujours ; on réinjecte une fois par session du service
// worker (storage.session est vidé à chaque désactivation).
chrome.storage.session.get('injected').then(({ injected }) => {
  if (injected) return;
  chrome.storage.session.set({ injected: true });
  injectIntoOpenTabs();
}).catch(() => {});

refreshBadge().catch(() => {});
