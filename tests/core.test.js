import * as C from '../lib/core.js';
import { group, test, eq, ok, report } from './harness.js';

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const S = (patch = {}) => C.normalizeSettings({ ...C.defaultSettings(), ...patch });
const def = S();
const ORIGIN = 'https://exemple.zendesk.com';
const TEST_UNTIL = at(2026, 11, 2, 23, 59, 59);
const decodeB64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s+/g, '')), c => c.charCodeAt(0)));

group('Réglages');
test('parseHM', () => {
  eq(C.parseHM('08:30'), 510); eq(C.parseHM('24:00'), 1440); eq(C.parseHM(' 7:05 '), 425);
  eq(C.parseHM('7:5'), NaN); eq(C.parseHM('25:00'), NaN); eq(C.parseHM('12:60'), NaN); eq(C.parseHM(''), NaN);
});
test('validateSlots', () => {
  eq(C.validateSlots(def.slots), null);
  ok(C.validateSlots([]));
  ok(C.validateSlots([{ start: '09:00', end: '08:00' }]));
  ok(C.validateSlots([{ start: '08:00', end: '12:00' }, { start: '11:00', end: '14:00' }]));
  eq(C.validateSlots([{ start: '14:00', end: '17:00' }, { start: '08:30', end: '12:30' }]), null);
});
test('normalizeSettings : valeurs par défaut sans donnée d’entreprise', () => {
  const s = C.normalizeSettings(null);
  eq([s.recipientEmail, s.recipientName, s.senderName, s.zendeskOrigin, s.animations], ['', '', '', '', true]);
  eq(def.slots, [{ start: '08:30', end: '12:30' }, { start: '14:00', end: '17:00' }]);
});
test('normalizeSettings : nettoyage', () => {
  const s = C.normalizeSettings({ recipientEmail: 'pas une adresse', workDays: [5, 1, 1, 9, '3'], slots: [{ start: '14:00', end: '17:00' }, { start: '8:30', end: '12:30' }], mailMethod: 'fax', zendeskOrigin: 'https://evil.example.com', animations: false });
  eq(s.recipientEmail, '');
  eq(s.workDays, [1, 3, 5]);
  eq(s.slots[0], { start: '08:30', end: '12:30' });
  eq(s.mailMethod, 'eml');
  eq(s.zendeskOrigin, '', 'origine non Zendesk refusée');
  eq(s.animations, false);
  eq(C.normalizeSettings({ recipientEmail: ' chef@example.com ', zendeskOrigin: ORIGIN }).recipientEmail, 'chef@example.com');
  eq(C.normalizeSettings({ zendeskOrigin: ORIGIN }).zendeskOrigin, ORIGIN);
  eq(C.normalizeSettings({ slots: [{ start: '10:00', end: '09:00' }] }).slots, def.slots, 'créneaux invalides ignorés');
});
test('versions et liens', () => {
  eq(C.compareVersions('1.0.10', '1.0.9'), 1); eq(C.compareVersions('1.2', '1.2.0'), 0); eq(C.compareVersions('0.9.9', '1.0.0'), -1);
  eq(C.ticketUrl(ORIGIN, '123456'), ORIGIN + '/agent/tickets/123456');
  eq(C.ticketUrl('', '123456'), '');
  eq(C.ticketUrl('https://exemple.zendesk.com.evil.io', '1'), '');
  ok(C.isZendeskOrigin(ORIGIN) && !C.isZendeskOrigin('http://exemple.zendesk.com'));
});

group('Jours fériés');
test('Pâques', () => {
  eq(C.dateKey(C.easterSunday(2024).getTime()), '2024-03-31');
  eq(C.dateKey(C.easterSunday(2025).getTime()), '2025-04-20');
  eq(C.dateKey(C.easterSunday(2026).getTime()), '2026-04-05');
  eq(C.dateKey(C.easterSunday(2027).getTime()), '2027-03-28');
});
test('fériés 2026', () => {
  const h = C.frenchHolidays(2026);
  eq(h.get('2026-04-06'), 'Lundi de Pâques');
  eq(h.get('2026-05-14'), 'Ascension');
  eq(h.get('2026-05-25'), 'Lundi de Pentecôte');
  eq(h.get('2026-11-11'), 'Armistice');
  eq(h.get('2026-11-02'), undefined);
  eq(h.size, 11);
});

