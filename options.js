/* Page de réglages : horaires, mail, mode test, mises à jour, historique, sauvegarde. */
import {
  validateSlots, isValidEmail, isTestModeActive, formatDuration, formatDate, formatTime, kindLabel,
  computeTotals, buildCsv, DAY_NAMES, dateKey, ticketUrl, sameDay, GITHUB_PAGE,
} from './lib/core.js';
import { send, loadState, onStateChange, h, $, toast, durationInput, downloadText, applyLook, stagger, countTo, replay } from './lib/ui.js';

let state = null;
const form = $('#settings-form');
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

for (const d of DAY_ORDER) {
  $('#days').append(h('label', {}, h('input', { type: 'checkbox', name: 'day', value: d }), DAY_NAMES[d].slice(0, 3) + '.'));
}
$('#changes-link').href = GITHUB_PAGE + '/commits/main';

/* ------------------------------ réglages --------------------------- */

function fillForm(s) {
  const [a = { start: '', end: '' }, b = { start: '', end: '' }] = s.slots;
  form.elements.s1.value = a.start; form.elements.e1.value = a.end;
  form.elements.s2.value = b.start; form.elements.e2.value = b.end;
  form.querySelectorAll('input[name=day]').forEach(cb => { cb.checked = s.workDays.includes(Number(cb.value)); });
  form.elements.holidaysOff.checked = s.holidaysOff;
  form.elements.clipToOutOfHours.checked = s.clipToOutOfHours;
  form.elements.animations.checked = s.animations;
  form.elements.recipientEmail.value = s.recipientEmail;
  form.elements.recipientName.value = s.recipientName;
  form.elements.senderName.value = s.senderName;
  form.elements.mailMethod.value = s.mailMethod;
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const el = form.elements;
  const slots = [{ start: el.s1.value, end: el.e1.value }];
  if (el.s2.value || el.e2.value) slots.push({ start: el.s2.value, end: el.e2.value });
  const email = el.recipientEmail.value.trim();
  const err = validateSlots(slots) || (email && !isValidEmail(email) ? 'Adresse mail du destinataire invalide.' : null);
  $('#settings-error').textContent = err || '';
  if (err) { replay($('#save'), 'shake'); return; }
  const workDays = [...form.querySelectorAll('input[name=day]:checked')].map(cb => Number(cb.value));
  try {
    await send('saveSettings', { patch: {
      slots, workDays,
      holidaysOff: el.holidaysOff.checked,
      clipToOutOfHours: el.clipToOutOfHours.checked,
      animations: el.animations.checked,
      recipientEmail: email,
      recipientName: el.recipientName.value,
      senderName: el.senderName.value,
      mailMethod: el.mailMethod.value,
    } });
    const btn = $('#save');
    btn.classList.add('saved');
    btn.querySelector('span').textContent = 'Enregistré';
    setTimeout(() => { btn.classList.remove('saved'); btn.querySelector('span').textContent = 'Enregistrer'; }, 1800);
    if (!workDays.length) toast('Aucun jour travaillé : toute résolution sera proposée.', 'info');
  } catch (e) { toast(e.message, 'error'); }
});

/* ------------------------------ mode test -------------------------- */

function renderTest(s) {
  const on = isTestModeActive(s);
  const st = $('#test-status');
  st.className = 'status' + (on ? ' on' : '');
  st.textContent = on
    ? `Actif jusqu’au ${formatDate(s.testModeUntil)} à ${formatTime(s.testModeUntil)}.`
    : 'Désactivé : seules les résolutions hors horaires ouvrent la fenêtre.';
  $('#test-off').disabled = !on;
}

$('#test-on').addEventListener('click', () => {
  const d = new Date();
  const until = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime();
  send('saveSettings', { patch: { testModeUntil: until } }).then(() => toast('Mode test actif jusqu’à 23:59.', 'success'), e => toast(e.message, 'error'));
});
$('#test-off').addEventListener('click', () => {
  send('saveSettings', { patch: { testModeUntil: 0 } }).then(() => toast('Mode test désactivé.', 'success'), e => toast(e.message, 'error'));
});
$('#preview').addEventListener('click', () => send('previewPrompt').catch(e => toast(e.message, 'error')));

/* ---------------------------- mises à jour ------------------------- */

