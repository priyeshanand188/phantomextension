/* PHANTOM service worker (Manifest V3).
 *
 * Scheduling model — the service worker holds NO state in memory that matters:
 *   storage.local.schedule.nextAt  = when the next event is due (source of truth)
 *   chrome.alarms "phantom-next"   = the wake-up that fires at nextAt
 * Every time the worker starts (top-level call at the bottom, onStartup, onInstalled)
 * ensureScheduled() re-creates the alarm from storage if it went missing. Nothing polls.
 *
 * Haunted sites == optional host permissions the user granted. There is no separate list
 * to drift out of sync: permissions.getAll() is the truth, content scripts are registered from it.
 */
importScripts('shared.js');
const S = globalThis.PHANTOM_SHARED;
const ALARM = 'phantom-next';
const RETRY_MIN_MS = 60 * 1000, RETRY_MAX_MS = 4 * 60 * 1000;

/* ---------- tiny helpers ---------- */
let chain = Promise.resolve();
// Serialise state-changing work so an alarm tick and a popup message can't interleave.
function locked(fn) {
  const p = chain.catch(() => {}).then(fn);
  chain = p;
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

async function load() {
  const d = await chrome.storage.local.get(['settings', 'progress', 'schedule']);
  return {
    settings: { ...S.DEFAULT_SETTINGS, ...(d.settings || {}) },
    progress: { ...S.DEFAULT_PROGRESS, ...(d.progress || {}) },
    schedule: { nextAt: 0, ...(d.schedule || {}) }
  };
}

const runOpts = (s) => ({ intensity: s.intensity, sound: !!s.sound, maxDurationMs: s.maxDurationSec * 1000 });

/* ---------- scheduler ---------- */
async function scheduleAt(at) {
  at = Math.max(at, Date.now() + 1500);
  await chrome.storage.local.set({ schedule: { nextAt: at } });
  await chrome.alarms.create(ALARM, { when: at });
}

async function ensureScheduled(force = false) {
  const { settings, progress, schedule } = await load();
  if (!settings.enabled) {
    await chrome.alarms.clear(ALARM);
    if (schedule.nextAt) await chrome.storage.local.set({ schedule: { nextAt: 0 } });
    return;
  }
  const now = Date.now();
  if (!force) {
    const alarm = await chrome.alarms.get(ALARM);
    if (alarm && schedule.nextAt && Math.abs(alarm.scheduledTime - schedule.nextAt) < 2000) return; // healthy
    if (schedule.nextAt > now + 1000) return scheduleAt(schedule.nextAt); // alarm lost, time still valid
  }
  const stage = S.computeStage(progress, settings);
  await scheduleAt(Math.max(now + S.nextDelayMs(settings, stage), progress.cooldownUntil || 0));
}

async function findTarget() {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win || !win.focused) return null;                          // user isn't looking at Chrome
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab || !tab.id || !tab.url) return null;                   // url is hidden for sites we have no access to
  if (S.isRestrictedUrl(tab.url) || S.isSensitiveUrl(tab.url)) return null;
  const granted = await chrome.permissions.contains({ origins: [new URL(tab.url).origin + '/*'] });
  return granted ? tab : null;
}

async function deliver(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    try { // content script not present yet (tab predates the grant, or extension was reloaded)
      await chrome.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'content.js'] });
      await sleep(150);
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e2) {
      return { ok: false, reason: 'no-access' };
    }
  }
}

async function onTick() {
  const st = await load();
  if (!st.settings.enabled) return;
  const now = Date.now();
  const stage = S.computeStage(st.progress, st.settings);
  const fullDelay = () => now + S.nextDelayMs(st.settings, stage);

  if (now < (st.progress.cooldownUntil || 0)) {                    // cooldown still running
    return scheduleAt(st.progress.cooldownUntil + rand(5000, 20000));
  }

  const tab = await findTarget();
  if (!tab) {                                                      // nothing eligible: try again soon, not at full interval
    const { origins = [] } = await chrome.permissions.getAll();
    const retry = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, S.nextDelayMs(st.settings, stage) / 4));
    return scheduleAt(origins.length ? now + retry : fullDelay());
  }

  const jumpscareAllowed =
    now - (st.progress.lastJumpscareAt || 0) >= st.settings.jumpscareCooldownMin * 60000;
  const def = S.pickEvent({
    stage, intensity: st.settings.intensity, jumpscareAllowed, exclude: st.progress.lastIds
  });
  if (!def) return scheduleAt(fullDelay());

  const res = await deliver(tab.id, { type: 'RUN_EVENT', id: def.id, forced: false, opts: runOpts(st.settings) });
  if (res && res.ok) {
    const p = { ...st.progress };
    p.eventsFired += 1;
    p.lastEventAt = now;
    p.cooldownUntil = now + st.settings.cooldownSec * 1000 + (res.durationMs || 0);
    p.lastIds = [def.id, ...p.lastIds].slice(0, 3);
    if (def.cat === 'jumpscare') p.lastJumpscareAt = now;
    if (st.settings.escalation) p.stage = S.computeStage(p, st.settings);
    await chrome.storage.local.set({ progress: p });
    return scheduleAt(Math.max(fullDelay(), p.cooldownUntil));
  }
  // Content script declined (typing, sensitive form, busy...). Short retry; nothing is counted.
  return scheduleAt(now + rand(RETRY_MIN_MS, RETRY_MAX_MS));
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) locked(onTick).catch(console.warn); });

