/* Popup de l'icône : compteurs, mail au chef, saisie et historique. */
import {
  computeTotals, undeclaredEntries, mailRows, buildDeclaration, buildEml, emlDataUrl, buildMailto, mailFileName,
  formatDuration, formatDate, formatDateShort, formatTime, sameDay, isTestModeActive, kindLabel,
} from './lib/core.js';
import {
  send, loadState, onStateChange, h, $, toast, durationInput, toLocalInput, fromLocalInput,
  applyLook, stagger, countTo, replay,
} from './lib/ui.js';

let state = null;
let editingId = null;
let firstRender = true;
let mailBusy = false;   // préparation du mail en cours : pas de second brouillon
const MAILTO_MAX = 1900; // Windows n'ouvre pas les liens externes de plus de 2 048 caractères

const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8L4 17.2zm15.7-9.5a1 1 0 0 0 0-1.4l-2-2a1 1 0 0 0-1.4 0l-1.6 1.6 2.8 2.8 2.2-1z"/></svg>';
const ICON_DEL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h2v-8h-2zm4 0v8h2v-8h-2z"/></svg>';

function iconButton(svg, label, onclick) {
  const b = h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick });
  b.innerHTML = svg; // icône statique
  return b;
}

function whenShort(ts) {
  return sameDay(ts, Date.now()) ? `aujourd’hui à ${formatTime(ts)}` : `${formatDateShort(ts)} à ${formatTime(ts)}`;
}

function plural(n, one, many) {
  return `${n} ${n > 1 ? many : one}`;
}

function greeting() {
  const hr = new Date().getHours();
  if (hr < 5) return 'Bonne nuit !';
  if (hr < 12) return 'Bonne journée !';
  if (hr < 18) return 'Bon après-midi !';
  return 'Bonne soirée !';
}

/* ------------------------------ rendu ------------------------------ */

function render() {
  const st = state;
  const s = st.settings;
  applyLook(s);
  const t = computeTotals(st.entries);
  const rows = undeclaredEntries(st.entries);

  $('#hero-sub').textContent = st.pending.length ? `${plural(st.pending.length, 'ticket', 'tickets')} à confirmer` : greeting();

  const up = st.update;
  $('#update-banner').classList.toggle('hidden', !(up && up.available));
  if (up && up.available) {
    $('#update-latest').textContent = up.latest;
    $('#update-current').textContent = chrome.runtime.getManifest().version;
  }
  const ju = st.justUpdated;
  $('#updated-banner').classList.toggle('hidden', !ju);
  if (ju) $('#updated-to').textContent = ju.to;

  const testOn = isTestModeActive(s);
  $('#test-banner').classList.toggle('hidden', !testOn);
  if (testOn) $('#test-until').textContent = sameDay(s.testModeUntil, Date.now()) ? formatTime(s.testModeUntil) : `${formatDate(s.testModeUntil)} ${formatTime(s.testModeUntil)}`;

  $('#pending-banner').classList.toggle('hidden', !st.pending.length);
  $('#pending-text').textContent = plural(st.pending.length, 'ticket à confirmer', 'tickets à confirmer');

  countTo($('#undeclared'), t.undeclared, formatDuration);
  $('#undeclared-sub').textContent = t.undeclaredCount
    ? plural(t.undeclaredCount, 'entrée', 'entrées') + (t.testMinutes ? ` (dont ${formatDuration(t.testMinutes)} de test)` : '')
    : 'Rien à déclarer';
  countTo($('#balance'), t.balance, formatDuration);
  $('#balance-sub').textContent = `Fait : ${formatDuration(t.earned + Math.max(0, t.adjust))} · utilisé : ${formatDuration(t.used + Math.max(0, -t.adjust))}`;

  const configured = !!s.recipientEmail;
  const mail = mailRows(st.entries);
  $('#send-label').textContent = configured ? `Envoyer à ${s.recipientName || 'mon chef'}` : 'Configurer l’envoi au chef';
  // Un mail déjà préparé attend sa confirmation : « Recréer le mail » sert à le refaire.
  $('#send').disabled = mailBusy || !!st.lastMail || (configured && mail.rows.length === 0);
  $('#send').title = !configured ? 'Indiquez l’adresse du destinataire dans les réglages'
    : st.lastMail ? 'Un mail est déjà préparé : confirmez-le ou recréez-le ci-dessous'
    : mail.rows.length ? `Prépare un mail à ${s.recipientEmail} avec ${plural(mail.rows.length, 'ligne', 'lignes')}${mail.testOnly ? ' de test' : ''}` : 'Aucune heure supp à déclarer';

  renderMailBanner();
  renderUndeclared(rows, t);
  renderHistory();
  if (firstRender) { stagger(); firstRender = false; }
}