function renderUpdate() {
  const up = state.update;
  const current = chrome.runtime.getManifest().version;
  $('#v-current').textContent = current;
  $('#v-latest').textContent = up && up.latest ? up.latest : '—';
  $('#v-checked').textContent = up && up.checkedAt
    ? (sameDay(up.checkedAt, Date.now()) ? `aujourd’hui à ${formatTime(up.checkedAt)}` : `${formatDate(up.checkedAt)} à ${formatTime(up.checkedAt)}`)
    : 'jamais';
  const status = $('#update-status');
  if (up && up.available) {
    status.className = 'status warn';
    status.textContent = `La version ${up.latest} est disponible.`;
  } else if (up && up.error) {
    status.className = 'status';
    status.textContent = `Vérification impossible (${up.error}).`;
  } else {
    status.className = 'status ok';
    status.textContent = up ? 'Vous avez la dernière version.' : '';
  }
  $('#update-steps').classList.toggle('hidden', !(up && up.available));
  $('#install-dir-wrap').classList.toggle('hidden', !state.installDir);
  $('#install-dir').textContent = state.installDir;
}

$('#check-update').addEventListener('click', async () => {
  const btn = $('#check-update');
  btn.disabled = true;
  btn.textContent = 'Vérification…';
  try {
    const r = await send('checkUpdate');
    toast(r.update.available ? `Version ${r.update.latest} disponible.` : (r.update.error ? 'GitHub injoignable.' : 'Vous avez la dernière version.'), r.update.error ? 'error' : 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Vérifier maintenant'; }
});

$('#copy-dir').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.installDir); toast('Chemin copié.', 'success'); }
  catch (e) { toast('Copie impossible.', 'error'); }
});

/* ------------------------------ historique ------------------------- */

function renderHistory() {
  const t = computeTotals(state.entries);
  countTo($('#stat-balance'), t.balance, formatDuration);
  countTo($('#stat-undeclared'), t.undeclared, formatDuration);
  $('#summary').textContent = `${state.entries.length} mouvement(s)`;
  const body = $('#history-body');
  body.replaceChildren();
  const rows = [...state.entries].sort((a, b) => b.at - a.at);
  if (!rows.length) body.append(h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'Aucun mouvement.')));
  rows.forEach((e, i) => {
    const neg = e.kind === 'use' || (e.kind === 'adjust' && e.minutes < 0);
    const detail = [];
    const url = e.ticketId ? ticketUrl(e.origin || state.settings.zendeskOrigin, e.ticketId) : '';
    if (e.ticketId) detail.push(url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, '#' + e.ticketId) : '#' + e.ticketId);
    const text = [e.org, e.subject, e.note].filter(Boolean).join(' · ');
    if (text) detail.push(' ' + text);
    if (e.test) detail.push(' ', h('span', { class: 'tag test' }, 'Test'));
    const del = h('button', { class: 'icon-btn', type: 'button', title: 'Supprimer', 'aria-label': 'Supprimer' }, '✕');
    del.addEventListener('click', async () => {
      if (!confirm(`Supprimer cette ligne (${formatDuration(e.minutes)}) ?`)) return;
      try { await send('deleteEntry', { id: e.id }); } catch (err) { toast(err.message, 'error'); }
    });
    body.append(h('tr', { style: `--i:${i}` },
      h('td', { class: 'date' }, `${formatDate(e.at)} ${formatTime(e.at)}`),
      h('td', {}, kindLabel(e.kind)),
      h('td', {}, detail),
      h('td', { class: 'num ' + (neg ? 'neg' : 'pos') }, (neg ? '−' : '+') + formatDuration(Math.abs(e.minutes))),
      h('td', {}, e.kind === 'overtime' ? (e.declared ? `déclarée le ${formatDate(e.declaredAt || e.at)}` : 'à déclarer') : ''),
      h('td', {}, del)));
  });

  const mails = $('#mails');
  mails.replaceChildren();
  if (!state.mails.length) mails.append(h('li', { class: 'empty' }, 'Aucune déclaration pour l’instant.'));
  for (const m of [...state.mails].sort((a, b) => b.at - a.at)) {
    const undo = h('button', { class: 'link small', type: 'button' }, 'Annuler');
    undo.addEventListener('click', async () => {
      if (!confirm('Remettre ces lignes « à déclarer » ?')) return;
      try { await send('undoDeclaration', { mailId: m.id }); toast('Déclaration annulée.', 'success'); } catch (err) { toast(err.message, 'error'); }
    });
    mails.append(h('li', {},
      h('div', { class: 'main' }, h('div', { class: 'title-line' }, `${formatDate(m.at)} à ${formatTime(m.at)}`),
        h('div', { class: 'sub' }, `${m.count} ligne(s)`)),
      h('span', { class: 'amount' }, formatDuration(m.total)), undo));
  }
}