/* ---------- haunted sites = granted optional host permissions ---------- */
function scriptId(origin) {
  let h = 0;
  for (let i = 0; i < origin.length; i++) h = (Math.imul(31, h) + origin.charCodeAt(i)) | 0;
  return 'phantom-' + (h >>> 0).toString(16);
}

async function syncScripts() {
  try {
    const { origins = [] } = await chrome.permissions.getAll();
    const want = new Map(origins.map((o) => [scriptId(o), o]));
    const have = (await chrome.scripting.getRegisteredContentScripts()).filter((s) => s.id.startsWith('phantom-'));
    const haveIds = new Set(have.map((s) => s.id));
    const stale = have.filter((s) => !want.has(s.id)).map((s) => s.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
    const add = [...want].filter(([id]) => !haveIds.has(id)).map(([id, o]) => ({
      id, matches: [o], js: ['shared.js', 'content.js'], runAt: 'document_idle', persistAcrossSessions: true
    }));
    if (add.length) await chrome.scripting.registerContentScripts(add);
  } catch (e) { console.warn('[phantom] syncScripts', e); }
}

chrome.permissions.onAdded.addListener(() => locked(syncScripts));
chrome.permissions.onRemoved.addListener(() => locked(syncScripts));

/* ---------- lifecycle ---------- */
chrome.runtime.onInstalled.addListener(() => locked(async () => {
  const d = await chrome.storage.local.get(['settings', 'progress']);
  if (!d.settings) await chrome.storage.local.set({ settings: S.DEFAULT_SETTINGS });
  if (!d.progress) await chrome.storage.local.set({ progress: S.DEFAULT_PROGRESS });
  await syncScripts();
  await ensureScheduled();
}));
chrome.runtime.onStartup.addListener(() => locked(async () => { await syncScripts(); await ensureScheduled(); }));

// React only to settings that change timing; progress/schedule writes (ours) must not re-trigger this.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const o = changes.settings.oldValue || {}, n = changes.settings.newValue || {};
  if (o.enabled !== n.enabled || o.frequency !== n.frequency || o.cooldownSec !== n.cooldownSec) {
    locked(() => ensureScheduled(true));
  }
});

/* ---------- popup / demo messages ---------- */
async function handleTest(msg) {
  const { settings, progress } = await load();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id || !tab.url || S.isRestrictedUrl(tab.url)) return { ok: false, reason: 'restricted' };
  const opts = runOpts(settings);
  if (msg.kind === 'escalation') {
    return deliver(tab.id, { type: 'PREVIEW_ESCALATION', opts });
  }
  const category = msg.kind === 'any' ? null : msg.kind;
  const def = S.pickEvent({
    category, force: true, stage: 3, intensity: settings.intensity, exclude: progress.lastIds
  });
  const res = await deliver(tab.id, { type: 'RUN_EVENT', id: def.id, forced: true, opts });
  return { ...res, id: def.id }; // tests never touch progression or cooldowns
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab || sender.id !== chrome.runtime.id || !msg) return; // popup only; never page/content-script input
  if (msg.type === 'TEST') {
    handleTest(msg).then(sendResponse, () => sendResponse({ ok: false, reason: 'error' }));
    return true;
  }
  if (msg.type === 'RESET_PROGRESS') {
    locked(async () => {
      await chrome.storage.local.set({ progress: { ...S.DEFAULT_PROGRESS, lastIds: [] } });
      await ensureScheduled(true);
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'REMOVE_SITE') {
    chrome.permissions.remove({ origins: [msg.pattern] }).then((ok) => sendResponse({ ok }), () => sendResponse({ ok: false }));
    return true;
  }
});

// Runs every time the worker wakes: if the alarm vanished (browser restart, worker restart), rebuild it from storage.
locked(ensureScheduled).catch(console.warn);
