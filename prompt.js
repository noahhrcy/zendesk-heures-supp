/* Fenêtre ouverte après une résolution hors horaires. */
import { formatDuration, formatTime, formatDate, sameDay, computeTotals, ticketUrl } from './lib/core.js';
import { send, loadState, onStateChange, durationInput, toast, $, applyLook, stagger, replay, animationsOn } from './lib/ui.js';

const PREVIEW = new URLSearchParams(location.search).has('apercu');
const STEP = 5;
// Une action n'est acceptée qu'un court instant après l'affichage de la
// question : un double-clic ou une Entrée tapée pour Zendesk ne répond pas
// à une question que l'on n'a pas lue.
const READ_DELAY_MS = 700;

const dur = durationInput({ label: 'Temps supplémentaire', idPrefix: 'dur' });
$('#duration').append(dur.root);

let pending = [];
let current = null;
let busy = false;
let shownAt = Date.now();
let closing = null;
let renderedKey = '';

function previewItem() {
  const now = Date.now();
  return {
    id: 'apercu', ticketId: '123456', subject: 'Exemple : problème de connexion',
    org: 'SOCIÉTÉ EXEMPLE', requester: 'Jeanne MARTIN',
    resolvedAt: now, reason: 'apres', reasonText: 'après 17h', lastCallAt: now - 37 * 60000,
    lastCallLabel: 'appel vers Jeanne MARTIN', refSource: 'appel', refAt: now - 37 * 60000,
    startAt: now - 22 * 60000, boundBy: 'plage', fullGapMin: 37, suggestedMin: 22, clipped: true, test: false,
  };
}

// « à 17:24 » le jour même, « le 02/11/2026 à 17:24 » sinon.
function when(ts) {
  return sameDay(ts, Date.now()) ? `à ${formatTime(ts)}` : `le ${formatDate(ts)} à ${formatTime(ts)}`;
}

function heroLine(p) {
  if (p.test) return 'Mode test : compté comme hors horaires';
  if (p.reason === 'ferie') return `Résolu un ${p.reasonText}`;
  return `Résolu ${p.reasonText || 'hors horaires'}`;
}

function linkButton(label, onclick) {
  const b = document.createElement('button');
  b.className = 'link'; b.type = 'button'; b.textContent = label;
  b.addEventListener('click', onclick);
  return b;
}

function suggestionText(p) {
  const box = $('#suggestion');
  box.replaceChildren();
  const add = (...nodes) => box.append(...nodes);
  const useFull = () => linkButton(`Utiliser l’écart complet (${formatDuration(p.fullGapMin)})`, () => { dur.setAnimated(p.fullGapMin); });
  const from = p.boundBy === 'precedente'
    ? `depuis la résolution précédente (${formatTime(p.startAt)})`
    : p.boundBy === 'plage' ? `depuis le début des heures supp (${formatTime(p.startAt)})` : null;
  const staleCall = p.lastCallAt && p.refSource !== 'appel';

  if (p.refSource === 'appel') {
    if (from) { add(`Appel à ${formatTime(p.refAt)} : ${formatDuration(p.suggestedMin)} proposées ${from}. `); add(useFull()); }
    else add(`Suggestion : ${formatDuration(p.suggestedMin)} depuis le dernier appel (${formatTime(p.refAt)}).`);
  } else if (p.refSource === 'affichage') {
    add(staleCall ? 'Dernier appel trop ancien (plus de 12 h), non utilisé. ' : 'Aucun appel noté dans le ticket. ');
    if (from) { add(`Ticket ouvert à ${formatTime(p.refAt)} : ${formatDuration(p.suggestedMin)} proposées ${from}. `); add(useFull()); }
    else add(`Suggestion calculée depuis l’ouverture du ticket (${formatTime(p.refAt)}).`);
  } else {
    add(staleCall ? 'Dernier appel trop ancien (plus de 12 h) : indiquez le temps passé.' : 'Aucun appel trouvé dans le ticket : indiquez le temps passé.');
  }
  const reset = linkButton(` ↺ Revenir à ${formatDuration(p.suggestedMin)}`, () => { dur.setAnimated(p.suggestedMin); });
  reset.classList.add('hidden'); reset.id = 'reset';
  add(' ', reset);
}

function refreshYes(min) {
  const yes = $('#yes');
  yes.disabled = busy || min <= 0 || min > dur.maxMinutes;
  yes.textContent = min > dur.maxMinutes ? '24 h au maximum' : min > 0 ? `Oui, ajouter ${formatDuration(min)}` : 'Indiquez une durée';
  const reset = $('#reset');
  if (reset && current) reset.classList.toggle('hidden', min === current.suggestedMin);
}
dur.onChange(refreshYes);