const adjForm = $('#adjust-form');
// Report d'un solde existant : jusqu'à 1 600 h (et non 24 h comme une saisie ordinaire).
const adjDur = durationInput({ value: 60, label: 'Durée', idPrefix: 'adj', maxMinutes: 100000 });
adjForm.querySelector('[data-slot="duration"]').append(adjDur.root);
$('#adjust-toggle').addEventListener('click', () => adjForm.classList.toggle('hidden'));
adjForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!adjDur.valid()) { replay(adjDur.root, 'shake'); return toast(adjDur.get() > 0 ? 'Durée trop grande.' : 'Indiquez une durée.', 'error'); }
  const minutes = adjDur.get() * Number(adjForm.elements.sign.value);
  try {
    await send('addEntry', { entry: { kind: 'adjust', minutes, at: Date.now(), note: adjForm.elements.note.value || 'Ajustement' } });
    adjForm.reset(); adjDur.set(60); adjForm.classList.add('hidden');
    toast(`Solde ajusté de ${minutes > 0 ? '+' : ''}${formatDuration(minutes)}.`, 'success');
  } catch (e) { toast(e.message, 'error'); }
});

$('#export-csv').addEventListener('click', () => {
  downloadText(`Heures supp ${dateKey(Date.now())}.csv`, buildCsv(state.entries), 'text/csv;charset=utf-8');
});

$('#backup').addEventListener('click', () => {
  const data = { format: 'heures-supp-zendesk', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, entries: state.entries, mails: state.mails };
  downloadText(`Heures supp sauvegarde ${dateKey(Date.now())}.json`, JSON.stringify(data, null, 2), 'application/json');
});

// Restauration en trois choix explicites : fusionner, remplacer, abandonner.
let restoreData = null;
$('#restore').addEventListener('click', () => $('#restore-file').click());
$('#restore-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.format !== 'heures-supp-zendesk' || !Array.isArray(data.entries)) throw new Error('fichier non reconnu');
    restoreData = data;
    $('#restore-name').textContent = file.name;
    $('#restore-info').textContent = `${data.entries.length} ligne(s), sauvegardée le ${data.exportedAt ? formatDate(Date.parse(data.exportedAt)) : '?'}.`;
    $('#restore-choice').classList.remove('hidden');
  } catch (e) { toast('Restauration impossible : ' + e.message, 'error'); }
});
async function restore(mode) {
  if (!restoreData) return;
  if (mode === 'replace' && !confirm('Remplacer tout l’historique actuel par cette sauvegarde ?')) return;
  try {
    const r = await send('importData', { data: restoreData, mode });
    toast(`${r.imported} ligne(s) ajoutée(s)${r.already ? `, ${r.already} déjà présente(s)` : ''}${r.rejected ? `, ${r.rejected} ignorée(s)` : ''}.`, 'success');
  } catch (e) { toast('Restauration impossible : ' + e.message, 'error'); }
  restoreData = null;
  $('#restore-choice').classList.add('hidden');
}
$('#restore-merge').addEventListener('click', () => restore('merge'));
$('#restore-replace').addEventListener('click', () => restore('replace'));
$('#restore-cancel').addEventListener('click', () => { restoreData = null; $('#restore-choice').classList.add('hidden'); });

$('#reset').addEventListener('click', async () => {
  if (!confirm('Effacer tout l’historique des heures supp (réglages conservés) ?\nPensez à « Sauvegarder » avant.')) return;
  try { await send('resetAll'); toast('Historique effacé.', 'success'); } catch (e) { toast(e.message, 'error'); }
});

/* ------------------------------ démarrage -------------------------- */

// Le formulaire n'est rechargé que s'il n'a pas de modification en cours.
let formFilled = false;
let formDirty = false;
form.addEventListener('input', () => { formDirty = true; });
form.addEventListener('change', () => { formDirty = true; });
form.addEventListener('submit', () => { formDirty = false; });
async function reload(changes) {
  state = await loadState();
  applyLook(state.settings);
  if (!formFilled || (changes && changes.settings && !formDirty)) {
    fillForm(state.settings);
    formFilled = true;
  }
  renderTest(state.settings);
  renderUpdate();
  renderHistory();
}
stagger();
onStateChange(reload);
reload().then(() => {
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
send('checkDisk').catch(() => {});
