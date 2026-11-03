/* Tests de content.js sur une reproduction locale du DOM de l'espace agent
   Zendesk (structure relevée en novembre 2026 ; données fictives). */
import { group, test, eq, ok, report } from './harness.js';

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const ORIGIN = 'https://exemple.zendesk.com';

const WORKSPACE = (id, status = 'Ouvert') => `
<div class="workspace" id="ws-${id}">
  <header><nav>
    <span data-test-id="tabs-nav-item-organizations" role="link">SOCIÉTÉ EXEMPLE (EXEMP01)</span>
    <span data-test-id="tabs-nav-item-users" role="link"><span>Jeanne MARTIN</span></span>
    <span data-test-id="tabs-section-nav-item-ticket" role="link"><span><span class="status-pill">${status}</span></span> Ticket #${id}</span>
    <span data-test-id="tabs-section-nav-item-ticket" role="link"></span>
  </nav></header>
  <div data-test-id="ticket-${id}-standard-layout">
    <input data-test-id="omni-header-subject" value="Exemple : problème de connexion">
    <div data-ticket-id="${id}">
      <section data-test-id="omni-log-container" role="feed">
        <article data-test-id="omni-log-comment-item">
          <time datetime="2026-11-02T13:30:00.000Z">Aujourd’hui 14:30</time>
          <div data-test-id="omni-log-message-content"><div>Bonjour, merci de me rappeler suite à notre appel.</div></div>
        </article>
        <article data-test-id="omni-log-comment-item">
          <span data-test-id="omni-log-internal-note-tag">Interne</span>
          <time datetime="2026-11-02T13:33:14.000Z">Aujourd’hui 14:33</time>
          <div data-test-id="omni-log-message-content"><div>Alex DURAND le 02/11/2026 14:31:41 appel vers Jeanne MARTIN au +33600000000 :</div><div>Absente</div></div>
        </article>
        <article data-test-id="omni-log-comment-item">
          <span data-test-id="omni-log-internal-note-tag">Interne</span>
          <time datetime="2026-11-02T13:35:56.000Z">Aujourd’hui 14:35</time>
          <div data-test-id="omni-log-message-content"><div>Alex DURAND le 02/11/2026 14:35:18 appel vers Second technicien au 0600000000 :</div><div>Pas de réponse</div></div>
        </article>
        <article data-test-id="omni-log-comment-item" class="late-note">
          <span data-test-id="omni-log-internal-note-tag">Interne</span>
          <time datetime="2026-11-02T15:00:00.000Z">Aujourd’hui 16:00</time>
          <div data-test-id="omni-log-message-content"><div>Rappeler le 03/11 à 10h</div></div>
        </article>
      </section>
    </div>
    <div class="footer">
      <div class="composer" contenteditable="true"></div>
      <div data-garden-id="buttons.button_group_view">
        <button data-test-id="submit_button-button" class="submit"><div><span>Envoyer comme <strong>Ouvert</strong></span></div></button>
        <button data-test-id="submit_button-menu-button" class="toggle" aria-haspopup="true">▾</button>
      </div>
      <input class="field-motif" aria-invalid="false">
    </div>
  </div>
</div>`;

const FIXTURE = `
<ul class="tabs">
  <li><a data-test-id="header-tab" href="tickets/123456"><div data-test-id="header-tab-title">Exemple : problème de connexion #123456</div></a></li>
  <li><a data-test-id="header-tab" href="tickets/999"><div data-test-id="header-tab-title">Autre ticket #999</div></a></li>
</ul>
<div id="workspaces">${WORKSPACE('123456')}
<div class="workspace" id="ws-other" style="display:none">
  <header><nav><span data-test-id="tabs-section-nav-item-ticket" role="link"><span>Résolu</span> Ticket #999</span></nav></header>
  <div data-test-id="ticket-999-standard-layout"></div>
</div></div>
<div id="portal">
  <ul role="menu" id="menu">
    <li role="menuitem" data-test-id="submit_button-menu-open" id="opt-open">Envoyer comme <strong>Ouvert</strong></li>
    <li role="menuitem" data-test-id="submit_button-menu-pending" id="opt-pending">Envoyer comme <strong>En attente</strong></li>
    <li role="menuitem" data-test-id="submit_button-menu-solved" id="opt-solved"><span>Envoyer comme <strong id="solved-strong">Résolu</strong></span></li>
  </ul>
</div>`;