function renderMailBanner() {
  const m = state.lastMail;
  $('#mail-banner').classList.toggle('hidden', !m);
  if (!m) return;
  const count = m.entryIds.length;
  $('#mail-when').textContent = whenShort(m.at);
  $('#mail-text').textContent = m.method === 'mailto'
    ? `Le mail (${plural(count, 'ligne', 'lignes')}, ${formatDuration(m.total)}) s’est ouvert dans votre messagerie. Une fois envoyé, confirmez ici.`
    : `Le mail (${plural(count, 'ligne', 'lignes')}, ${formatDuration(m.total)}) s’ouvre dans Outlook : vérifiez-le et envoyez-le, puis confirmez ici.`;
  $('#mail-open').classList.toggle('hidden', !(m.method === 'eml' && Number.isInteger(m.downloadId)));
}

function entryTitle(e) {
  if (e.ticketId) return `#${e.ticketId}${e.org ? ' · ' + e.org : ''}`;
  if (e.newTicket || e.source === 'auto') return `Nouveau ticket${e.subject ? ' · ' + e.subject : ''}`;
  return e.note || 'Saisie manuelle';
}

function renderUndeclared(rows, t) {
  const list = $('#undeclared-list');
  list.replaceChildren();
  if (!rows.length) list.append(h('li', { class: 'empty' }, 'Aucune heure supp à déclarer.'));
  rows.forEach((e, i) => {
    if (editingId === e.id) { list.append(editRow(e)); return; }
    const sub = [whenShort(e.at), e.ticketId && e.note ? e.note : null].filter(Boolean).join(' · ');
    const li = h('li', { style: `--i:${i}` },
      h('div', { class: 'main' },
        h('div', { class: 'title-line', title: e.subject || '' }, entryTitle(e), e.test ? ' ' : null, e.test ? h('span', { class: 'tag test' }, 'Test') : null),
        h('div', { class: 'sub' }, sub)),
      h('span', { class: 'amount' }, formatDuration(e.minutes)),
      h('span', { class: 'actions' },
        iconButton(ICON_EDIT, 'Modifier', () => { editingId = e.id; render(); }),
        iconButton(ICON_DEL, 'Supprimer', () => removeEntry(e))));
    list.append(li);
  });
  const del = $('#delete-tests');
  del.classList.toggle('hidden', !t.testCount);
  del.textContent = `Supprimer les entrées de test (${t.testCount})`;
}

function editRow(e) {
  const dur = durationInput({ value: e.minutes, label: 'Durée', idPrefix: 'edit' });
  const note = h('input', { type: 'text', value: e.note || '', maxlength: 300, placeholder: 'Commentaire', style: 'width:100%' });
  const save = async () => {
    const minutes = dur.get();
    if (!dur.valid()) return toast(minutes > 0 ? '24 h au maximum.' : 'Indiquez une durée.', 'error');
    try {
      await send('updateEntry', { id: e.id, patch: { minutes, note: note.value } });
      editingId = null;
      toast('Modifié.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  const li = h('li', {}, h('div', { class: 'edit-row' },
    h('div', { class: 'title-line' }, entryTitle(e)),
    h('div', { class: 'row' }, dur.root),
    note,
    h('div', { class: 'row' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => { editingId = null; render(); } }, 'Annuler'),
      h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Enregistrer'))));
  setTimeout(() => dur.mins.focus(), 0);
  return li;
}

function renderHistory() {
  const list = $('#history');
  list.replaceChildren();
  const recent = [...state.entries].sort((a, b) => b.at - a.at).slice(0, 6);
  if (!recent.length) list.append(h('li', { class: 'empty' }, 'Aucun mouvement pour l’instant.'));
  recent.forEach((e, i) => {
    const sign = e.kind === 'use' || (e.kind === 'adjust' && e.minutes < 0) ? -1 : 1;
    const label = e.kind === 'overtime' ? entryTitle(e) : `${kindLabel(e.kind)}${e.note ? ' · ' + e.note : ''}`;
    const status = e.kind === 'overtime' ? (e.declared ? h('span', { class: 'tag ok' }, 'déclarée') : h('span', { class: 'tag info' }, 'à déclarer')) : null;
    list.append(h('li', { style: `--i:${i}` },
      h('div', { class: 'main' },
        h('div', { class: 'title-line' }, label),
        h('div', { class: 'sub' }, whenShort(e.at), ' ', status)),
      h('span', { class: 'amount ' + (sign < 0 ? 'neg' : 'pos') }, (sign < 0 ? '−' : '+') + formatDuration(Math.abs(e.minutes)))));
  });
}

/* ------------------------------ actions ---------------------------- */

async function removeEntry(e) {
  if (!confirm(`Supprimer ${formatDuration(e.minutes)} (${entryTitle(e)}) ?`)) return;
  try { await send('deleteEntry', { id: e.id }); toast('Supprimé.', 'success'); } catch (err) { toast(err.message, 'error'); }
}

function waitDownload(id, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (item && item.state === 'complete') return resolve(item);
      if (!item || item.state === 'interrupted') return reject(new Error('Le téléchargement du mail a échoué.'));
      if (Date.now() - started > timeoutMs) return reject(new Error('Le mail met trop de temps à se préparer.'));
      setTimeout(poll, 80);
    };
    poll();
  });
}

