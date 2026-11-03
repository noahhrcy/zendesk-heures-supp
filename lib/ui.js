/* Outils communs aux pages de l'extension (popup, fenêtre, réglages). */
import { normalizeSettings } from './core.js';

// Police Montserrat (Google Fonts), chargée sans bloquer l'affichage ; en
// cas d'absence de réseau, la pile de polices système prend le relais.
(function loadFont() {
  if (document.getElementById('font-montserrat')) return;
  const link = document.createElement('link');
  link.id = 'font-montserrat';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,500;0,600;0,700;0,800;1,600&display=swap';
  document.head.append(link);
})();

// Animations activées / coupées selon le réglage.
export function applyLook(settings) {
  document.documentElement.dataset.anim = settings && settings.animations === false ? 'off' : 'on';
}

export function animationsOn() {
  return document.documentElement.dataset.anim !== 'off';
}

// Relance une animation CSS ponctuelle (ex. « bump ») sur un élément.
export function replay(el, cls) {
  if (!el || !animationsOn()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

// Numérote les éléments .reveal pour les faire apparaître en cascade.
export function stagger(root = document) {
  root.querySelectorAll('.reveal').forEach((el, i) => el.style.setProperty('--i', i));
}

// Fait défiler une durée de `from` à `to` minutes dans `el` (affichage formaté).
const counters = new WeakMap();
export function countTo(el, to, format, { duration = 650 } = {}) {
  const from = counters.has(el) ? counters.get(el) : 0;
  counters.set(el, to);
  if (!animationsOn() || from === to || typeof requestAnimationFrame !== 'function') { el.textContent = format(to); return; }
  const start = performance.now();
  let done = false;
  const step = (t) => {
    if (done) return;
    const k = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = format(Math.round(from + (to - from) * eased));
    if (k < 1) requestAnimationFrame(step); else done = true;
  };
  requestAnimationFrame(step);
  setTimeout(() => { if (!done) { done = true; el.textContent = format(to); } }, duration + 400);
}

// Envoie un message au service worker ; rejette avec le message d'erreur reçu.
export async function send(type, payload = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...payload });
  if (!r || !r.ok) throw new Error((r && r.error) || 'Pas de réponse de l’extension.');
  return r;
}

export async function loadState() {
  const raw = await chrome.storage.local.get(['settings', 'entries', 'pending', 'mails', 'lastMail', 'update', 'justUpdated', 'installDir']);
  return {
    settings: normalizeSettings(raw.settings),
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    pending: Array.isArray(raw.pending) ? raw.pending : [],
    mails: Array.isArray(raw.mails) ? raw.mails : [],
    lastMail: raw.lastMail || null,
    update: raw.update || null,
    justUpdated: raw.justUpdated || null,
    installDir: typeof raw.installDir === 'string' ? raw.installDir : '',
  };
}

export function onStateChange(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') cb(changes);
  });
}

// Petit constructeur DOM : h('button', { class: 'btn', onclick }, 'Texte').
// Les textes passent par textContent : aucune donnée n'est interprétée en HTML.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

let toastTimer = null;
export function toast(message, kind = 'info') {
  let t = document.getElementById('toast');
  if (!t) {
    t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(t);
  }
  t.textContent = message;
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast ' + kind; }, kind === 'error' ? 6000 : 3200);
}

// Champ durée « [ h ] h [ min ] min » : renvoie { root, get(), set(min), onChange(cb) }.
// Les heures acceptent les décimales (« 1,5 » = 1 h 30). Au-delà de
// `maxMinutes`, la valeur est signalée (classe .over) au lieu d'être rabotée.
export function durationInput({ value = 0, label = 'Durée', idPrefix = 'dur', maxMinutes = 24 * 60 } = {}) {
  const hours = h('input', { type: 'number', min: 0, max: Math.floor(maxMinutes / 60), step: 'any', inputmode: 'decimal', id: idPrefix + '-h', 'aria-label': label + ' (heures)', class: 'num' });
  const mins = h('input', { type: 'number', min: 0, max: 59, step: 1, inputmode: 'numeric', id: idPrefix + '-m', 'aria-label': label + ' (minutes)', class: 'num' });
  const listeners = [];
  const root = h('div', { class: 'duration' }, hours, h('span', { class: 'unit' }, 'h'), mins, h('span', { class: 'unit' }, 'min'));

  function get() {
    const hv = Math.max(0, Number(String(hours.value).replace(',', '.')) || 0);
    const mv = Math.max(0, Math.floor(Number(mins.value) || 0));
    return Math.round(hv * 60) + mv;
  }
  function set(total) {
    const v = Math.max(0, Math.round(total) || 0);
    hours.value = String(Math.floor(v / 60));
    mins.value = String(v % 60);
    root.classList.toggle('over', v > maxMinutes);
    listeners.forEach(cb => cb(v));
  }
  function normalize() { set(get()); }
  for (const inp of [hours, mins]) {
    inp.addEventListener('input', () => listeners.forEach(cb => cb(get())));
    inp.addEventListener('change', normalize);
    inp.addEventListener('focus', () => inp.select());
  }
  set(value);
  // Petit rebond des chiffres quand la valeur change par les boutons.
  const setAnimated = (total) => { set(total); replay(hours, 'bump'); replay(mins, 'bump'); };
  const valid = () => get() > 0 && get() <= maxMinutes;
  return { root, get, set, setAnimated, valid, maxMinutes, hours, mins, onChange: cb => listeners.push(cb) };
}

// « 2026-11-02T17:24 » pour <input type="datetime-local">, heure locale.
export function toLocalInput(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(str || '');
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}

export function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