group('Classement horaire');
test('créneaux d’un lundi', () => {
  const r = (h, m, s = 0) => C.classifyTime(at(2026, 11, 2, h, m, s), def).reason;
  eq(r(8, 29, 59), 'avant'); eq(r(8, 30), 'horaires'); eq(r(12, 29, 59), 'horaires');
  eq(r(12, 30), 'pause'); eq(r(13, 59), 'pause'); eq(r(14, 0), 'horaires');
  eq(r(16, 59, 59), 'horaires'); eq(r(17, 0), 'apres'); eq(r(23, 30), 'apres'); eq(r(6, 0), 'avant');
});
test('week-end et férié', () => {
  eq(C.classifyTime(at(2026, 11, 7, 10), def).reason, 'jour');
  const f = C.classifyTime(at(2026, 11, 11, 10), def);
  eq([f.reason, f.holiday, f.outOfHours], ['ferie', 'Armistice', true]);
  eq(C.classifyTime(at(2026, 11, 11, 10), S({ holidaysOff: false })).reason, 'horaires');
});
test('mode test', () => {
  const s = S({ testModeUntil: TEST_UNTIL });
  eq(C.classifyTime(at(2026, 11, 2, 15), s), { outOfHours: true, reason: 'test' });
  eq(C.classifyTime(at(2026, 11, 2, 18), s).reason, 'apres', 'hors horaires réel : raison réelle');
  eq(C.classifyTime(at(2026, 11, 3, 15), s).reason, 'horaires', 'fin du mode test à minuit');
  ok(C.isTestModeActive(s, at(2026, 11, 2, 16)));
  ok(!C.isTestModeActive(s, at(2026, 11, 3, 0, 0, 1)));
});
test('libellés', () => {
  eq(C.describeReason({ reason: 'apres' }, at(2026, 11, 2, 17, 30), def), 'après 17h');
  eq(C.describeReason({ reason: 'avant' }, at(2026, 11, 2, 8), def), 'avant 8h30');
  eq(C.describeReason({ reason: 'pause' }, at(2026, 11, 2, 13), def), 'pendant la pause (12h30 – 14h)');
  eq(C.describeReason({ reason: 'jour' }, at(2026, 11, 7, 10), def), 'samedi, jour non travaillé');
  eq(C.describeReason({ reason: 'ferie', holiday: 'Armistice' }, at(2026, 11, 11, 10), def), 'jour férié (Armistice)');
});

group('Début de la plage hors horaires');
test('cas courants', () => {
  eq(C.outOfHoursPeriodStart(at(2026, 11, 2, 17, 20), def), at(2026, 11, 2, 17));
  eq(C.outOfHoursPeriodStart(at(2026, 11, 2, 12, 50), def), at(2026, 11, 2, 12, 30));
  eq(C.outOfHoursPeriodStart(at(2026, 11, 3, 8, 10), def), at(2026, 11, 2, 17));
  eq(C.outOfHoursPeriodStart(at(2026, 11, 7, 10), def), at(2026, 11, 6, 17), 'samedi → vendredi 17h');
  eq(C.outOfHoursPeriodStart(at(2026, 11, 2, 8), def), at(2026, 10, 30, 17), 'lundi matin → vendredi');
  eq(C.outOfHoursPeriodStart(at(2026, 11, 12, 8), def), at(2026, 11, 10, 17), 'le 11/11 férié est sauté');
  eq(C.outOfHoursPeriodStart(at(2026, 11, 2, 10), def), at(2026, 11, 2, 10), 'dans les horaires');
});
test('changement d’heure (25/10/2026)', () => {
  const t = C.outOfHoursPeriodStart(at(2026, 10, 26, 8), def);
  eq(t, at(2026, 10, 23, 17));
  eq(new Date(t).getHours(), 17);
});

