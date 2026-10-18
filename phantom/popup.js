/* PHANTOM popup. Settings persist in chrome.storage.local; the service worker reacts to changes.
 * The popup never polls storage — it re-renders on storage.onChanged and ticks once a second
 * (only while open) to animate the cooldown countdown. */
(() => {
  'use strict';
  const S = globalThis.PHANTOM_SHARED;
  const $ = (id) => document.getElementById(id);
  let st = { settings: { ...S.DEFAULT_SETTINGS }, progress: { ...S.DEFAULT_PROGRESS }, schedule: { nextAt: 0 } };
  let tab = null, pattern = null, haunted = false, grantedOrigins = [];
  let toastTimer = null;

  const PRESETS = [
    { label: 'YouTube', pattern: 'https://www.youtube.com/*' },
    { label: 'itch.io', pattern: 'https://*.itch.io/*' }
  ];

  const REASONS = {
    restricted: "PHANTOM can't run on this page.",
    'no-access': 'No access to this tab. Open the popup on the page itself, or add the site first.',
    'sensitive-page': 'Skipped: sign-in and payment pages are off limits.',
    'sensitive-form': 'Skipped: this page has a password or payment field.',
    typing: 'Skipped: you are typing in a field.',
    hidden: 'The tab is in the background.',
    busy: 'An event is already playing.',
    'render-error': 'The event failed to render.',
    error: 'Something went wrong.'
  };

  function toast(msg, ms = 4000) {
    const t = $('toast');
    t.textContent = msg;
    clearTimeout(toastTimer);
    if (msg) toastTimer = setTimeout(() => { t.textContent = ''; }, ms);
  }

  /* ---------- state ---------- */
  async function load() {
    const d = await chrome.storage.local.get(['settings', 'progress', 'schedule']);
    st = {
      settings: { ...S.DEFAULT_SETTINGS, ...(d.settings || {}) },
      progress: { ...S.DEFAULT_PROGRESS, ...(d.progress || {}) },
      schedule: { nextAt: 0, ...(d.schedule || {}) }
    };
  }
  async function save(patch) {
    st.settings = { ...st.settings, ...patch };
    await chrome.storage.local.set({ settings: st.settings });
    render();
  }

  /* ---------- rendering ---------- */
  const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const fill = (el) => el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');

  function renderStatus() {
    const { settings, progress } = st;
    const left = (progress.cooldownUntil || 0) - Date.now();
    let s = 'off', text = 'Dormant';
    if (settings.enabled) {
      if (left > 0) { s = 'cooldown'; text = 'Cooldown ' + fmt(left); }
      else if (!grantedOrigins.length) { s = 'watching'; text = 'Awake · no sites added'; }
      else { s = 'watching'; text = 'Watching'; }
    }
    $('status').dataset.s = s;
    $('statusText').textContent = text;
  }

  function render() {
    const { settings, progress } = st;
    $('enabled').checked = settings.enabled;
    $('escalation').checked = settings.escalation;
    $('sound').checked = settings.sound;
    $('demoMode').checked = settings.demoMode;
    $('demoBadge').hidden = !settings.demoMode;
    $('demoPanel').hidden = !settings.demoMode;

    document.querySelectorAll('#intensity button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === settings.intensity)));

    for (const id of ['frequency', 'cooldownSec', 'maxDurationSec']) { $(id).value = settings[id]; fill($(id)); }
    const mean = 16 - (settings.frequency - 1) * (14 / 9);
    $('frequencyOut').textContent = '~' + (mean >= 10 ? Math.round(mean) : mean.toFixed(1)) + ' min';
    $('cooldownOut').textContent = settings.cooldownSec >= 60 ? settings.cooldownSec / 60 + ' min' : settings.cooldownSec + ' s';
    $('durOut').textContent = settings.maxDurationSec + ' s';

    const stage = S.computeStage(progress, settings);
    $('stageName').textContent = stage + ' · ' + S.STAGES.names[stage];
    document.querySelectorAll('#pips i').forEach((p, i) => p.classList.toggle('on', i < stage));
    let hint;
    if (!settings.escalation) hint = 'Escalation is off. Stage is frozen.';
    else if (stage < 3) hint = (S.STAGES.thresholds[stage + 1] - progress.eventsFired) + ' more events until stage ' + (stage + 1) + '.';
    else hint = 'Highest stage. Frequency and intensity stay bounded.';
    $('stageHint').textContent = hint;
    renderStatus();
  }

  /* ---------- site access ---------- */
  const hostOf = (p) => p.replace(/^[a-z*]+:\/\//, '').replace(/\/\*$/, '');

  async function renderSites() {
    const all = await chrome.permissions.getAll();
    grantedOrigins = all.origins || [];
    try {
      const t = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = t[0] || null;
    } catch (e) { tab = null; }

    pattern = null; haunted = false;
    let label = 'Not available on this page';
    if (tab && tab.url && !S.isRestrictedUrl(tab.url)) {
      const u = new URL(tab.url);
      pattern = u.origin + '/*';
      label = u.host;
      haunted = await chrome.permissions.contains({ origins: [pattern] });
    }
    $('siteName').textContent = label;
    const btn = $('siteBtn');
    btn.disabled = !pattern;
    btn.textContent = haunted ? 'Release site' : 'Haunt this site';

    const presets = $('presets'); presets.textContent = '';
    for (const p of PRESETS.filter((p) => !grantedOrigins.includes(p.pattern))) {
      const b = document.createElement('button');
      b.className = 'chip'; b.type = 'button'; b.textContent = '+ ' + p.label;
      b.addEventListener('click', () => { chrome.permissions.request({ origins: [p.pattern] }).then(() => renderSites()); });
      presets.appendChild(b);
    }

    const list = $('siteList'); list.textContent = '';
    if (!grantedOrigins.length) {
      const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No sites yet';
      list.appendChild(li);
    }
    for (const o of grantedOrigins) {
      const li = document.createElement('li');
      const s = document.createElement('span'); s.textContent = hostOf(o);
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + hostOf(o));
      x.addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'REMOVE_SITE', pattern: o }); renderSites(); });
      li.append(s, x); list.appendChild(li);
    }
    renderStatus();
  }

  /* ---------- test / demo ---------- */
  async function fire(kind, closeAfter) {
    toast('…', 1500);
    let res;
    try { res = await chrome.runtime.sendMessage({ type: 'TEST', kind }); } catch (e) { res = { ok: false, reason: 'error' }; }
    if (!res || !res.ok) { toast(REASONS[res && res.reason] || REASONS.error); return; }
    toast(kind === 'escalation' ? 'Previewing all three stages. Esc on the page cancels.' : '');
    if (closeAfter) setTimeout(() => window.close(), 150); // get out of the way so the page is visible
  }

  /* ---------- wiring ---------- */
  function bind() {
    $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
    $('escalation').addEventListener('change', (e) => save({ escalation: e.target.checked }));
    $('sound').addEventListener('change', (e) => save({ sound: e.target.checked }));
    $('demoMode').addEventListener('change', (e) => save({ demoMode: e.target.checked }));
    document.querySelectorAll('#intensity button').forEach((b) => b.addEventListener('click', () => save({ intensity: b.dataset.v })));

    for (const id of ['frequency', 'cooldownSec', 'maxDurationSec']) {
      const el = $(id);
      el.addEventListener('input', () => { fill(el); st.settings[id] = Number(el.value); render(); }); // live label
      el.addEventListener('change', () => save({ [id]: Number(el.value) }));                           // persist once on release
    }

    $('reset').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'RESET_PROGRESS' });
      toast('Progression reset to stage 1.');
    });

    $('siteBtn').addEventListener('click', () => {
      if (!pattern) return;
      if (haunted) { chrome.runtime.sendMessage({ type: 'REMOVE_SITE', pattern }).then(renderSites); }
      else { chrome.permissions.request({ origins: [pattern] }).then(renderSites); } // must be called directly in the click
    });

    $('test').addEventListener('click', () => fire('any', true));
    document.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => fire(b.dataset.demo, false)));

    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== 'local') return;
      load().then(render);
    });
    chrome.permissions.onAdded.addListener(renderSites);
    chrome.permissions.onRemoved.addListener(renderSites);
    setInterval(renderStatus, 1000);
  }

  (async () => {
    await load();
    bind();
    render();
    renderSites();
  })();
})();
