/* PHANTOM content script — renders events. It only ever runs on origins the user granted.
 *
 * - Everything lives in ONE closed shadow root on a top-layer popover host, so page CSS can't
 *   touch it and it still draws above fullscreen video. Host is created per event and removed after.
 * - Zero idle cost: no timers, observers or loops exist unless an event is playing.
 * - Every timer / interval / node / audio element is owned by a Run and torn down in Run.end().
 * - Esc, tab-hide, or a click on a jumpscare ends the event immediately. Pages stay clickable
 *   (pointer-events: none) except the jumpscare overlay, which dismisses on click.
 */
(() => {
  'use strict';
  const prev = window.__phantom;
  if (prev && prev.alive()) return;                    // already running in this context
  if (prev && prev.dispose) { try { prev.dispose(); } catch (e) { /* orphaned copy from a reloaded extension */ } }

  const S = globalThis.PHANTOM_SHARED;
  const url = (p) => chrome.runtime.getURL(p);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------ styles */
  const css = (noise) => `
:host{all:initial}
*{box-sizing:border-box}
.ov{position:fixed;inset:0;pointer-events:none}
.hit{pointer-events:auto}
@keyframes fio{0%{opacity:0}12%{opacity:1}80%{opacity:1}100%{opacity:0}}
@keyframes cut{0%{opacity:0}4%{opacity:.97}86%{opacity:.97}100%{opacity:0}}
@keyframes vig{0%{opacity:0}16%{opacity:var(--k)}28%{opacity:calc(var(--k)*.35)}42%{opacity:var(--k)}100%{opacity:0}}
@keyframes sh{0%{opacity:0}35%{opacity:calc(var(--k)*.34)}68%{opacity:calc(var(--k)*.34)}100%{opacity:0}}
@keyframes gl{0%{opacity:0}18%{opacity:calc(var(--k)*.75)}30%{opacity:calc(var(--k)*.2)}46%{opacity:calc(var(--k)*.75)}85%{opacity:calc(var(--k)*.6)}100%{opacity:0}}
@keyframes dimio{0%{opacity:0}45%{opacity:var(--k)}72%{opacity:var(--k)}100%{opacity:0}}
@keyframes ghost{0%{opacity:0;scale:.86}50%{opacity:calc(var(--k)*.36);scale:.95}72%{opacity:calc(var(--k)*.36)}100%{opacity:0;scale:1}}
@keyframes facein{0%{opacity:0;scale:.9}4%{opacity:1;scale:1}85%{opacity:1;scale:1.12}100%{opacity:0;scale:1.14}}
@keyframes lunge{0%{opacity:0;scale:.06}6%{opacity:1;scale:.08}60%{opacity:1;scale:.5}78%{scale:1.1}92%{opacity:1;scale:1.5}100%{opacity:0;scale:1.6}}
@keyframes shake{0%{transform:translate(0,0)}50%{transform:translate(-7px,4px)}100%{transform:translate(6px,-5px)}}
@keyframes blink{0%,28%,38%,64%,74%,100%{transform:scaleY(1)}32%,68%{transform:scaleY(.06)}}
@keyframes jit{0%{background-position:0 0}33%{background-position:-37px 23px}66%{background-position:19px -41px}100%{background-position:-11px 8px}}
@keyframes band{0%{transform:translateX(0)}50%{transform:translateX(-3vw)}100%{transform:translateX(2vw)}}
@keyframes tick{50%{opacity:0}}

.vig{background:radial-gradient(ellipse at center,rgba(0,0,0,0) 34%,rgba(24,0,0,.9) 100%);opacity:0;animation:vig var(--d) ease-in-out both}
.shadow{position:fixed;bottom:-3vh;height:64vh;width:auto;max-width:none;opacity:0;filter:blur(1px) contrast(1.25);animation:sh var(--d) ease-in-out both}
.shadow.l{left:-2vw}.shadow.r{right:-2vw;transform:scaleX(-1)}
.glimpse{position:fixed;bottom:-2vh;width:auto;max-width:none;opacity:0;filter:contrast(1.3);animation:gl var(--d) steps(14) both}
.msg{position:fixed;max-width:min(380px,70vw);padding:9px 14px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.16em;color:#cfcfc6;
  background:rgba(0,0,0,.62);border-left:2px solid #8a1c1c;text-shadow:0 0 7px rgba(170,25,25,.85);opacity:0;animation:fio var(--d) both}
.msg.tl{top:5vh;left:3vw}.msg.tr{top:5vh;right:3vw}.msg.bl{bottom:7vh;left:3vw}.msg.br{bottom:7vh;right:3vw}
.dark{position:fixed;width:36vmin;height:28vmin;background:radial-gradient(closest-side,rgba(0,0,0,.93),rgba(0,0,0,.6) 55%,rgba(0,0,0,0));opacity:0;animation:fio var(--d) both}
.eyepair{position:fixed;width:36vmin;height:28vmin;opacity:var(--k)}
.eye{position:absolute;top:46%;width:15px;height:7px;border-radius:50%;background:#ecebdd;box-shadow:0 0 10px 3px rgba(190,40,40,.5);animation:blink var(--d) ease-in-out both}
.noise{background:url(${noise});opacity:calc(var(--k)*.42);animation:jit .25s steps(3) infinite}
.noise.faint{opacity:calc(var(--k)*.16)}
.scan{background:repeating-linear-gradient(to bottom,rgba(0,0,0,0) 0 2px,rgba(0,0,0,.3) 2px 3px)}
.blip{opacity:0;animation:fio var(--d) steps(4) both}
.sl{opacity:0;animation:fio var(--d) both}
.sl .rgb{position:absolute;inset:0;background:linear-gradient(90deg,rgba(255,0,60,.08),rgba(0,255,255,.05) 60%,rgba(255,0,60,.08))}
.band{position:absolute;left:-4vw;right:-4vw;background:rgba(255,255,255,.07);box-shadow:0 0 0 1px rgba(255,40,40,.14);animation:band .3s steps(4) infinite}
.osd{position:absolute;font:600 17px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.12em;color:#dcdcd2;text-shadow:0 0 5px rgba(255,255,255,.35)}
.osd.a{top:5vh;left:4vw}.osd.b{bottom:6vh;right:4vw}.osd i{font-style:normal;animation:tick 1s steps(1) infinite}
.cutbg{background:#000;opacity:0;animation:cut var(--d) both}
.face{position:fixed;left:50%;top:50%;translate:-50% -50%;height:min(100vh,100vw);width:min(100vh,100vw);opacity:0;animation:facein var(--d) both,shake .09s steps(2) infinite}
.face.lunge{animation:lunge var(--d) cubic-bezier(.7,0,1,.6) both,shake .09s steps(2) infinite}
.dim{background:radial-gradient(ellipse at center,rgba(0,0,0,.2),rgba(0,0,0,.78));opacity:0;animation:dimio var(--d) ease both}
.ghostfig{position:fixed;left:50%;bottom:-2vh;translate:-50% 0;height:72vh;width:auto;max-width:none;opacity:0;filter:blur(2px);animation:ghost var(--d) ease-in-out both}
.hud{position:fixed;left:50%;bottom:5vh;translate:-50% 0;padding:8px 16px;font:600 12px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.3em;
  color:#c43030;background:rgba(0,0,0,.78);border:1px solid #3a0c0c;text-shadow:0 0 8px rgba(196,48,48,.7);opacity:0;animation:fio var(--d) both}
@media (prefers-reduced-motion:reduce){
  .noise,.band,.eye,.osd i{animation:none}
  .face,.face.lunge{animation:fio var(--d) both}
  .glimpse{animation:sh var(--d) ease-in-out both}
  .blip,.sl{animation:fio var(--d) ease both}
}`;

  /* ------------------------------------------------------------------ run lifecycle */
  let host = null, root = null, current = null, sequence = null, lastVariant = 0;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('popover', 'manual'); // top layer: stays above fullscreen video
    host.style.cssText = 'all:initial;display:block;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;' +
      'background:transparent;overflow:hidden;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    const st = document.createElement('style');
    st.textContent = css(url('assets/images/noise.png'));
    root.appendChild(st);
    document.documentElement.appendChild(host);
    try { host.showPopover(); } catch (e) { /* older engines: z-index fallback above */ }
  }

  function teardownHost() {
    if (host) { try { host.hidePopover(); } catch (e) { /* not open */ } host.remove(); }
    host = root = null;
  }

  class Run {
    constructor(id, ctx) {
      Object.assign(this, { id, ctx, d: 0, nodes: [], timers: [], ints: [], cleanups: [], audio: [], dead: false });
    }
    start(d) {
      this.d = d;
      ensureHost();
      this.timers.push(setTimeout(() => this.end(), d + 60));       // natural end
      this.timers.push(setTimeout(() => this.end(), d + 1500));     // failsafe if a renderer misbehaves
      if (this.ctx.hud) this.hud(this.ctx.hud);
    }
    el(tag, cls, props) {
      const n = document.createElement(tag);
      n.className = cls || '';
      n.style.setProperty('--d', this.d + 'ms');
      n.style.setProperty('--k', this.ctx.k);
      if (props) Object.assign(n, props);
      root.appendChild(n);
      this.nodes.push(n);
      return n;
    }
    img(cls, file) {
      const n = this.el('img', cls, { alt: '', draggable: false });
      n.addEventListener('error', () => this.end());                  // never leave a blank dark overlay behind
      n.src = url('assets/images/' + file);
      return n;
    }
    hud(text) { this.el('div', 'hud', { textContent: text }); }
    later(fn, ms) { this.timers.push(setTimeout(() => { if (!this.dead) fn(); }, ms)); }
    every(fn, ms) { const i = setInterval(() => { if (!this.dead) fn(); }, ms); this.ints.push(i); return i; }
    sound(name) {
      if (!this.ctx.sound || !name) return;
      try {                                                            // plain play(): browser autoplay rules are respected, not bypassed
        const a = new Audio(url('assets/audio/' + name + '.wav'));
        a.volume = Math.min(1, ({ scare: 0.9, heartbeat: 0.55, static: 0.4 }[name] || 0.5) * this.ctx.vol);
        this.audio.push(a);
        const p = a.play();
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* no sound is fine */ }
    }
    end() {
      if (this.dead) return;
      this.dead = true;
      this.timers.forEach(clearTimeout);
      this.ints.forEach(clearInterval);
      this.cleanups.forEach((fn) => { try { fn(); } catch (e) { /* best effort */ } });
      this.audio.forEach((a) => { try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* ignore */ } });
      this.nodes.forEach((n) => n.remove());
      if (current === this) { current = null; teardownHost(); detachGuards(); }
      if (this.ctx.onDone) { const f = this.ctx.onDone; this.ctx.onDone = null; f(); }
    }
  }

  /* ------------------------------------------------------------------ user escape hatches */
  const onKey = (e) => { if (e.key === 'Escape') cancelAll(); };
  const onVis = () => { if (document.hidden) cancelAll(); };
  let guarded = false;
  function attachGuards() {
    if (guarded) return; guarded = true;
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', cancelAll);
  }
  function detachGuards() {
    if (!guarded) return; guarded = false;
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', cancelAll);
  }
  function cancelAll() {
    if (sequence) { sequence.cancelled = true; sequence = null; }
    if (current) current.end();
  }

  /* ------------------------------------------------------------------ safety */
  function blocked(forced) {
    if (document.hidden) return 'hidden';
    if (S.isRestrictedUrl(location.href)) return 'restricted';
    if (S.isSensitiveUrl(location.href)) return 'sensitive-page';
    if (document.querySelector('input[type="password"],input[autocomplete^="cc-"],input[autocomplete="one-time-code"],iframe[src*="stripe.com"],iframe[src*="paypal.com"]')) return 'sensitive-form';
    const a = document.activeElement;
    if (!forced && a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return 'typing';
    return null;
  }

  /* ------------------------------------------------------------------ the Watcher helpers */
  function variant() {
    let n; do { n = 1 + Math.floor(Math.random() * 5); } while (n === lastVariant);
    return (lastVariant = n);
  }

  function textNodes(max) {
    const bad = 'script,style,noscript,textarea,input,select,option,code,pre,form,[contenteditable],[contenteditable="true"]';
    const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const t = n.nodeValue;
        if (!t || t.trim().length < 8) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        return p && !p.closest(bad) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const pool = [];
    for (let i = 0; i < 1500 && pool.length < 80; i++) {
      const n = w.nextNode();
      if (!n) break;
      const p = n.parentElement, r = p.getBoundingClientRect();
      if (r.width < 20 || r.height < 8 || r.bottom < 0 || r.top > innerHeight) continue;
      if (p.checkVisibility && !p.checkVisibility()) continue;
      pool.push(n);
    }
    return pool.sort(() => Math.random() - 0.5).slice(0, max);
  }

  /* ------------------------------------------------------------------ events */
  const R = {
    vignette_pulse(r) { r.el('div', 'ov vig'); },

    faint_shadow(r) {
      const side = Math.random() < 0.5 ? 'l' : 'r';
      r.img('shadow ' + side, `watcher-${variant()}.svg`);
    },

    static_blip(r) { r.el('div', 'ov noise blip'); r.el('div', 'ov scan blip'); },

    whisper_text(r, d) {
      const box = r.el('div', 'msg ' + pick(['tl', 'tr', 'bl', 'br']));
      const text = pick(S.MESSAGES);
      if (reduced()) { box.textContent = text; return; }
      let i = 0;
      const step = Math.max(40, Math.min(90, (d * 0.35) / text.length));
      r.every(() => { i = Math.min(text.length, i + 1); box.textContent = text.slice(0, i) + (i < text.length ? '▌' : ''); }, step);
    },

    eyes_in_dark(r) {
      const x = pick([rand(3, 14), rand(68, 80)]) + 'vw', y = rand(12, 68) + 'vh';
      const dark = r.el('div', 'dark');
      dark.style.left = x; dark.style.top = y;
      const pair = r.el('div', 'eyepair');
      pair.style.left = x; pair.style.top = y;
      [31, 55].forEach((l, i) => {                       // second eye blinks a beat late
        const e = document.createElement('div');
        e.className = 'eye'; e.style.left = l + '%';
        e.style.setProperty('--d', (r.d + (i ? 140 : 0)) + 'ms');
        pair.appendChild(e);
      });
    },

    watcher_glimpse(r) {
      const g = r.img('glimpse', `watcher-${variant()}.svg`);
      g.style.height = rand(46, 74) + 'vh';
      g.style[Math.random() < 0.5 ? 'left' : 'right'] = rand(1, 22) + 'vw';
      r.el('div', 'ov noise faint');
    },

    false_lunge(r) { // the "almost": dims, something rises, then nothing happens
      r.el('div', 'ov dim');
      r.img('ghostfig', `watcher-${variant()}.svg`);
    },

    text_corruption(r, d) {
      const nodes = textNodes(8);
      if (!nodes.length) return R.static_blip(r);
      const items = nodes.map((n) => ({ n, orig: n.nodeValue, cur: n.nodeValue }));
      r.cleanups.push(() => items.forEach((it) => { if (it.n.isConnected && it.n.nodeValue === it.cur) it.n.nodeValue = it.orig; }));
      const GL = '█▓▒░#@$%&?¿Ø§±µ';
      const mangle = (s, p) => [...s].map((c) => (c === ' ' || Math.random() > p ? c : GL[(Math.random() * GL.length) | 0])).join('');
      const apply = (p) => items.forEach((it) => {
        if (!it.n.isConnected || it.n.nodeValue !== it.cur) return;   // page changed it: leave it alone
        it.cur = mangle(it.orig, p); it.n.nodeValue = it.cur;
      });
      apply(0.28);
      if (reduced()) return;
      const iv = r.every(() => apply(0.12 + Math.random() * 0.3), 170);
      r.later(() => {
        clearInterval(iv);
        const it = items[0];
        if (it.n.isConnected && it.n.nodeValue === it.cur) { it.cur = pick(['BEHIND YOU', 'LOOK UP', 'I SEE YOU']); it.n.nodeValue = it.cur; }
      }, d * 0.72);
    },

    signal_loss(r) {
      const wrap = r.el('div', 'ov sl');
      wrap.appendChild(Object.assign(document.createElement('div'), { className: 'rgb' }));
      for (let i = 0; i < 4; i++) {
        const b = document.createElement('div'); b.className = 'band';
        b.style.top = rand(5, 90) + 'vh'; b.style.height = rand(1, 7) + 'vh'; wrap.appendChild(b);
      }
      const a = document.createElement('div'); a.className = 'osd a'; a.innerHTML = 'PLAY ▶'; wrap.appendChild(a);
      const t = document.createElement('div'); t.className = 'osd b';
      t.innerHTML = `00:0${Math.floor(rand(1, 9))}:${Math.floor(rand(10, 59))}<i> ●</i>`; wrap.appendChild(t);
      r.el('div', 'ov noise faint'); r.el('div', 'ov scan');
    },

    watcher_scare(r) {
      const bg = r.el('div', 'ov cutbg hit');
      bg.addEventListener('click', () => r.end());                     // always dismissible
      r.img('face', `watcher-face-${variant()}.svg`);
      r.el('div', 'ov noise faint'); r.el('div', 'ov scan');
    },

    watcher_lunge(r) {
      const bg = r.el('div', 'ov cutbg hit');
      bg.addEventListener('click', () => r.end());
      r.img('face lunge', `watcher-face-${variant()}.svg`);
      r.el('div', 'ov scan');
    }
  };

  /* ------------------------------------------------------------------ entry points */
  function runEvent(msg, hud, onDone) {
    const def = S.EVENT_BY_ID[msg.id];
    if (!def || !R[def.id]) return { ok: false, reason: 'unknown-event' };
    const forced = !!msg.forced;
    const why = blocked(forced);
    if (why) return { ok: false, reason: why };
    if (current) { if (!forced) return { ok: false, reason: 'busy' }; current.end(); }
    const o = msg.opts || {};
    const inten = S.INTENSITY[o.intensity] || S.INTENSITY.medium;
    const cap = S.clamp(Number(o.maxDurationMs) || 4000, 800, 8000);
    const d = Math.round(Math.min(def.dur * inten.dur, cap));
    const r = new Run(def.id, { k: inten.visual, vol: inten.vol, sound: !!o.sound, hud, onDone });
    current = r;
    attachGuards();
    try {
      r.start(d);
      R[def.id](r, d);
      if (def.sound) r.sound(def.sound);
    } catch (e) { r.end(); return { ok: false, reason: 'render-error' }; }
    return { ok: true, id: def.id, durationMs: d };
  }

  // A scripted tour of all three stages for demos. Uses the exact same renderers; touches no progression.
  function previewEscalation(msg) {
    const why = blocked(true);
    if (why) return { ok: false, reason: why };
    cancelAll();
    const steps = [
      ['STAGE 1 · ANOMALY', 'faint_shadow'], [null, 'vignette_pulse'],
      ['STAGE 2 · CONTACT', 'whisper_text'], [null, 'watcher_glimpse'],
      ['STAGE 3 · BREACH', 'signal_loss'], [null, 'text_corruption'], [null, 'watcher_scare']
    ];
    const seq = (sequence = { cancelled: false });
    let i = 0;
    const next = () => {
      if (seq.cancelled || i >= steps.length) { if (sequence === seq) sequence = null; return; }
      const [hud, id] = steps[i++];
      const res = runEvent({ id, forced: true, opts: msg.opts }, hud, () => setTimeout(next, 900));
      if (!res.ok) { sequence = null; }
    };
    next();
    return { ok: true, durationMs: 22000 };
  }

  const listener = (msg, sender, sendResponse) => {
    if (!msg || sender.id !== chrome.runtime.id) return;
    if (msg.type === 'RUN_EVENT') sendResponse(runEvent(msg));
    else if (msg.type === 'PREVIEW_ESCALATION') sendResponse(previewEscalation(msg));
    else if (msg.type === 'CANCEL') { cancelAll(); sendResponse({ ok: true }); }
  };
  chrome.runtime.onMessage.addListener(listener);

  window.__phantom = {
    alive: () => { try { return !!chrome.runtime.id; } catch (e) { return false; } },
    dispose() { cancelAll(); try { chrome.runtime.onMessage.removeListener(listener); } catch (e) { /* orphaned */ } },
    _runEvent: runEvent // exposed for the test harness only
  };
})();