group('Suggestion de durée');
test('appel avant 17h : seule la partie hors horaires', () => {
  const r = C.computeSuggestion({ resolvedAt: at(2026, 11, 3, 17, 20), lastCallAt: at(2026, 11, 3, 16, 50) }, def);
  eq([r.suggestedMin, r.fullGapMin, r.clipped, r.refSource], [20, 30, true, 'appel']);
});
test('appel après 17h', () => {
  const r = C.computeSuggestion({ resolvedAt: at(2026, 11, 3, 17, 20), lastCallAt: at(2026, 11, 3, 17, 5) }, def);
  eq([r.suggestedMin, r.clipped], [15, false]);
});
test('sans appel : depuis l’affichage du ticket', () => {
  const r = C.computeSuggestion({ resolvedAt: at(2026, 11, 3, 17, 20), lastCallAt: null, shownSince: at(2026, 11, 3, 17, 1) }, def);
  eq([r.suggestedMin, r.refSource], [19, 'affichage']);
  const r2 = C.computeSuggestion({ resolvedAt: at(2026, 11, 3, 17, 20), shownSince: at(2026, 11, 3, 9) }, def);
  eq(r2.suggestedMin, 20, 'ticket ouvert le matin : borné à 17h');
});
test('appel trop ancien ignoré', () => {
  const r = C.computeSuggestion({ resolvedAt: at(2026, 11, 3, 17, 20), lastCallAt: at(2026, 11, 1, 10) }, def);
  eq([r.suggestedMin, r.refSource], [0, null]);
});
test('réglage « écart complet »', () => {
  const r = C.computeSuggestion({ resolvedAt: at(2026, 11, 3, 17, 20), lastCallAt: at(2026, 11, 3, 16, 50) }, S({ clipToOutOfHours: false }));
  eq(r.suggestedMin, 30);
});
test('mode test : écart complet depuis l’appel', () => {
  const s = S({ testModeUntil: TEST_UNTIL });
  const r = C.computeSuggestion({ resolvedAt: at(2026, 11, 2, 15, 4), lastCallAt: at(2026, 11, 2, 14, 35, 18) }, s);
  eq([r.suggestedMin, r.cls.reason], [29, 'test']);
});
test('pause de midi et matin tôt', () => {
  eq(C.computeSuggestion({ resolvedAt: at(2026, 11, 3, 12, 50), lastCallAt: at(2026, 11, 3, 12, 20) }, def).suggestedMin, 20);
  eq(C.computeSuggestion({ resolvedAt: at(2026, 11, 3, 8, 10), lastCallAt: at(2026, 11, 3, 7, 55) }, def).suggestedMin, 15);
});
test('appel horodaté juste après la résolution', () => {
  const r = C.computeSuggestion({ resolvedAt: at(2026, 11, 3, 17, 20), lastCallAt: at(2026, 11, 3, 17, 20, 30) }, def);
  eq(r.suggestedMin, 0);
});

group('Formatage et saisie');
test('formatDuration', () => {
  eq(C.formatDuration(0), '0 min'); eq(C.formatDuration(5), '5 min'); eq(C.formatDuration(60), '1 h');
  eq(C.formatDuration(65), '1 h 05'); eq(C.formatDuration(125), '2 h 05'); eq(C.formatDuration(-90), '-1 h 30');
});
test('formatBadge', () => {
  eq(C.formatBadge(0), '0m'); eq(C.formatBadge(45), '45m'); eq(C.formatBadge(65), '1:05'); eq(C.formatBadge(600), '10h');
  ok(C.formatBadge(9999).length <= 4);
});
test('parseDuration', () => {
  const cases = { '1h30': 90, '1 h 30': 90, '1:30': 90, '90': 90, '90 min': 90, '1,5h': 90, '2h': 120, '1.5': 90, '45mn': 45, '0h45': 45 };
  for (const [k, v] of Object.entries(cases)) eq(C.parseDuration(k), v, k);
  for (const k of ['1h75', 'abc', '', '1.5h30', '1:75']) eq(C.parseDuration(k), NaN, k);
});

