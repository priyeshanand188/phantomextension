/* PHANTOM shared config + pure logic.
 * Loaded by the service worker (importScripts) AND as the first content script,
 * so event definitions and weighting live in exactly one place. No DOM / chrome.* here. */
(function (root) {
  'use strict';

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  const DEFAULT_SETTINGS = {
    enabled: false,          // nothing happens until the user turns it on
    intensity: 'medium',     // low | medium | high
    sound: false,            // separate opt-in
    frequency: 4,            // 1 (rare) .. 10 (often)
    cooldownSec: 90,         // minimum gap between any two events
    jumpscareCooldownMin: 8, // minimum gap between jumpscares
    maxDurationSec: 4,       // hard cap for any single event
    escalation: true,        // false = freeze at the current stage
    demoMode: false
  };

  const DEFAULT_PROGRESS = {
    eventsFired: 0, stage: 1, lastEventAt: 0, lastJumpscareAt: 0,
    cooldownUntil: 0, lastIds: []
  };

  // Escalation is bounded: 3 stages, thresholds in events, interval multiplier never < 0.7,
  // and MIN_DELAY_MS is an absolute floor no setting can undercut.
  const STAGES = {
    names: { 1: 'Anomaly', 2: 'Contact', 3: 'Breach' },
    thresholds: { 2: 5, 3: 14 },
    intervalMult: { 1: 1, 2: 0.85, 3: 0.7 }
  };
  const MIN_DELAY_MS = 45 * 1000;

  // visual = overlay strength, dur = duration multiplier, vol = audio volume, jump = jumpscare weight multiplier
  const INTENSITY = {
    low:    { visual: 0.5, dur: 0.75, vol: 0.35, jump: 0 },
    medium: { visual: 0.8, dur: 1.0,  vol: 0.6,  jump: 1 },
    high:   { visual: 1.0, dur: 1.2,  vol: 0.85, jump: 1.8 }
  };

  // min = first stage the event can appear in, w = relative weight, dur = base ms, fake = harmless suspense-only event.
  // Subtle events carry most of the weight, so jumpscares land around ~4-7% of stage-3 events.
  const EVENTS = [
    { id: 'vignette_pulse',  cat: 'whisper',   fake: true,  min: 1, w: 30, dur: 2200, sound: 'heartbeat' },
    { id: 'faint_shadow',    cat: 'whisper',   fake: true,  min: 1, w: 26, dur: 1700 },
    { id: 'static_blip',     cat: 'glitch',    fake: true,  min: 1, w: 22, dur: 380 },
    { id: 'whisper_text',    cat: 'whisper',               min: 2, w: 30, dur: 3300 },
    { id: 'eyes_in_dark',    cat: 'whisper',               min: 2, w: 14, dur: 2700 },
    { id: 'watcher_glimpse', cat: 'glitch',                min: 2, w: 20, dur: 1200, sound: 'static' },
    { id: 'false_lunge',     cat: 'glitch',    fake: true,  min: 3, w: 10, dur: 2400, sound: 'heartbeat' },
    { id: 'text_corruption', cat: 'glitch',                min: 3, w: 16, dur: 2700 },
    { id: 'signal_loss',     cat: 'glitch',                min: 3, w: 14, dur: 2200, sound: 'static' },
    { id: 'watcher_scare',   cat: 'jumpscare',             min: 3, w: 7,  dur: 1500, sound: 'scare' },
    { id: 'watcher_lunge',   cat: 'jumpscare',             min: 3, w: 5,  dur: 1300, sound: 'scare' }
  ];
  const EVENT_BY_ID = Object.fromEntries(EVENTS.map(e => [e.id, e]));

  const MESSAGES = [
    "you're not alone", 'keep still', "it's behind the tab", "don't look away",
    'you blinked', 'it is patient', 'look closer', 'the watcher was here',
    'someone is reading over your shoulder', 'stay in the light', 'it likes this page',
    'scroll slower', 'quiet now'
  ];

  function computeStage(progress, settings) {
    if (!settings.escalation) return clamp(progress.stage || 1, 1, 3);
    const n = progress.eventsFired || 0;
    return n >= STAGES.thresholds[3] ? 3 : n >= STAGES.thresholds[2] ? 2 : 1;
  }

  // mean interval: frequency 1 -> ~16 min, 10 -> ~2 min, then stage multiplier and +/-40% jitter
  function nextDelayMs(settings, stage, rng) {
    rng = rng || Math.random;
    const f = clamp(Number(settings.frequency) || 4, 1, 10);
    const meanMs = (16 - (f - 1) * (14 / 9)) * 60000 * (STAGES.intervalMult[stage] || 1);
    const delay = meanMs * (0.6 + rng() * 0.8);
    return Math.max(MIN_DELAY_MS, delay, (settings.cooldownSec || 0) * 1000);
  }

  /* Weighted random choice.
   * opts: { stage, intensity, jumpscareAllowed, exclude:[ids], category, force, rng }
   * force = demo/test: ignore stage gate, intensity gate and jumpscare cooldown. */
  function pickEvent(opts) {
    const rng = opts.rng || Math.random;
    const inten = INTENSITY[opts.intensity] || INTENSITY.medium;
    const exclude = new Set(opts.exclude || []);
    const build = (honourExclude) => EVENTS.map(e => {
      if (opts.category && e.cat !== opts.category) return { e, w: 0 };
      if (honourExclude && exclude.has(e.id)) return { e, w: 0 };
      if (!opts.force && e.min > (opts.stage || 1)) return { e, w: 0 };
      let w = e.w;
      if (e.cat === 'jumpscare') {
        if (!opts.force && !opts.jumpscareAllowed) return { e, w: 0 };
        w *= opts.force ? 1 : inten.jump;
      }
      return { e, w };
    });
    let pool = build(true);
    if (pool.reduce((s, x) => s + x.w, 0) <= 0) pool = build(false); // never starve
    const total = pool.reduce((s, x) => s + x.w, 0);
    if (total <= 0) return null;
    let r = rng() * total;
    for (const x of pool) { if ((r -= x.w) < 0 && x.w > 0) return x.e; }
    return pool.filter(x => x.w > 0).pop().e;
  }

  // Pages PHANTOM never runs on, no matter what: browser internals, stores, non-web schemes.
  function isRestrictedUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return true;
      if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
      if (u.hostname === 'chromewebstore.google.com') return true;
      return false;
    } catch (e) { return true; }
  }

  // Sign-in, payment and account-security pages are skipped even on haunted sites.
  const SENSITIVE_PATH = /(^|[\/._-])(checkout|payment|payments|billing|pay|login|log-in|signin|sign-in|signup|sign-up|password|2fa|mfa|banking|wallet|secure|verify|oauth|authorize)([\/._?#-]|$)/i;
  const SENSITIVE_HOST = /(^|\.)(accounts\.google\.com|paypal\.com|stripe\.com|checkout\.|secure\.|login\.|bank)/i;
  function isSensitiveUrl(url) {
    try {
      const u = new URL(url);
      return SENSITIVE_HOST.test(u.hostname) || SENSITIVE_PATH.test(u.pathname);
    } catch (e) { return true; }
  }

  root.PHANTOM_SHARED = {
    clamp, DEFAULT_SETTINGS, DEFAULT_PROGRESS, STAGES, MIN_DELAY_MS, INTENSITY,
    EVENTS, EVENT_BY_ID, MESSAGES, computeStage, nextDelayMs, pickEvent,
    isRestrictedUrl, isSensitiveUrl
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