// Environnement factice : horloge, adresse et minuteurs pilotés par le test.
function makeEnv() {
  let clock = at(2026, 11, 2, 17, 20);
  let nextId = 1;
  const timers = new Map();
  const sent = [];
  const env = {
    path: '/agent/tickets/123456',
    document,
    location: () => ({ pathname: env.path, origin: ORIGIN }),
    now: () => clock,
    setInterval: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms, next: clock + ms }); return id; },
    clearInterval: id => { timers.delete(id); },
    send: msg => sent.push(msg),
    alive: () => true,
    advance(ms) {
      const end = clock + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.next <= end && (!due || t.next < due[1].next)) due = [id, t];
        if (!due) break;
        clock = due[1].next;
        due[1].next += due[1].ms;
        due[1].fn();
      }
      clock = end;
    },
    sent,
  };
  return env;
}

let previous = null;
function setup() {
  if (previous) previous.stop();       // un seul détecteur à l'écoute à la fois
  document.getElementById('fixture').innerHTML = FIXTURE;
  const env = makeEnv();
  const det = window.__HS_TEST__.createDetector(env);
  det.init();
  previous = det;
  const q = sel => document.querySelector(sel);
  return { env, det, q, $: id => document.getElementById(id) };
}

function fire(el, type, init = {}) {
  const Ctor = type.startsWith('key') ? KeyboardEvent : (type === 'pointerdown' ? PointerEvent : MouseEvent);
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, button: 0, ...init }));
}

function setStatus(word, id = '123456') {
  document.querySelector(`#ws-${id} .status-pill`).textContent = word;
}

group('Lecture du ticket');
test('statut, sujet, client, demandeur', () => {
  const { det, q } = setup();
  eq(det.readStatus('123456'), 'open');
  eq(det.readStatus('999'), 'solved', 'espace de travail d’un autre ticket');
  eq(det.readSubject('123456'), 'Exemple : problème de connexion');
  eq(det.readOrg('123456'), 'SOCIÉTÉ EXEMPLE (EXEMP01)');
  eq(det.readRequester('123456'), 'Jeanne MARTIN');
  ok(det.tabExists('123456') && !det.tabExists('12345'), 'onglet exact');
  eq(det.ticketIdOf(q('#ws-123456 .submit')), '123456');
  eq([det.keyFromPath('/agent/tickets/123456/events'), det.keyFromPath('/agent/tickets/new/2'), det.keyFromPath('/agent/dashboard')], ['123456', 'new/2', null]);
});
test('dernier appel : heure lue dans la note', () => {
  const { det } = setup();
  const c = det.readLastCall('123456');
  eq(c.at, at(2026, 11, 2, 14, 35, 18));
  eq(c.label, 'appel vers Second technicien');
});
test('note « Relance appel » plus récente : heure de la note', () => {
  const { det, q } = setup();
  q('.late-note [data-test-id="omni-log-message-content"]').innerHTML = '<div>Relance appel le 02/11 à 16h00</div>';
  const c = det.readLastCall('123456');
  eq(c.at, Date.parse('2026-11-02T15:00:00.000Z'));
  ok(c.label.startsWith('Relance appel'), c.label);
});
test('« Rappeler » et message public ignorés', () => {
  const { det } = setup();
  eq(det.readLastCall('123456').at, at(2026, 11, 2, 14, 35, 18));
});
test('libellé : numéro masqué', () => {
  const { det } = setup();
  eq(det.callLabel('appel vers Prestataire au 0600000000 :'), 'appel vers Prestataire');
  ok(!/\d{6}/.test(det.callLabel('Appel vers le 06 00 00 00 00')), 'numéro masqué');
});
test('note d’appel encore dans le composeur', () => {
  const { det, q } = setup();
  q('#ws-123456 .composer').textContent = 'Alex DURAND le 02/11/2026 17:10:05 appel vers Jeanne MARTIN au +33600000000 : rappel';
  eq(det.readDraftCall('123456').at, at(2026, 11, 2, 17, 10, 5));
});

