/* ------------------------------------------------------------------
   Heures supp Zendesk — script de contenu (espace agent Zendesk)

   Ce script OBSERVE uniquement : il ne clique sur rien, ne modifie rien
   dans la page et n'appelle pas l'API Zendesk.

   1. Il repère l'appui sur « Résolu » :
      - l'option « Résolu » du menu du bouton d'envoi
        (data-test-id="submit_button-menu-solved") ;
      - le bouton principal quand il affiche « Envoyer comme Résolu »
        (statut choisi par une macro, par exemple) ;
      - le raccourci Zendesk Ctrl+Alt+S (« envoyer comme résolu »).
      Choisir ensuite un autre statut annule le suivi.
   2. Il relève le ticket affiché (ou en cours de création) : numéro,
      sujet, client, demandeur et dernier appel noté dans le fil ou dans
      le brouillon (« Prénom NOM le 02/11/2026 14:31:41 appel vers … »).
   3. Il attend que Zendesk confirme : le statut de l'en-tête passe à
      « Résolu », l'onglet se ferme juste après l'envoi, ou le ticket créé
      s'ouvre. Si l'envoi échoue (champ obligatoire vide…), rien n'est
      signalé.
   4. Il prévient le service worker, qui décide s'il s'agit d'heures supp.
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var SEL = {
    submitButton: '[data-test-id="submit_button-button"]',
    menuPrefix: 'submit_button-menu-',
    menuToggle: 'submit_button-menu-button',
    menuSolved: 'submit_button-menu-solved',
    resubmit: '[data-test-id="ticket-footer-resubmit-button"]',
    statusNav: '[data-test-id="tabs-section-nav-item-ticket"]',
    subject: '[data-test-id="omni-header-subject"]',
    org: '[data-test-id="tabs-nav-item-organizations"]',
    requester: '[data-test-id="tabs-nav-item-users"]',
    requesterField: '[data-test-id="ticket-system-field-requester-select"]',
    feed: 'section[data-test-id="omni-log-container"]',
    comment: 'article[data-test-id="omni-log-comment-item"]',
    commentBody: '[data-test-id="omni-log-message-content"]',
    internalTag: '[data-test-id="omni-log-internal-note-tag"]',
    headerTab: 'a[data-test-id="header-tab"]',
    headerTabTitle: '[data-test-id="header-tab-title"]',
    editor: '[contenteditable="true"]',
  };

  var STATUS_PATTERNS = [
    [/^(nouveau|new)\b/i, 'new'],
    [/^(ouvert|open)\b/i, 'open'],
    [/^(en attente|pending)\b/i, 'pending'],
    [/^(en pause|on-hold|hold)\b/i, 'hold'],
    [/^(résolu|resolu|solved)\b/i, 'solved'],
    [/^(clos|fermé|closed)\b/i, 'closed'],
  ];
  var SOLVED_LABEL = /(résolu|resolu|solved)\s*$/i;
  // « Prénom NOM le 02/11/2026 14:31:41 appel vers Jeanne MARTIN au … »
  var CALL_IN_TEXT = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(?:à\s+)?(\d{1,2})[:h](\d{2})(?::(\d{2}))?\s+appel\b/i;
  var CALL_WORD = /(^|[^\wÀ-ÿ])appel([^\wÀ-ÿ]|$)/i;   // « appel » seul (pas « rappeler »)

  var WATCH_STEP_MS = 300;
  var WATCH_MAX_MS = 90 * 1000;          // au-delà, l'envoi est considéré comme abandonné
  var NEW_WATCH_MAX_MS = 60 * 1000;      // ticket en création
  var UNKNOWN_STATUS_MS = 4000;          // statut illisible : on signale quand même après 4 s
  var TAB_CLOSE_WINDOW_MS = 15 * 1000;   // onglet fermé peu après l'appui = envoi réussi

  function createDetector(env) {
    var doc = env.document;
    var now = env.now;
    var watchers = {};          // clé du ticket (« 123456 » ou « new/1 ») → suivi en cours
    var shownSince = {};        // clé → première fois affiché dans cet onglet
    var shownTicket = null;

    /* ----------------------------- lecture ---------------------------- */

    function text(el) {
      return el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }

    // Clé du ticket d'une URL : son numéro, ou « new/N » pour un ticket en création.
    function keyFromPath(path) {
      var m = /^\/agent\/tickets\/(\d+)/.exec(path || '');
      if (m) return m[1];
      m = /^\/agent\/tickets\/new\/(\d+)/.exec(path || '');
      return m ? 'new/' + m[1] : null;
    }

    function isNew(key) {
      return String(key || '').indexOf('new/') === 0;
    }

    function ticketIdFromPath(path) {
      var k = keyFromPath(path);
      return k && !isNew(k) ? k : null;
    }

    function currentKey() {
      return keyFromPath(env.location().pathname);
    }

    function visibleWorkspace() {
      var list = doc.querySelectorAll('.workspace');
      for (var i = 0; i < list.length; i++) {
        if (list[i].getClientRects().length && list[i].querySelector(SEL.submitButton)) return list[i];
      }
      return null;
    }

    // Plusieurs espaces de travail peuvent coexister dans le DOM (un par
    // onglet de ticket) : on cible toujours celui du ticket concerné.
    function workspaceFor(key) {
      if (!key) return null;
      if (isNew(key)) return key === currentKey() ? visibleWorkspace() : null;
      var layout = doc.querySelector('[data-test-id="ticket-' + key + '-standard-layout"]') ||
                   doc.querySelector('[data-ticket-id="' + key + '"]');
      if (!layout) return null;
      return layout.closest('.workspace') || layout;
    }

    function ticketIdOf(el) {
      var ws = el && el.closest ? el.closest('.workspace') : null;
      if (!ws) return null;
      var layout = ws.querySelector('[data-test-id$="-standard-layout"]');
      var m = layout && /^ticket-(\d+)-/.exec(layout.getAttribute('data-test-id') || '');
      if (m) return m[1];
      var t = ws.querySelector('[data-ticket-id]');
      return t ? t.getAttribute('data-ticket-id') : null;
    }

    function keyOf(el) {
      return ticketIdOf(el) || currentKey();
    }

    // Statut enregistré (et non celui choisi dans le menu) : « Ouvert Ticket #123456 ».
    function readStatus(key) {
      if (!key || isNew(key)) return null;
      var scope = workspaceFor(key) || doc;
      var navs = scope.querySelectorAll(SEL.statusNav);
      for (var i = 0; i < navs.length; i++) {
        var t = text(navs[i]);
        if (!t || t.indexOf('#' + key) < 0) continue;
        for (var j = 0; j < STATUS_PATTERNS.length; j++) {
          if (STATUS_PATTERNS[j][0].test(t)) return STATUS_PATTERNS[j][1];
        }
      }
      return null;
    }

    function tabExists(key) {
      return !!doc.querySelector(SEL.headerTab + '[href$="tickets/' + key + '"]');
    }

    function openTicketTabs() {
      var out = [];
      var tabs = doc.querySelectorAll(SEL.headerTab);
      for (var i = 0; i < tabs.length; i++) {
        var m = /tickets\/(\d+)$/.exec(tabs[i].getAttribute('href') || '');
        if (m) out.push(m[1]);
      }
      return out;
    }

    function readSubject(key) {
      var ws = workspaceFor(key);
      var input = ws && ws.querySelector(SEL.subject);
      if (input && input.value) return input.value.trim();
      var tab = doc.querySelector(SEL.headerTab + '[href$="tickets/' + key + '"]');
      var title = tab && tab.querySelector(SEL.headerTabTitle);
      return text(title).replace(/\s*#\d+$/, '');
    }

    function readOrg(key) {
      var ws = workspaceFor(key);
      return text(ws && ws.querySelector(SEL.org));
    }

    function readRequester(key) {
      var ws = workspaceFor(key);
      return text(ws && (ws.querySelector(SEL.requester) || ws.querySelector(SEL.requesterField)));
    }

    function callLabel(raw) {
      var m = /appel\s+(vers|de|depuis|à)\s+(.+?)(?:\s+(?:au|du|sur)\s+[+\d]|\s*:|$)/i.exec(raw);
      var label = m ? 'appel ' + m[1].toLowerCase() + ' ' + m[2].trim() : raw.split('\n')[0];
      return label.replace(/\+?\d[\d .]{5,}\d/g, '…').replace(/\s+/g, ' ').trim().slice(0, 90);
    }

    function callFromText(raw) {
      var head = String(raw || '').slice(0, 500);
      var m = CALL_IN_TEXT.exec(head);
      if (!m) return null;
      var at = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
      return isFinite(at) ? { at: at, label: callLabel(head.slice(m.index)) } : null;
    }

    function latest(a, b) {
      var max = now() + 5 * 60 * 1000;   // une heure « future » est ignorée
      a = a && a.at <= max ? a : null;
      b = b && b.at <= max ? b : null;
      if (!a) return b;
      if (!b) return a;
      return b.at > a.at ? b : a;
    }

    // Dernier appel noté dans le fil du ticket : { at, label } ou null.
    function readLastCall(key) {
      var ws = workspaceFor(key);
      var feed = ws && ws.querySelector(SEL.feed);
      if (!feed) return null;
      var best = null;
      var items = feed.querySelectorAll(SEL.comment);
      for (var i = 0; i < items.length; i++) {
        var art = items[i];
        var body = art.querySelector(SEL.commentBody) || art;
        var raw = String(body.innerText || body.textContent || '');
        var found = callFromText(raw);
        if (!found && art.querySelector(SEL.internalTag)) {
          var firstLine = (raw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean)[0]) || '';
          var t = CALL_WORD.test(firstLine) ? art.querySelector('time[datetime]') : null;
          var v = t ? Date.parse(t.getAttribute('datetime')) : NaN;
          if (isFinite(v)) found = { at: v, label: callLabel(firstLine) };
        }
        best = latest(best, found);
      }
      return best;
    }

    // Note d'appel encore dans le composeur, envoyée avec la résolution.
    function readDraftCall(key) {
      var ws = workspaceFor(key);
      if (!ws) return null;
      var best = null;
      var eds = ws.querySelectorAll(SEL.editor);
      for (var i = 0; i < eds.length; i++) best = latest(best, callFromText(eds[i].innerText || eds[i].textContent));
      return best;
    }

    function countInvalid(key) {
      return (workspaceFor(key) || doc).querySelectorAll('[aria-invalid="true"]').length;
    }

    function hasResubmit(key) {
      return !!(workspaceFor(key) || doc).querySelector(SEL.resubmit);
    }

    /* --------------------------- confirmation ------------------------- */

    // (Re)part de zéro pour la confirmation : chaque appui a sa propre fenêtre.
    function arm(w) {
      w.lastPress = now();
      w.started = w.lastPress;
      w.invalidBefore = countInvalid(w.key);
      w.resubmitBefore = hasResubmit(w.key);
    }

    function trigger(source, key) {
      key = key || currentKey();
      if (!key) return false;
      var w = watchers[key];
      if (w) {
        // Nouvel appui pendant le suivi (après correction d'un champ, par
        // exemple) : on retient ce dernier appui.
        w.snap.resolvedAt = now();
        w.snap.source = source;
        arm(w);
        return false;
      }
      var statusBefore = readStatus(key);
      if (statusBefore === 'solved' || statusBefore === 'closed') return false; // déjà résolu

      var call = latest(readLastCall(key), readDraftCall(key));
      w = watchers[key] = {
        key: key,
        timer: null,
        statusBefore: statusBefore,
        hadTab: tabExists(key),
        tabsBefore: openTicketTabs(),
        snap: {
          ticketId: isNew(key) ? '' : key,
          newTicket: isNew(key),
          origin: env.location().origin,
          subject: readSubject(key),
          org: readOrg(key),
          requester: readRequester(key),
          lastCallAt: call ? call.at : null,
          lastCallLabel: call ? call.label : '',
          shownSince: shownSince[key] || null,
          resolvedAt: now(),
          source: source,
        },
      };
      arm(w);
      w.timer = env.setInterval(function () { check(w); }, WATCH_STEP_MS);
      return true;
    }

    // Un autre statut a été choisi : ce n'était pas (ou plus) une résolution.
    function disarm(key) {
      var w = key && watchers[key];
      if (w) finish(w, false, 'autre statut choisi');
    }

    function finish(w, ok, how, ticketId) {
      env.clearInterval(w.timer);
      if (watchers[w.key] === w) delete watchers[w.key];
      var snap = w.snap;
      if (ticketId) snap.ticketId = ticketId;
      if (env.log) env.log('ticket ' + (snap.ticketId ? '#' + snap.ticketId : 'nouveau') + ' : ' + (ok ? 'résolution confirmée (' + how + ')' : 'pas de résolution (' + how + ')'));
      if (!ok) return;
      // Le fil contient peut-être maintenant la note d'appel envoyée avec la résolution.
      if (snap.ticketId) {
        var after = readLastCall(snap.ticketId);
        if (after && after.at <= snap.resolvedAt + 60 * 1000 && (!snap.lastCallAt || after.at > snap.lastCallAt)) {
          snap.lastCallAt = after.at;
          snap.lastCallLabel = after.label;
        }
      }
      snap.confirmedBy = how;
      env.send({ type: 'ticketSolved', data: snap });
    }

    // Ticket en création : Zendesk ouvre à sa place le ticket créé (nouvel onglet).
    function createdTicket(w) {
      var k = currentKey();
      if (!k || isNew(k) || w.tabsBefore.indexOf(k) >= 0) return null;
      var st = readStatus(k);
      if (st === 'solved' || st === 'closed') return k;
      if (!tabExists(w.key) && now() - w.lastPress <= TAB_CLOSE_WINDOW_MS) return k;
      return null;
    }

    function check(w) {
      var t = now();
      var elapsed = t - w.started;
      var recent = t - w.lastPress <= TAB_CLOSE_WINDOW_MS;
      var failed = function () { return countInvalid(w.key) > w.invalidBefore || (!w.resubmitBefore && hasResubmit(w.key)); };
      if (isNew(w.key)) {
        var created = createdTicket(w);
        if (created) return finish(w, true, 'ticket créé', created);
        if (w.hadTab && !tabExists(w.key) && recent) return finish(w, true, 'onglet fermé');
        if (failed()) return finish(w, false, 'erreur à l’envoi');
        if (elapsed >= NEW_WATCH_MAX_MS) return finish(w, false, 'délai dépassé');
        return;
      }
      var st = readStatus(w.key);
      if (st === 'solved' || st === 'closed') return finish(w, true, 'statut');
      if (w.hadTab && !tabExists(w.key) && recent) return finish(w, true, 'onglet fermé');
      if (failed()) return finish(w, false, 'erreur à l’envoi');
      if (w.statusBefore === null && st === null && elapsed >= UNKNOWN_STATUS_MS) return finish(w, true, 'non vérifiée');
      if (elapsed >= WATCH_MAX_MS) return finish(w, false, 'délai dépassé');
    }

    /* ---------------------------- écouteurs --------------------------- */

    function menuItemOf(el) {
      var item = el && el.closest ? el.closest('[data-test-id^="' + SEL.menuPrefix + '"]') : null;
      return item ? item.getAttribute('data-test-id') : null;
    }

    function onPointer(e) {
      if (e.type === 'pointerdown' && e.button !== 0) return;   // clic droit, molette
      var el = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
      if (!el || !el.closest) return;
      var tid = menuItemOf(el);
      if (tid === SEL.menuToggle) return;
      // Le menu (rendu à part dans la page) appartient au ticket affiché.
      if (tid === SEL.menuSolved) { trigger('menu', currentKey()); return; }
      if (tid) { if (e.type === 'click') disarm(currentKey()); return; }
      var btn = el.closest(SEL.submitButton);
      if (!btn) return;
      if (SOLVED_LABEL.test(text(btn))) trigger('bouton', keyOf(btn));
      else if (e.type === 'click') disarm(keyOf(btn));
    }

    function onKey(e) {
      if (e.repeat) return;
      var k = String(e.key || '').toLowerCase();
      if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
        if (e.code === 'KeyS' || k === 's') { trigger('raccourci', currentKey()); return; }
        if (/^Key[PDO]$/.test(e.code || '') || /^[pdo]$/.test(k)) { disarm(currentKey()); return; }
      }
      if (k !== 'enter' && k !== ' ' && k !== 'spacebar') return;
      // Menu au clavier : l'option surlignée est désignée par aria-activedescendant.
      var a = doc.activeElement;
      var tid = menuItemOf(a);
      if ((!tid || tid === SEL.menuToggle) && a && a.getAttribute) {
        var ad = a.getAttribute('aria-activedescendant');
        var hi = ad ? doc.getElementById(ad) : null;
        if (hi) tid = menuItemOf(hi);
      }
      if (tid === SEL.menuSolved) trigger('menu (clavier)', currentKey());
      else if (tid && tid !== SEL.menuToggle) disarm(currentKey());
    }

    function tick() {
      var key = currentKey();
      if (key !== shownTicket) {
        shownTicket = key;
        if (key && !shownSince[key]) shownSince[key] = now();
      }
    }

    var tickTimer = null;

    function guard(handler) {
      return function (e) {
        // Extension rechargée : cette instance est orpheline, elle se retire.
        if (env.alive && !env.alive()) { stop(); return; }
        handler(e);
      };
    }
    var onPointerSafe = guard(onPointer);
    var onKeySafe = guard(onKey);

    function init() {
      doc.addEventListener('pointerdown', onPointerSafe, true);
      doc.addEventListener('click', onPointerSafe, true);
      doc.addEventListener('keydown', onKeySafe, true);
      tickTimer = env.setInterval(tick, 1000);
      tick();
    }

    function stop() {
      doc.removeEventListener('pointerdown', onPointerSafe, true);
      doc.removeEventListener('click', onPointerSafe, true);
      doc.removeEventListener('keydown', onKeySafe, true);
      if (tickTimer !== null) env.clearInterval(tickTimer);
      Object.keys(watchers).forEach(function (key) { env.clearInterval(watchers[key].timer); delete watchers[key]; });
    }

    return {
      init: init, stop: stop, trigger: trigger, disarm: disarm, tick: tick,
      readStatus: readStatus, readSubject: readSubject, readOrg: readOrg, readRequester: readRequester,
      readLastCall: readLastCall, readDraftCall: readDraftCall, tabExists: tabExists, workspaceFor: workspaceFor,
      ticketIdOf: ticketIdOf, ticketIdFromPath: ticketIdFromPath, keyFromPath: keyFromPath, countInvalid: countInvalid,
      callLabel: callLabel,
      watching: function () { return Object.keys(watchers); },
      shownSinceOf: function (key) { return shownSince[key] || null; },
    };
  }

  // Tests (tests/content.test.html) : on expose la fabrique sans rien démarrer.
  var hooks = typeof globalThis !== 'undefined' ? globalThis.__HS_TEST__ : null;
  if (hooks) { hooks.createDetector = createDetector; return; }

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // Le service worker réinjecte ce script dans les onglets déjà ouverts : on
  // ne démarre pas deux fois si l'instance en place vit encore.
  if (typeof window.__hsHeuresSuppActif === 'function' && window.__hsHeuresSuppActif()) return;
  window.__hsHeuresSuppActif = alive;

  createDetector({
    document: document,
    location: function () { return window.location; },
    now: function () { return Date.now(); },
    setInterval: function (f, t) { return window.setInterval(f, t); },
    clearInterval: function (id) { window.clearInterval(id); },
    alive: alive,
    log: function (msg) { console.debug('[Heures supp] ' + msg); },
    send: function (msg) {
      try {
        var p = chrome.runtime.sendMessage(msg);
        if (p && p.catch) p.catch(function (err) { console.warn('[Heures supp] Message non transmis :', err && err.message); });
      } catch (err) {
        console.warn('[Heures supp] Extension mise à jour : actualisez Zendesk (F5) pour réactiver la détection.');
      }
    },
  }).init();
})();
