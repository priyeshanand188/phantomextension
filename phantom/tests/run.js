/* PHANTOM offline test harness.  Run:  cd tests && npm install && node run.js
 *
 * What this covers: manifest sanity, weighted selection, escalation bounds, scheduler behaviour
 * (against a MOCKED chrome.* API), and event render/cleanup (against jsdom).
 * What it cannot cover: real Chrome behaviour, real service-worker eviction, real audio, real
 * permission prompts, YouTube. Those are manual steps in the README. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); } };
const section = (n) => console.log('\n' + n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 1. manifest */
section('manifest');
const mf = JSON.parse(read('manifest.json'));
ok(mf.manifest_version === 3, 'manifest_version is 3');
ok(mf.background && mf.background.service_worker === 'background.js' && !mf.background.persistent, 'service worker, no persistent page');
ok(!mf.host_permissions && !(mf.content_scripts || []).length, 'no static host access / static content scripts');
ok(!mf.permissions.includes('tabs') && !mf.permissions.includes('history') && !mf.permissions.includes('webRequest'), 'no tabs/history/webRequest permission');
const files = [mf.background.service_worker, mf.action.default_popup, ...Object.values(mf.icons), ...Object.values(mf.action.default_icon), 'shared.js', 'content.js', 'popup.js', 'popup.css'];
files.forEach((f) => ok(fs.existsSync(path.join(ROOT, f)), 'file exists: ' + f));
const S = (() => { const c = { URL }; vm.runInNewContext(read('shared.js'), c); return vm.runInNewContext('globalThis.PHANTOM_SHARED', c); })();
S.EVENTS.forEach((e) => {
  if (e.sound) ok(fs.existsSync(path.join(ROOT, 'assets/audio', e.sound + '.wav')), `audio for ${e.id}: ${e.sound}.wav`);
});
for (let i = 1; i <= 5; i++) ok(fs.existsSync(path.join(ROOT, `assets/images/watcher-${i}.svg`)) && fs.existsSync(path.join(ROOT, `assets/images/watcher-face-${i}.svg`)), `watcher variant ${i} (figure + face)`);
ok(!/https?:\/\/(?!www\.w3\.org)/.test(['background.js', 'content.js', 'popup.js', 'popup.html', 'shared.js'].map(read).join('\n').replace(/https:\/\/(www\.youtube\.com|\*\.itch\.io|\*\.youtube)[^'"\s]*/g, '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  'no hard-coded remote URLs in source (other than the site-permission presets)');
ok(!/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|eval)\s*\(/.test(['background.js', 'content.js', 'popup.js', 'shared.js'].map(read).join('\n')), 'no fetch/XHR/WebSocket/beacon/eval anywhere');

/* ------------------------------------------------------------------ 2. selection + escalation */
section('weighted selection & escalation');
const tally = (opts, n = 20000) => { const t = {}; for (let i = 0; i < n; i++) { const e = S.pickEvent(opts); t[e.cat] = (t[e.cat] || 0) + 1; t[e.id] = (t[e.id] || 0) + 1; } return t; };
const t1 = tally({ stage: 1, intensity: 'high', jumpscareAllowed: true });
ok(!t1.jumpscare && !t1.text_corruption && !t1.whisper_text, 'stage 1: only subtle anomalies');
const t2 = tally({ stage: 2, intensity: 'high', jumpscareAllowed: true });
ok(!t2.jumpscare && t2.whisper_text > 0 && t2.watcher_glimpse > 0, 'stage 2: messages + Watcher glimpses, still no jumpscares');
const t3 = tally({ stage: 3, intensity: 'medium', jumpscareAllowed: true });
const js3 = (t3.jumpscare || 0) / 20000, js3h = (tally({ stage: 3, intensity: 'high', jumpscareAllowed: true }).jumpscare || 0) / 20000;
ok(js3 > 0.02 && js3 < 0.12, `stage 3 medium: jumpscares are rare (${(js3 * 100).toFixed(1)}%)`);
ok(js3h > js3 && js3h < 0.2, `stage 3 high: more, still bounded (${(js3h * 100).toFixed(1)}%)`);
ok((tally({ stage: 3, intensity: 'low', jumpscareAllowed: true }).jumpscare || 0) === 0, 'low intensity: zero jumpscares');
ok((tally({ stage: 3, intensity: 'high', jumpscareAllowed: false }).jumpscare || 0) === 0, 'jumpscare cooldown blocks jumpscares');
ok(((t3.vignette_pulse + t3.faint_shadow + t3.static_blip + t3.false_lunge) / 20000) > 0.3, 'fake-outs are a large share of stage-3 events');
let rep = 0; for (let i = 0; i < 2000; i++) { if (S.pickEvent({ stage: 3, intensity: 'medium', jumpscareAllowed: true, exclude: ['vignette_pulse', 'faint_shadow'] }).id.match(/^(vignette_pulse|faint_shadow)$/)) rep++; }
ok(rep === 0, 'recently used events are excluded');
ok(S.pickEvent({ category: 'jumpscare', force: true, stage: 1, intensity: 'low' }).cat === 'jumpscare', 'demo/test force bypasses stage + intensity gates');
ok(S.pickEvent({ stage: 1, intensity: 'low', jumpscareAllowed: false, exclude: S.EVENTS.map((e) => e.id) }), 'selection never starves when everything is excluded');
let minD = Infinity, maxD = 0;
for (let f = 1; f <= 10; f++) for (const stage of [1, 2, 3]) for (let i = 0; i < 200; i++) { const d = S.nextDelayMs({ frequency: f, cooldownSec: 30 }, stage); minD = Math.min(minD, d); maxD = Math.max(maxD, d); }
ok(minD >= S.MIN_DELAY_MS, `delay floor holds at max frequency/stage (min ${Math.round(minD / 1000)}s)`);
ok(maxD < 30 * 60000, `delay ceiling is sane (max ${(maxD / 60000).toFixed(1)} min)`);
ok(S.nextDelayMs({ frequency: 10, cooldownSec: 600 }, 3) >= 600000, 'delay never undercuts the configured cooldown');
ok(S.computeStage({ eventsFired: 0, stage: 1 }, { escalation: true }) === 1 && S.computeStage({ eventsFired: 5 }, { escalation: true }) === 2 && S.computeStage({ eventsFired: 999 }, { escalation: true }) === 3, 'stage thresholds 1/2/3, capped at 3');
ok(S.computeStage({ eventsFired: 999, stage: 2 }, { escalation: false }) === 2, 'escalation off freezes the stage');
ok(S.isRestrictedUrl('chrome://extensions') && S.isRestrictedUrl('chrome-extension://abc/popup.html') && S.isRestrictedUrl('about:blank') && S.isRestrictedUrl('https://chromewebstore.google.com/') && !S.isRestrictedUrl('https://www.youtube.com/'), 'restricted URL detection');
ok(S.isSensitiveUrl('https://shop.example.com/checkout') && S.isSensitiveUrl('https://accounts.google.com/signin') && S.isSensitiveUrl('https://x.com/login') && !S.isSensitiveUrl('https://www.youtube.com/watch?v=abc'), 'sensitive URL detection');

/* ------------------------------------------------------------------ 3. background scheduler (mocked chrome) */
function bootBackground(store, alarms, o) {
  const L = { alarm: [], msg: [], storage: [], misc: [] };
  const sent = [];
  const chrome = {
    storage: {
      local: {
        get: async (keys) => { const r = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) r[k] = JSON.parse(JSON.stringify(store[k])); }); return r; },
        set: async (obj) => { const ch = {}; for (const k in obj) ch[k] = { oldValue: store[k], newValue: JSON.parse(JSON.stringify(obj[k])) }; for (const k in obj) store[k] = JSON.parse(JSON.stringify(obj[k])); L.storage.forEach((f) => f(ch, 'local')); }
      },
      onChanged: { addListener: (f) => L.storage.push(f) }
    },
    alarms: {
      create: async (n, i) => { alarms[n] = { name: n, scheduledTime: i.when }; }, get: async (n) => alarms[n], clear: async (n) => { delete alarms[n]; return true; },
      onAlarm: { addListener: (f) => L.alarm.push(f) }
    },
    windows: { getLastFocused: async () => ({ id: 1, focused: o.focused !== false }) },
    tabs: { query: async () => [o.tab], sendMessage: async (id, m) => { sent.push(m); return o.reply(m); } },
    permissions: {
      contains: async () => o.granted !== false, getAll: async () => ({ origins: o.origins || ['https://www.youtube.com/*'] }), remove: async () => true,
      onAdded: { addListener: (f) => L.misc.push(f) }, onRemoved: { addListener: (f) => L.misc.push(f) }
    },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, executeScript: async () => {} },
    runtime: { id: 'x', onInstalled: { addListener: (f) => L.misc.push(f) }, onStartup: { addListener: (f) => L.misc.push(f) }, onMessage: { addListener: (f) => L.msg.push(f) } }
  };
  const ctx = vm.createContext({ chrome, console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON, Object, Array, Map, Set, Error, Number, String, Boolean });
  ctx.importScripts = (f) => vm.runInContext(read(f), ctx);
  vm.runInContext(read('background.js'), ctx);
  return { chrome, L, sent, tick: async () => { L.alarm.forEach((f) => f({ name: 'phantom-next' })); await sleep(60); }, message: (m, sender) => new Promise((res) => { const r = L.msg[0](m, sender || { id: 'x' }, res); if (r !== true) setTimeout(() => res('__no_response__'), 40); }) };
}

