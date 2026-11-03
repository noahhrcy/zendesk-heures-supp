/* Mini-framework de test : affiche les résultats dans la page.
   La dernière ligne « RÉSULTAT : x réussis, y échoués » est lue par les
   outils de vérification. */
const results = [];
let currentGroup = '';

export function group(name) { currentGroup = name; }

export function test(name, fn) {
  try {
    fn();
    results.push({ ok: true, name: `${currentGroup} › ${name}` });
  } catch (err) {
    results.push({ ok: false, name: `${currentGroup} › ${name}`, err: err && err.message || String(err) });
  }
}

export async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name: `${currentGroup} › ${name}` });
  } catch (err) {
    results.push({ ok: false, name: `${currentGroup} › ${name}`, err: err && err.message || String(err) });
  }
}

function show(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

export function eq(actual, expected, msg) {
  const ok = Number.isNaN(expected) ? Number.isNaN(actual) : show(actual) === show(expected);
  if (!ok) throw new Error(`${msg ? msg + ' : ' : ''}obtenu ${show(actual)}, attendu ${show(expected)}`);
}

export function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'condition fausse');
}

export function report() {
  const out = document.getElementById('out');
  const failed = results.filter(r => !r.ok);
  for (const r of results) {
    const li = document.createElement('li');
    li.className = r.ok ? 'ok' : 'ko';
    li.textContent = (r.ok ? '✔ ' : '✘ ') + r.name + (r.ok ? '' : ' — ' + r.err);
    out.append(li);
  }
  const sum = document.getElementById('summary');
  sum.textContent = `RÉSULTAT : ${results.length - failed.length} réussis, ${failed.length} échoués`;
  sum.className = failed.length ? 'ko' : 'ok';
  window.__testResults = { passed: results.length - failed.length, failed: failed.map(f => f.name + ' — ' + f.err) };
}