function render(st) {
  if (st) applyLook(st.settings);
  const totals = computeTotals(st ? st.entries : []);
  $('#totals').textContent = `Non déclarées au chef : ${formatDuration(totals.undeclared)} · Solde : ${formatDuration(totals.balance)}`;

  $('#preview-banner').classList.toggle('hidden', !PREVIEW);
  const has = pending.length > 0;
  $('#question').classList.toggle('hidden', !has);
  $('#empty').classList.toggle('hidden', has);
  $('#counter').classList.toggle('hidden', pending.length < 2);
  if (!has) { current = null; $('#hero-sub').textContent = 'Rien à confirmer'; return; }

  current = (current && pending.find(p => p.id === current.id)) || pending[0];
  // Question différente, ou même ticket re-résolu entre-temps : on repart de la suggestion.
  const key = `${current.id}:${current.resolvedAt}:${current.suggestedMin}`;
  const changed = key !== renderedKey;
  renderedKey = key;
  const idx = pending.indexOf(current);
  $('#counter').textContent = `${idx + 1} / ${pending.length}`;

  const p = current;
  $('#hero-sub').textContent = heroLine(p);
  const link = $('#t-link');
  link.textContent = p.ticketId ? `Ticket #${p.ticketId}` : 'Nouveau ticket';
  const url = ticketUrl(p.origin, p.ticketId);
  if (url) link.href = url; else link.removeAttribute('href');
  $('#t-test').classList.toggle('hidden', !p.test);
  $('#t-subject').textContent = p.subject || '(sujet non lu)';
  $('#t-client').textContent = [p.org, p.requester].filter(Boolean).join(' · ');
  $('#t-resolved').textContent = `Résolu ${when(p.resolvedAt)} — ${p.reasonText || 'hors horaires'}` +
    (p.confirmedBy === 'non vérifiée' ? ' (résolution non confirmée par Zendesk)' : '');
  $('#t-ref').textContent = p.lastCallAt
    ? `Dernier appel ${when(p.lastCallAt)}${p.lastCallLabel ? ' — ' + p.lastCallLabel : ''}`
    : 'Aucun appel noté dans le ticket';

  if (changed) {
    suggestionText(p);
    dur.set(p.suggestedMin || 0);
    $('#note').value = '';
    shownAt = Date.now();
    replay($('#question'), 'bump-soft');
  }
  refreshYes(dur.get());
}

function sortPending(list) {
  return [...list].sort((a, b) => a.resolvedAt - b.resolvedAt);
}

async function reload() {
  if (PREVIEW) { render(await loadState()); return; }
  const st = await loadState();
  pending = sortPending(st.pending);
  // La fenêtre s'ouvre (ou revient) sur la résolution qui vient d'arriver.
  const { promptFocus } = await chrome.storage.session.get('promptFocus');
  if (promptFocus && Date.now() - promptFocus.at < 60000) {
    const target = pending.find(p => p.id === promptFocus.id);
    if (target) current = target;
    await chrome.storage.session.remove('promptFocus');
  }
  if (pending.length && closing) { clearTimeout(closing); closing = null; }
  render(st);
}

// Coche animée, puis question suivante ou fermeture (sauf si une question
// est arrivée entre-temps).
function celebrate(text) {
  const done = $('#done');
  $('#done-text').textContent = text;
  done.classList.remove('hidden');
  const last = pending.length === 0;
  const wait = animationsOn() ? (last ? 1100 : 850) : (last ? 450 : 150);
  return new Promise(resolve => {
    const t = setTimeout(() => {
      closing = null;
      if (!pending.length) window.close();
      else done.classList.add('hidden');
      resolve();
    }, wait);
    if (last) closing = t;
  });
}

function tooSoon() {
  return Date.now() - shownAt < READ_DELAY_MS;
}

async function act(fn, message) {
  if (busy || !current || tooSoon()) return;
  busy = true;
  refreshYes(dur.get());
  try {
    if (PREVIEW) {
      pending = [];
      await celebrate('Aperçu : rien n’a été enregistré');
      return;
    }
    const p = current;
    await fn(p);
    const st = await loadState();
    pending = sortPending(st.pending);
    current = null;
    await celebrate(message(p));
    render(await loadState());
  } catch (err) {
    replay($('#yes'), 'shake');
    toast(err.message, 'error');
  } finally {
    busy = false;
    refreshYes(dur.get());
  }
}

$('#yes').addEventListener('click', (e) => {
  if (e.detail > 1) return;
  const minutes = dur.get();
  if (minutes <= 0 || minutes > dur.maxMinutes) return;
  act(p => send('answerPending', { pendingId: p.id, minutes, note: $('#note').value }),
    () => `Heures supp : +${formatDuration(minutes)}`);
});
$('#no').addEventListener('click', (e) => {
  if (e.detail > 1) return;
  act(p => send('dismissPending', { pendingId: p.id }), p => `${p.ticketId ? 'Ticket #' + p.ticketId : 'Nouveau ticket'} : pas d’heures supp`);
});
$('#not-solved').addEventListener('click', () => {
  act(p => send('dismissPending', { pendingId: p.id }), p => `${p.ticketId ? 'Ticket #' + p.ticketId : 'Nouveau ticket'} ignoré`);
});
// « Plus tard » : question suivante s'il y en a, sinon fermeture.
$('#later').addEventListener('click', () => {
  if (pending.length > 1 && current) {
    const i = pending.indexOf(current);
    current = pending[(i + 1) % pending.length];
    loadState().then(render);
    return;
  }
  window.close();
});
$('#close-empty').addEventListener('click', () => window.close());
$('#minus').addEventListener('click', () => dur.setAnimated(Math.max(0, dur.get() - STEP)));
$('#plus').addEventListener('click', () => dur.setAnimated(dur.get() + STEP));
document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
  if (chip.dataset.set !== undefined) dur.setAnimated(Number(chip.dataset.set));
  else dur.setAnimated(Math.max(0, dur.get() + Number(chip.dataset.add)));
}));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); window.close(); return; }
  // Entrée ne valide que depuis les champs de saisie (durée, commentaire).
  if (e.key === 'Enter' && !e.shiftKey && !e.repeat && current && e.target.matches && e.target.matches('#dur-h, #dur-m, #note')) {
    e.preventDefault();
    if (!tooSoon()) $('#yes').click();
  }
});

stagger();
if (PREVIEW) pending = [previewItem()];
else onStateChange(changes => { if (changes.pending || changes.entries) reload(); });
reload();
