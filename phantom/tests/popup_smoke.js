/* Popup smoke test (jsdom + mocked chrome.*). Run: node popup_smoke.js */
const path = require('path'); const { JSDOM } = require('jsdom');
let pass = 0, fail = 0; const ok = (c, n, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x ? ' -> ' + x : ''))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const store = {}, sentMsgs = [], requested = []; let granted = [];
  const L = { storage: [], add: [], rem: [] };
  const chrome = {
    storage: { local: { get: async (k) => { const r = {}; k.forEach((x) => { if (x in store) r[x] = JSON.parse(JSON.stringify(store[x])); }); return r; },
      set: async (o) => { const ch = {}; for (const k in o) { ch[k] = { oldValue: store[k], newValue: o[k] }; store[k] = JSON.parse(JSON.stringify(o[k])); } L.storage.forEach((f) => f(ch, 'local')); } },
      onChanged: { addListener: (f) => L.storage.push(f) } },
    permissions: { getAll: async () => ({ origins: granted }), contains: async ({ origins }) => granted.includes(origins[0]),
      request: async ({ origins }) => { requested.push(origins[0]); granted.push(origins[0]); return true; },
      onAdded: { addListener: (f) => L.add.push(f) }, onRemoved: { addListener: (f) => L.rem.push(f) } },
    tabs: { query: async () => [{ id: 1, url: 'https://www.youtube.com/watch?v=abc' }] },
    runtime: { sendMessage: async (m) => { sentMsgs.push(m); if (m.type === 'REMOVE_SITE') { granted = granted.filter((g) => g !== m.pattern); } return { ok: true, id: 'x' }; } }
  };
  const errs = [];
  const dom = await JSDOM.fromFile(path.join(__dirname, '..', 'popup.html'), { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) { w.chrome = chrome; w.close = () => { w.__closed = true; }; w.addEventListener('error', (e) => errs.push(e.message)); } });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  await sleep(400);
  ok(errs.length === 0, 'popup loads with no script errors', errs.join(';'));
  ok($('enabled').checked === false && $('statusText').textContent === 'Dormant', 'starts disabled / dormant (explicit opt-in)');
  ok($('stageName').textContent === '1 · Anomaly', 'shows current stage');
  ok($('demoPanel').hidden && $('demoBadge').hidden, 'demo controls hidden by default');

  $('enabled').click(); await sleep(50);
  ok(store.settings.enabled === true && $('statusText').textContent !== 'Dormant', 'master toggle persists to storage and updates status');
  w.document.querySelector('#intensity [data-v="high"]').click(); await sleep(50);
  ok(store.settings.intensity === 'high' && w.document.querySelector('#intensity [data-v="high"]').getAttribute('aria-checked') === 'true', 'intensity selection persists');
  $('sound').click(); await sleep(50); ok(store.settings.sound === true, 'sound toggle persists (separate from master)');
  $('frequency').value = 9; $('frequency').dispatchEvent(new w.Event('change')); await sleep(50);
  ok(store.settings.frequency === 9, 'frequency slider persists');
  $('escalation').click(); await sleep(50); ok(store.settings.escalation === false && /frozen/.test($('stageHint').textContent), 'escalation can be disabled');

  ok($('siteName').textContent === 'www.youtube.com' && $('siteBtn').textContent === 'Haunt this site', 'shows the current site with a Haunt button');
  $('siteBtn').click(); await sleep(60);
  ok(requested[0] === 'https://www.youtube.com/*', 'Haunt asks for permission on exactly this origin only', requested[0]);
  ok($('siteBtn').textContent === 'Release site' && $('siteList').textContent.includes('www.youtube.com'), 'site list + button update after grant');
  $('siteBtn').click(); await sleep(60);
  ok(sentMsgs.some((m) => m.type === 'REMOVE_SITE'), 'Release removes the permission');

  $('test').click(); await sleep(60);
  ok(sentMsgs.some((m) => m.type === 'TEST' && m.kind === 'any'), 'Test scare sends a TEST message');

  $('demoMode').click(); await sleep(50);
  ok(!$('demoPanel').hidden && !$('demoBadge').hidden && /Demo mode/i.test($('demoBadge').textContent), 'demo mode shows panel + clear DEMO badge');
  const kinds = []; w.document.querySelectorAll('[data-demo]').forEach((b) => { b.click(); kinds.push(b.dataset.demo); }); await sleep(80);
  ['whisper', 'glitch', 'jumpscare', 'escalation'].forEach((k) => ok(sentMsgs.some((m) => m.type === 'TEST' && m.kind === k), 'demo button -> ' + k));
  $('reset').click(); await sleep(40); ok(sentMsgs.some((m) => m.type === 'RESET_PROGRESS'), 'reset progression sends message');
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