function openDownload(id) {
  try {
    const r = chrome.downloads.open(id);
    if (r && typeof r.then === 'function') return r;
    const err = chrome.runtime.lastError;
    return err ? Promise.reject(new Error(err.message)) : Promise.resolve();
  } catch (err) { return Promise.reject(err); }
}

async function copyTable(decl) {
  const html = `<!DOCTYPE html><html><body>${decl.html}</body></html>`;
  await navigator.clipboard.write([new ClipboardItem({
    'text/html': new Blob([html], { type: 'text/html' }),
    'text/plain': new Blob([decl.text], { type: 'text/plain' }),
  })]);
}

// Lignes du mail : celles du mail déjà préparé (si `prepared`), sinon les
// vraies heures supp à déclarer (les lignes de test n'y vont qu'entre elles).
function declarationRows(prepared) {
  if (prepared && state.lastMail) {
    const ids = new Set(state.lastMail.entryIds);
    return undeclaredEntries(state.entries).filter(e => ids.has(e.id));
  }
  return mailRows(state.entries).rows;
}

function currentDeclaration(includeSignature, prepared = false) {
  const rows = declarationRows(prepared);
  return rows.length ? buildDeclaration(rows, state.settings, { includeSignature }) : null;
}

async function prepareMail() {
  const s = state.settings;
  if (!s.recipientEmail) {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html#mail') });
    return;
  }
  const method = s.mailMethod;
  const decl = currentDeclaration(method === 'eml');
  if (!decl) return toast('Aucune heure supp à déclarer.', 'error');
  const skipped = mailRows(state.entries).skippedTests;

  if (method === 'mailto') {
    let url = buildMailto({ to: s.recipientEmail, subject: decl.subject, text: decl.text });
    if (url.length > MAILTO_MAX) {
      // Trop long pour un lien : le tableau part par le presse-papiers.
      await copyTable(decl);
      url = buildMailto({ to: s.recipientEmail, subject: decl.subject, text: `${decl.text.split('\n')[0]}\n\n(Collez ici le tableau copié : Ctrl+V)\n` });
      toast('Tableau copié : collez-le dans le mail (Ctrl+V).', 'info');
    }
    await send('mailPrepared', { entryIds: decl.entryIds, total: decl.total, method });
    h('a', { href: url }).click();
  } else {
    // Brouillon Outlook : fichier .eml « non envoyé », ouvert juste après.
    const eml = buildEml({ to: s.recipientEmail, subject: decl.subject, text: decl.text, html: decl.html });
    const downloadId = await chrome.downloads.download({ url: emlDataUrl(eml), filename: mailFileName(), conflictAction: 'uniquify', saveAs: false });
    await send('mailPrepared', { entryIds: decl.entryIds, total: decl.total, method, downloadId });
    await waitDownload(downloadId);
    try {
      await openDownload(downloadId);
    } catch (err) {
      toast('Cliquez sur « Ouvrir dans Outlook » pour afficher le mail.', 'info');
    }
  }
  if (skipped) toast(`${plural(skipped, 'ligne de test laissée', 'lignes de test laissées')} hors du mail.`, 'info');
}

async function runMail() {
  if (mailBusy) return;
  mailBusy = true;
  render();
  try { await prepareMail(); } catch (err) { toast(err.message, 'error'); }
  finally { mailBusy = false; render(); }
}

$('#send').addEventListener('click', () => {
  replay($('#send .plane'), 'fly');
  runMail();
});