(async () => {
  section('scheduler (mocked chrome.*)');
  const store = {}, alarms = {};
  const o = { tab: { id: 7, url: 'https://www.youtube.com/watch?v=abc' }, reply: () => ({ ok: true, durationMs: 1500 }) };
  let bg = bootBackground(store, alarms, o); await sleep(60);
  ok(!alarms['phantom-next'], 'nothing is scheduled while PHANTOM is disabled');

  await bg.chrome.storage.local.set({ settings: { ...S.DEFAULT_SETTINGS, enabled: true } }); await sleep(60);
  const a1 = alarms['phantom-next'];
  ok(a1 && a1.scheduledTime >= Date.now() + S.MIN_DELAY_MS - 2000, 'enabling schedules one alarm in the future', a1 && (a1.scheduledTime - Date.now()));
  ok(store.schedule.nextAt === a1.scheduledTime, 'schedule is persisted in storage (survives worker restart)');

  const savedAt = store.schedule.nextAt;
  for (const k in alarms) delete alarms[k];                                  // browser/worker restart wipes alarms
  bg = bootBackground(store, alarms, o); await sleep(80);                     // brand-new worker, same storage
  ok(alarms['phantom-next'] && alarms['phantom-next'].scheduledTime === savedAt, 'restarted worker rebuilds the alarm from storage at the same time');

  store.schedule.nextAt = Date.now() - 5000; for (const k in alarms) delete alarms[k];
  bg = bootBackground(store, alarms, o); await sleep(80);
  ok(alarms['phantom-next'] && alarms['phantom-next'].scheduledTime > Date.now(), 'a missed/stale schedule is replaced with a fresh future one');

  await bg.tick();
  ok(bg.sent.length === 1 && bg.sent[0].type === 'RUN_EVENT', 'alarm tick on an eligible tab delivers one event');
  const first = S.EVENT_BY_ID[bg.sent[0].id];
  ok(first && first.min === 1 && first.cat !== 'jumpscare', `first events are stage-1 subtle (${bg.sent[0].id})`);
  ok(store.progress.eventsFired === 1 && store.progress.cooldownUntil > Date.now() + 80000, 'progress + cooldown recorded');
  ok(alarms['phantom-next'].scheduledTime >= store.progress.cooldownUntil, 'next alarm never lands inside the cooldown');

  const n = bg.sent.length; await bg.tick();
  ok(bg.sent.length === n, 'tick during cooldown sends nothing (no spam)');
  ok(alarms['phantom-next'].scheduledTime >= store.progress.cooldownUntil, 'cooldown tick reschedules after the cooldown');

  store.progress.cooldownUntil = 0;
  o.tab = { id: 7, url: 'chrome://extensions' }; await bg.tick();
  ok(bg.sent.length === n, 'restricted page: nothing sent');
  const wait = alarms['phantom-next'].scheduledTime - Date.now();
  ok(wait >= 55000 && wait <= 250000, `restricted page: short retry, not a full interval (${Math.round(wait / 1000)}s)`);
  o.tab = { id: 7, url: 'https://www.youtube.com/login' }; await bg.tick();
  ok(bg.sent.length === n, 'sensitive URL on a haunted site: nothing sent');
  o.tab = { id: 7, url: 'https://example.org/' }; o.granted = false; await bg.tick();
  ok(bg.sent.length === n, 'site the user did not add: nothing sent'); o.granted = true;
  o.tab = { id: 7, url: 'https://www.youtube.com/watch?v=abc' }; o.focused = false; await bg.tick();
  ok(bg.sent.length === n, 'browser not focused: nothing sent'); o.focused = true;

  o.reply = () => ({ ok: false, reason: 'typing' }); const ev = store.progress.eventsFired; await bg.tick();
  ok(bg.sent.length === n + 1 && store.progress.eventsFired === ev, 'page declined (typing): not counted toward progression');
  o.reply = () => ({ ok: true, durationMs: 1000 });

  const before = JSON.stringify(store.progress);
  const res = await bg.message({ type: 'TEST', kind: 'jumpscare' });
  ok(res.ok && S.EVENT_BY_ID[res.id].cat === 'jumpscare', 'TEST forces a jumpscare on demand');
  ok(JSON.stringify(store.progress) === before, 'TEST leaves progression and cooldown untouched');
  ok((await bg.message({ type: 'TEST', kind: 'escalation' })).ok, 'preview escalation message delivered');
  ok((await bg.message({ type: 'TEST', kind: 'whisper' })).id && S.EVENT_BY_ID[bg.sent[bg.sent.length - 1].id].cat === 'whisper', 'demo whisper picks a whisper-category event');
  ok((await bg.message({ type: 'TEST', kind: 'x' }, { id: 'x', tab: { id: 1 } })) === '__no_response__', 'messages from content scripts are ignored');
  ok((await bg.message({ type: 'TEST', kind: 'x' }, { id: 'evil' })) === '__no_response__', 'messages from other extensions are ignored');
  await bg.message({ type: 'RESET_PROGRESS' });
  ok(store.progress.eventsFired === 0 && store.progress.stage === 1, 'reset progression');

  await bg.chrome.storage.local.set({ settings: { ...store.settings, enabled: false } }); await sleep(60);
  ok(!alarms['phantom-next'] && store.schedule.nextAt === 0, 'master switch off clears the alarm');
  const m0 = bg.sent.length; await bg.tick();
  ok(bg.sent.length === m0, 'a stray alarm while disabled does nothing');

  await contentTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

/* ------------------------------------------------------------------ 4. content script (jsdom) */
async function contentTests() {
  section('content script render + cleanup (jsdom, fake timers)');
  const html = '<!doctype html><body><h1>Headline text that is long</h1><p>Some paragraph content for the corruption event to chew on.</p><p>Another paragraph of readable text on the page.</p><input id="q"></body>';
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://www.youtube.com/watch?v=abc' });
  const w = dom.window;

  // manual clock
  let now = 0, id = 0; const T = new Map();
  w.setTimeout = (f, ms) => { T.set(++id, { f, at: now + (ms || 0), iv: 0 }); return id; };
  w.setInterval = (f, ms) => { T.set(++id, { f, at: now + ms, iv: ms }); return id; };
  w.clearTimeout = w.clearInterval = (i) => { T.delete(i); };
  const advance = (ms) => { const end = now + ms; for (;;) { let nx = null, nk = null; for (const [k, t] of T) if (t.at <= end && (!nx || t.at < nx.at)) { nx = t; nk = k; } if (!nx) break; now = nx.at; if (nx.iv) nx.at += nx.iv; else T.delete(nk); nx.f(); } now = end; };

  const audio = []; w.Audio = class { constructor(src) { this.src = src; this.paused = false; audio.push(this); } play() { return Promise.resolve(); } pause() { this.paused = true; } removeAttribute() {} load() {} };
  w.matchMedia = () => ({ matches: false });
  w.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 24, top: 40, bottom: 64, left: 0, right: 300 });
  const hosts = []; const orig = w.Element.prototype.attachShadow; w.Element.prototype.attachShadow = function (i) { const r = orig.call(this, { ...i, mode: 'open' }); hosts.push(this); return r; };
  const listeners = []; w.chrome = { runtime: { id: 'x', getURL: (p) => 'chrome-extension://x/' + p, onMessage: { addListener: (f) => listeners.push(f), removeListener() {} } } };
  w.eval(read('shared.js')); w.eval(read('content.js'));
  const P = w.__phantom, doc = w.document;
  const hostEl = () => doc.documentElement.querySelector('div[popover]');
  const opts = { intensity: 'high', sound: true, maxDurationMs: 6000 };

  ok(P && P.alive(), 'content script loads and is alive');
  ok(!hostEl() && T.size === 0, 'idle cost is zero: no overlay, no timers');

  for (const e of S.EVENTS) {
    const before = doc.body.textContent;
    const r = P._runEvent({ id: e.id, forced: true, opts });
    ok(r.ok && hostEl(), `${e.id}: renders`, JSON.stringify(r));
    ok(r.durationMs <= 6000 && r.durationMs > 0, `${e.id}: duration ${r.durationMs}ms within cap`);
    if (e.id === 'text_corruption') { advance(500); ok(doc.body.textContent !== before, 'text_corruption: page text is actually altered mid-event'); }
    advance(r.durationMs + 100);
    ok(!hostEl(), `${e.id}: overlay removed at end`);
    ok(T.size === 0, `${e.id}: no timers left behind`, T.size);
    if (e.id === 'text_corruption') ok(doc.body.textContent === before, 'text_corruption: original text restored exactly');
  }
  ok(audio.length > 0 && audio.every((a) => a.paused), `all ${audio.length} audio elements stopped`);

  let r = P._runEvent({ id: 'watcher_scare', forced: true, opts: { ...opts, maxDurationMs: 1000 } });
  ok(r.durationMs <= 1000, 'max event length setting caps the duration'); advance(2000);

  const n0 = audio.length; r = P._runEvent({ id: 'watcher_scare', forced: true, opts: { ...opts, sound: false } }); advance(2000);
  ok(audio.length === n0, 'sound toggle off: no audio created');

  r = P._runEvent({ id: 'faint_shadow', forced: false, opts }); const r2 = P._runEvent({ id: 'static_blip', forced: false, opts });
  ok(r.ok && !r2.ok && r2.reason === 'busy', 'duplicate prevention: second event refused while one plays'); advance(3000);

  r = P._runEvent({ id: 'watcher_scare', forced: true, opts }); ok(hostEl(), 'jumpscare up');
  doc.defaultView.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(!hostEl() && T.size === 0, 'Escape ends the event instantly and cleans up');

  r = P._runEvent({ id: 'watcher_lunge', forced: true, opts }); hosts.length = 0;
  const bg = [...(hostEl().shadowRoot.querySelectorAll('.hit'))][0]; bg.dispatchEvent(new w.Event('click'));
  ok(!hostEl(), 'clicking a jumpscare dismisses it');

  doc.getElementById('q').focus();
  r = P._runEvent({ id: 'static_blip', forced: false, opts });
  ok(!r.ok && r.reason === 'typing', 'does not fire while the user is typing in a field');
  r = P._runEvent({ id: 'static_blip', forced: true, opts }); ok(r.ok, 'forced (demo) events may fire while a field is focused'); advance(1000);
  doc.getElementById('q').blur();

  const pw = doc.createElement('input'); pw.type = 'password'; doc.body.appendChild(pw);
  r = P._runEvent({ id: 'static_blip', forced: true, opts });
  ok(!r.ok && r.reason === 'sensitive-form' && !hostEl(), 'refuses on pages with a password field, even when forced');
  pw.remove();
  const cc = doc.createElement('input'); cc.setAttribute('autocomplete', 'cc-number'); doc.body.appendChild(cc);
  ok(P._runEvent({ id: 'static_blip', forced: true, opts }).reason === 'sensitive-form', 'refuses on pages with a payment field'); cc.remove();

  // message path + preview
  const sent = []; const send = (m, sender) => new Promise((res) => { const x = listeners[0](m, sender || { id: 'x' }, res); if (x === undefined && !sent.length) setTimeout(() => res('none'), 5); });
  ok((await send({ type: 'RUN_EVENT', id: 'static_blip', forced: true, opts })).ok, 'RUN_EVENT message works'); advance(1000);
  ok((await send({ type: 'RUN_EVENT', id: 'static_blip', forced: true, opts }, { id: 'other' })) === 'none', 'messages from other extensions ignored'); advance(1000);

  const pv = await send({ type: 'PREVIEW_ESCALATION', opts });
  ok(pv.ok, 'escalation preview starts');
  const seen = new Set(); let guard = 0;
  while ((hostEl() || T.size) && guard++ < 400) { const h = hostEl(); if (h) h.shadowRoot.querySelectorAll('.hud').forEach((x) => seen.add(x.textContent)); advance(250); }
  ok(['STAGE 1 · ANOMALY', 'STAGE 2 · CONTACT', 'STAGE 3 · BREACH'].every((s) => seen.has(s)), 'preview walks through all three stages', [...seen].join('|'));
  ok(!hostEl() && T.size === 0, 'preview finishes fully cleaned up');

  await send({ type: 'PREVIEW_ESCALATION', opts }); advance(1200); P.dispose ? null : null;
  doc.defaultView.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  advance(5000);
  ok(!hostEl() && T.size === 0, 'Escape mid-preview cancels the whole sequence');
}