group('Entrées et totaux');
test('sanitizeEntry', () => {
  const e = C.sanitizeEntry({ kind: 'overtime', minutes: 22, at: at(2026, 11, 2, 17, 24), ticketId: '#123456', note: '  rappel   client ', origin: ORIGIN });
  eq([e.ticketId, e.note, e.declared, e.source, e.origin], ['123456', 'rappel client', false, 'manuel', ORIGIN]);
  eq(C.sanitizeEntry({ kind: 'overtime', minutes: 5, at: 1, origin: 'javascript:alert(1)' }).origin, '');
  eq(C.sanitizeEntry({ kind: 'overtime', minutes: 0, at: 1 }), null);
  eq(C.sanitizeEntry({ kind: 'overtime', minutes: -5, at: 1 }), null);
  eq(C.sanitizeEntry({ kind: 'use', minutes: 2000, at: 1 }), null);
  eq(C.sanitizeEntry({ kind: 'adjust', minutes: -300, at: 1 }).minutes, -300);
  eq(C.sanitizeEntry({ kind: 'bonus', minutes: 5, at: 1 }), null);
  eq(C.sanitizeEntry({ kind: 'use', minutes: 30, at: 1, ticketId: 'abc' }).ticketId, null);
});
test('computeTotals', () => {
  const t = C.computeTotals([
    { kind: 'overtime', minutes: 30, declared: false },
    { kind: 'overtime', minutes: 20, declared: true },
    { kind: 'use', minutes: 15 },
    { kind: 'adjust', minutes: 60, test: true },
  ]);
  eq([t.earned, t.used, t.adjust, t.balance, t.undeclared, t.undeclaredCount, t.testCount], [50, 15, 60, 95, 30, 1, 1]);
});