$('#mail-done').addEventListener('click', async () => {
  try {
    const r = await send('markDeclared', { entryIds: state.lastMail ? state.lastMail.entryIds : [] });
    toast(r.count ? `${plural(r.count, 'ligne déclarée', 'lignes déclarées')} (${formatDuration(r.total)}).` : 'Rien à marquer.', 'success');
  } catch (err) { toast(err.message, 'error'); }
});

$('#mail-open').addEventListener('click', async () => {
  try { await openDownload(state.lastMail.downloadId); }
  catch (err) { toast('Fichier introuvable : cliquez sur « Recréer le mail ».', 'error'); }
});

$('#mail-again').addEventListener('click', () => runMail());

$('#mail-copy').addEventListener('click', async () => {
  const decl = currentDeclaration(true, true);
  if (!decl) return toast('Aucune heure supp à déclarer.', 'error');
  try { await copyTable(decl); toast('Tableau copié : collez-le dans un mail (Ctrl+V).', 'success'); }
  catch (err) { toast('Copie impossible : ' + err.message, 'error'); }
});

$('#mail-cancel').addEventListener('click', () => send('forgetMail').catch(err => toast(err.message, 'error')));

$('#pending-open').addEventListener('click', () => send('openPrompt').then(() => window.close(), err => toast(err.message, 'error')));
$('#test-off').addEventListener('click', () => send('saveSettings', { patch: { testModeUntil: 0 } }).then(() => toast('Mode test désactivé.', 'success'), err => toast(err.message, 'error')));
$('#open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#all-history').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#historique') }));
$('#update-how').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#mise-a-jour') }));
$('#updated-ok').addEventListener('click', () => chrome.storage.local.remove('justUpdated'));
$('#delete-tests').addEventListener('click', async () => {
  const n = computeTotals(state.entries).testCount;
  if (!confirm(`Supprimer les ${n} entrée(s) créée(s) en mode test ?`)) return;
  try { const r = await send('deleteTestEntries'); toast(`${r.removed} entrée(s) supprimée(s).`, 'success'); } catch (err) { toast(err.message, 'error'); }
});

/* ------------------------- formulaires de saisie ------------------- */

function setupForm(formId, toggleId, kind) {
  const form = $(formId), toggle = $(toggleId);
  const dur = durationInput({ value: 0, label: 'Durée', idPrefix: kind });
  form.querySelector('[data-slot="duration"]').append(dur.root);
  const close = () => { form.classList.add('hidden'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', () => {
    const open = form.classList.contains('hidden');
    document.querySelectorAll('.mini-form').forEach(f => f.classList.add('hidden'));
    document.querySelectorAll('[aria-expanded]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    if (!open) return;
    form.reset();
    dur.set(kind === 'use' ? 60 : 30);
    form.elements.at.value = toLocalInput(Date.now());
    form.classList.remove('hidden');
    toggle.setAttribute('aria-expanded', 'true');
    dur.hours.focus();
  });
  form.querySelector('[data-cancel]').addEventListener('click', close);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const minutes = dur.get();
    const at = fromLocalInput(form.elements.at.value);
    if (!dur.valid()) { replay(dur.root, 'shake'); return toast(minutes > 0 ? '24 h au maximum par saisie.' : 'Indiquez une durée.', 'error'); }
    if (!Number.isFinite(at)) return toast('Date invalide.', 'error');
    const entry = { kind, minutes, at };
    if (kind === 'overtime') {
      const tid = form.elements.ticket.value.trim().replace(/^#/, '');
      if (tid && !/^\d{1,12}$/.test(tid)) return toast('Numéro de ticket invalide.', 'error');
      entry.ticketId = tid || null;
      entry.note = form.elements.note.value;
    } else {
      const note = form.elements.note.value.trim();
      entry.note = form.elements.reason.value + (note ? ' — ' + note : '');
    }
    try {
      await send('addEntry', { entry });
      close();
      const bal = computeTotals((await loadState()).entries).balance;
      toast(kind === 'use'
        ? `Retiré du solde : ${formatDuration(minutes)}${bal < 0 ? ' (solde négatif)' : ''}.`
        : `Ajouté : ${formatDuration(minutes)}.`, bal < 0 ? 'info' : 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

setupForm('#add-form', '#add-toggle', 'overtime');
setupForm('#use-form', '#use-toggle', 'use');

/* ------------------------------ démarrage -------------------------- */

async function reload() {
  state = await loadState();
  render();
}
onStateChange(reload);
reload();
// Fichiers mis à jour sur le disque ? Le service worker recharge l'extension.
send('checkDisk').catch(() => {});