group('Détection de « Résolu »');
test('option « Résolu » du menu puis statut Résolu → signalé', () => {
  const { env, det, q, $ } = setup();
  fire(q('#ws-123456 .toggle'), 'click');
  fire($('solved-strong'), 'pointerdown');
  fire($('solved-strong'), 'click');
  eq(det.watching(), ['123456'], 'un seul suivi malgré pointerdown + click');
  env.advance(1000);
  eq(env.sent.length, 0, 'rien avant confirmation');
  setStatus('Résolu');
  env.advance(400);
  eq(env.sent.length, 1);
  const d = env.sent[0].data;
  eq(env.sent[0].type, 'ticketSolved');
  eq([d.ticketId, d.origin, d.org, d.requester, d.confirmedBy, d.source], ['123456', ORIGIN, 'SOCIÉTÉ EXEMPLE (EXEMP01)', 'Jeanne MARTIN', 'statut', 'menu']);
  eq(d.lastCallAt, at(2026, 11, 2, 14, 35, 18));
  eq(d.resolvedAt, at(2026, 11, 2, 17, 20));
  eq(det.watching(), [], 'suivi terminé');
  env.advance(5000);
  eq(env.sent.length, 1, 'pas de second signalement');
});
test('appel envoyé avec la résolution : relu dans le fil à la confirmation', () => {
  const { env, q, $ } = setup();
  fire($('opt-solved'), 'click');
  env.advance(600);
  q('#ws-123456 [data-test-id="omni-log-container"]').insertAdjacentHTML('beforeend',
    '<article data-test-id="omni-log-comment-item"><span data-test-id="omni-log-internal-note-tag">Interne</span><div data-test-id="omni-log-message-content">Alex DURAND le 02/11/2026 17:12:00 appel vers Jeanne MARTIN au 0600000000 :</div></article>');
  setStatus('Résolu');
  env.advance(300);
  eq(env.sent[0].data.lastCallAt, at(2026, 11, 2, 17, 12));
});
test('autre statut du menu → rien', () => {
  const { env, det, $ } = setup();
  fire($('opt-pending'), 'click');
  eq(det.watching(), []);
  env.advance(5000);
  eq(env.sent.length, 0);
});
test('« Résolu » puis autre statut → suivi annulé', () => {
  const { env, det, $ } = setup();
  fire($('opt-solved'), 'pointerdown');
  eq(det.watching(), ['123456']);
  fire($('opt-pending'), 'click');
  eq(det.watching(), [], 'annulé par « En attente »');
  fire($('opt-solved'), 'pointerdown');
  fire(document.body, 'keydown', { key: 'p', code: 'KeyP', ctrlKey: true, altKey: true });
  eq(det.watching(), [], 'annulé par Ctrl+Alt+P');
  document.querySelector('a[href="tickets/123456"]').closest('li').remove();
  env.advance(1000);
  eq(env.sent.length, 0, 'fermeture d’onglet sans résolution');
});
test('clic droit ignoré', () => {
  const { det, $ } = setup();
  fire($('opt-solved'), 'pointerdown', { button: 2 });
  eq(det.watching(), []);
});
test('bouton principal : seulement s’il affiche « Résolu »', () => {
  const { env, det, q } = setup();
  fire(q('#ws-123456 .submit'), 'click');
  eq(det.watching(), [], '« Envoyer comme Ouvert » ignoré');
  q('#ws-123456 .submit').innerHTML = '<div><span>Envoyer comme <strong>Résolu</strong></span></div>';
  fire(q('#ws-123456 .submit strong'), 'click');
  eq(det.watching(), ['123456']);
  setStatus('Résolu');
  env.advance(300);
  eq(env.sent.length, 1);
  eq(env.sent[0].data.source, 'bouton');
});
test('raccourci Ctrl+Alt+S', () => {
  const { env, det } = setup();
  fire(document.body, 'keydown', { key: 's', code: 'KeyS', ctrlKey: true, altKey: true });
  eq(det.watching(), ['123456']);
  setStatus('Résolu');
  env.advance(300);
  eq(env.sent[0].data.source, 'raccourci');
});
test('menu au clavier (aria-activedescendant)', () => {
  const { det, q } = setup();
  const toggle = q('#ws-123456 .toggle');
  toggle.setAttribute('aria-activedescendant', 'opt-solved');
  toggle.focus();
  fire(toggle, 'keydown', { key: 'Enter' });
  eq(det.watching(), ['123456']);
});
test('onglet fermé juste après l’envoi → signalé', () => {
  const { env } = setup();
  fire(document.getElementById('opt-solved'), 'click');
  document.getElementById('ws-123456').remove();
  document.querySelector('a[href="tickets/123456"]').closest('li').remove();
  env.advance(300);
  eq(env.sent.length, 1);
  eq(env.sent[0].data.confirmedBy, 'onglet fermé');
});
test('onglet fermé longtemps après l’appui → non compté', () => {
  const { env, det, $ } = setup();
  fire($('opt-solved'), 'click');
  env.advance(20000);
  document.querySelector('a[href="tickets/123456"]').closest('li').remove();
  env.advance(1000);
  eq(env.sent.length, 0);
  ok(det.watching().length === 1, 'toujours en attente du statut');
});
test('champ obligatoire en erreur → rien', () => {
  const { env, det, q, $ } = setup();
  fire($('opt-solved'), 'click');
  q('#ws-123456 .field-motif').setAttribute('aria-invalid', 'true');
  env.advance(300);
  eq(det.watching(), []);
  setStatus('Résolu');
  env.advance(5000);
  eq(env.sent.length, 0);
});
test('aucun changement pendant 90 s → abandon', () => {
  const { env, det, $ } = setup();
  fire($('opt-solved'), 'click');
  env.advance(91000);
  eq(det.watching(), []);
  eq(env.sent.length, 0);
});
test('nouvel appui en fin de délai : délai relancé', () => {
  const { env, $ } = setup();
  fire($('opt-solved'), 'click');
  env.advance(89500);
  fire($('opt-solved'), 'click');
  env.advance(1000);
  setStatus('Résolu');
  env.advance(300);
  eq(env.sent.length, 1);
  eq(env.sent[0].data.resolvedAt, at(2026, 11, 2, 17, 20) + 89500, 'heure du dernier appui');
});
test('ticket déjà résolu → rien', () => {
  const { env, det, $ } = setup();
  setStatus('Résolu');
  fire($('opt-solved'), 'click');
  eq(det.watching(), []);
  env.advance(5000);
  eq(env.sent.length, 0);
});
test('statut illisible → signalé après 4 s (« non vérifiée »)', () => {
  const { env, $ } = setup();
  document.querySelectorAll('#ws-123456 [data-test-id="tabs-section-nav-item-ticket"]').forEach(n => n.remove());
  fire($('opt-solved'), 'click');
  env.advance(3000);
  eq(env.sent.length, 0);
  env.advance(1500);
  eq(env.sent.length, 1);
  eq(env.sent[0].data.confirmedBy, 'non vérifiée');
});
test('nouveau ticket résolu d’un coup → n° du ticket créé', () => {
  const { env, det } = setup();
  // Onglet « nouveau ticket » affiché à la place du ticket existant.
  document.getElementById('ws-123456').style.display = 'none';
  document.getElementById('workspaces').insertAdjacentHTML('beforeend',
    '<div class="workspace" id="ws-new"><input data-test-id="omni-header-subject" value="Appel entrant"><button data-test-id="submit_button-button">Envoyer comme <strong>Nouveau</strong></button></div>');
  document.querySelector('.tabs').insertAdjacentHTML('beforeend', '<li><a data-test-id="header-tab" href="tickets/new/1">Nouveau ticket</a></li>');
  env.path = '/agent/tickets/new/1';
  fire(document.body, 'keydown', { key: 's', code: 'KeyS', ctrlKey: true, altKey: true });
  eq(det.watching(), ['new/1']);
  env.advance(900);
  eq(env.sent.length, 0);
  // Zendesk remplace l'onglet par le ticket créé, déjà résolu.
  document.getElementById('ws-new').remove();
  document.querySelector('a[href="tickets/new/1"]').closest('li').remove();
  document.querySelector('.tabs').insertAdjacentHTML('beforeend', '<li><a data-test-id="header-tab" href="tickets/777001">Appel entrant #777001</a></li>');
  document.getElementById('workspaces').insertAdjacentHTML('beforeend', WORKSPACE('777001', 'Résolu'));
  env.path = '/agent/tickets/777001';
  env.advance(300);
  eq(env.sent.length, 1);
  const d = env.sent[0].data;
  eq([d.ticketId, d.newTicket, d.subject, d.confirmedBy], ['777001', true, 'Appel entrant', 'ticket créé']);
});
test('extension rechargée : l’instance orpheline se retire', () => {
  const { env, det, $ } = setup();
  env.alive = () => false;
  fire($('opt-solved'), 'click');
  eq(det.watching(), []);
  env.alive = () => true;
  fire($('opt-solved'), 'click');
  eq(det.watching(), [], 'écouteurs retirés');
});
test('affichage du ticket mémorisé (référence sans appel)', () => {
  const { env, det } = setup();
  eq(det.shownSinceOf('123456'), at(2026, 11, 2, 17, 20));
  env.advance(60000);
  det.tick();
  eq(det.shownSinceOf('123456'), at(2026, 11, 2, 17, 20), 'première fois conservée');
});

if (previous) previous.stop();
report();
document.getElementById('fixture').innerHTML = '';