group('Mail');
const MAIL = S({ recipientEmail: 'chef@example.com', recipientName: 'Camille', zendeskOrigin: ORIGIN });
const rows = [
  { id: 'b', kind: 'overtime', minutes: 43, at: at(2026, 11, 3, 18, 2), ticketId: '123470', org: 'CABINET <b>X</b> & Cie', note: '' },
  { id: 'a', kind: 'overtime', minutes: 22, at: at(2026, 11, 2, 17, 24), ticketId: '123456', org: 'SOCIÉTÉ EXEMPLE (EXEMP01)', note: '', origin: ORIGIN },
];
test('déclaration : texte', () => {
  const d = C.buildDeclaration(rows, { ...MAIL, senderName: 'Alex DURAND' });
  eq(d.subject, 'Heures supplémentaires – Alex DURAND – du 02/11/2026 au 03/11/2026');
  ok(d.text.startsWith('Bonjour Camille,\n'), 'commence par Bonjour + prénom');
  ok(d.text.endsWith('Bonne journée,\nAlex DURAND'), 'finit par Bonne journée + nom');
  ok(d.text.includes('#123456\tSOCIÉTÉ EXEMPLE (EXEMP01)\t02/11/2026\t17:24\t22 min'), 'ligne triée par date');
  ok(d.text.includes('Total : 1 h 05'));
  eq(d.entryIds, ['a', 'b']);
  eq(d.total, 65);
  ok(C.buildDeclaration(rows, def).text.startsWith('Bonjour,\n'), 'sans prénom : « Bonjour, »');
});
test('déclaration : HTML échappé et liens', () => {
  const d = C.buildDeclaration(rows, MAIL, { includeSignature: false });
  ok(d.html.includes('<table'), 'tableau');
  ok(d.html.includes(`href="${ORIGIN}/agent/tickets/123456"`), 'lien depuis l’entrée');
  ok(d.html.includes(`href="${ORIGIN}/agent/tickets/123470"`), 'lien depuis les réglages');
  ok(!C.buildDeclaration([rows[0]], def).html.includes('href='), 'pas de lien sans adresse Zendesk');
  ok(d.html.includes('CABINET &lt;b&gt;X&lt;/b&gt; &amp; Cie'), 'client échappé');
  ok(!d.html.includes('<b>X</b>'), 'pas de HTML injecté');
  ok(d.text.endsWith('Bonne journée'), 'sans nom : « Bonne journée »');
  ok(C.buildDeclaration([{ ...rows[0], test: true }], MAIL).subject.startsWith('[TEST] '), 'objet [TEST]');
  eq(C.buildDeclaration([], MAIL), null);
});
test('en-tête MIME encodé et réversible', () => {
  eq(C.encodeMimeHeader('Hello'), 'Hello');
  const subject = 'Heures supplémentaires – Alex DURAND – du 02/11/2026 au 03/11/2026';
  const enc = C.encodeMimeHeader(subject);
  const words = enc.split('\r\n ');
  ok(words.every(w => w.length <= 75), 'mots ≤ 75 caractères');
  eq(words.map(w => decodeB64(w.slice(10, -2))).join(''), subject);
});
test('fichier .eml', () => {
  const d = C.buildDeclaration(rows, MAIL);
  const eml = C.buildEml({ to: MAIL.recipientEmail, subject: d.subject, text: d.text, html: d.html }, 'BOUND');
  ok(eml.includes('\r\nX-Unsent: 1\r\n'), 'X-Unsent');
  ok(eml.startsWith('To: chef@example.com\r\n'), 'destinataire');
  ok(!/[^\r]\n/.test(eml), 'fins de ligne CRLF uniquement');
  ok(eml.split('\r\n').every(l => l.length <= 998), 'lignes ≤ 998');
  ok(eml.trimEnd().endsWith('--BOUND--'), 'fermeture multipart');
  const parts = eml.split('--BOUND');
  const htmlPart = parts[2].split('\r\n\r\n')[1];
  ok(decodeB64(htmlPart).includes('SOCIÉTÉ EXEMPLE'), 'HTML décodable');
  const textPart = parts[1].split('\r\n\r\n')[1];
  ok(decodeB64(textPart).startsWith('Bonjour Camille,\r\n'), 'texte en CRLF');
  ok(C.emlDataUrl(eml).startsWith('data:message/rfc822;base64,'));
});
test('mailto', () => {
  const d = C.buildDeclaration(rows, MAIL);
  const url = C.buildMailto({ to: MAIL.recipientEmail, subject: d.subject, text: d.text });
  ok(url.startsWith('mailto:chef@example.com?subject='));
  ok(url.includes('%0D%0A'), 'retours à la ligne encodés');
  ok(!/[\s<>]/.test(url), 'aucun caractère brut');
});
test('nom de fichier', () => {
  eq(C.mailFileName(at(2026, 11, 2, 17, 40)), 'Heures supp 2026-11-02 17h40.eml');
});
test('CSV', () => {
  const csv = C.buildCsv([...rows, { kind: 'use', minutes: 30, at: at(2026, 11, 4, 16), note: 'Départ plus tôt; RDV' }]);
  ok(csv.startsWith('﻿Date;Heure;Type'), 'BOM + en-tête');
  ok(csv.includes(';-30;−30 min;'), 'heures utilisées en négatif (minutes numériques)');
  ok(csv.includes('"Départ plus tôt; RDV"'), 'cellule avec « ; » entre guillemets');
  const evil = C.buildCsv([{ kind: 'overtime', minutes: 5, at: at(2026, 11, 4, 18), subject: '=HYPERLINK("x")', org: '- URGENT', note: '@cmd' }]);
  ok(evil.includes(`"'=HYPERLINK(""x"")"`) && evil.includes(";'- URGENT;") && evil.includes(";'@cmd;"), 'formules neutralisées');
});
test('mail : les lignes de test ne partent pas avec les vraies', () => {
  const real = { id: 'r', kind: 'overtime', minutes: 30, at: at(2026, 11, 2, 18), ticketId: '1' };
  const fake = { id: 't', kind: 'overtime', minutes: 20, at: at(2026, 11, 2, 15), ticketId: '2', test: true };
  eq(C.mailRows([real, fake]).rows.map(e => e.id), ['r']);
  eq(C.mailRows([real, fake]).skippedTests, 1);
  const only = C.mailRows([fake]);
  eq([only.rows.length, only.testOnly], [1, true]);
  ok(C.buildDeclaration(only.rows, MAIL).text.includes('#2 (test)'), 'ligne de test marquée');
});

group('Chevauchement des suggestions');
test('la plage déjà proposée n’est pas reproposée', () => {
  const r = C.computeSuggestion({ resolvedAt: at(2026, 11, 3, 17, 25), lastCallAt: at(2026, 11, 3, 15), notBefore: at(2026, 11, 3, 17, 10) }, def);
  eq([r.suggestedMin, r.boundBy, r.start], [15, 'precedente', at(2026, 11, 3, 17, 10)]);
  const r2 = C.computeSuggestion({ resolvedAt: at(2026, 11, 3, 17, 25), lastCallAt: at(2026, 11, 3, 15), notBefore: at(2026, 11, 3, 12, 40) }, def);
  eq([r2.suggestedMin, r2.boundBy], [25, 'plage'], 'résolution d’une autre plage ignorée');
});

report();
