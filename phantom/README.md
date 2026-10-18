# PHANTOM — *Your browser is not alone.*

A consent-based horror experience for Chrome. PHANTOM does nothing until you turn it on, and then only haunts the sites **you** add. Every so often, something is slightly wrong: a shadow at the edge of the screen, a message that types itself, a glitch, and (rarely) The Watcher.

Manifest V3 · vanilla JS/HTML/CSS · no backend · no network requests · no accounts · all art and audio are original and bundled.

---

## Install (Developer mode → Load unpacked)

1. Unzip `phantom.zip` so you have a folder containing `manifest.json`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `phantom` folder (the one with `manifest.json` directly inside).
5. Pin the extension (puzzle-piece icon → pin PHANTOM) so the popup is one click away.
6. Open a page (e.g. `https://www.youtube.com`), click the PHANTOM icon, then:
   - switch **Haunting** on,
   - click **Haunt this site** (Chrome shows a permission prompt for that one site),
   - press **Test scare**.

Requires Chrome 120+ (uses `chrome.alarms` sub-minute alarms, individual CSS transform properties, and the Popover API).

## Permissions, and why there are so few

| Permission | Why |
|---|---|
| `storage` | Settings and progression, in `chrome.storage.local`. Never leaves the machine. |
| `alarms` | The scheduler. One alarm, re-created from storage if the service worker restarts. |
| `scripting` | Registers the content script for sites you add; injects it on demand for Test/Demo. |
| `activeTab` | Lets **Test scare** and demo buttons work on the tab you are looking at, with no site grant needed. |
| *optional* host permissions (`http(s)://*/*`) | **Not granted at install.** PHANTOM asks for one origin at a time when you click *Haunt this site*. Revoke any time with *Release site* or in `chrome://extensions → Details → Site access`. |

There is no `tabs`, `history`, `cookies`, `webRequest` or `<all_urls>` permission, and no static content script. The list of haunted sites *is* Chrome's own list of granted optional origins, so there is no second list to drift out of sync.

Limitations that follow from this: PHANTOM will not run on a site you have not added (except a one-off Test on the active tab), cannot run on `chrome://` pages, the Chrome Web Store, or other extensions' pages, and each origin is added separately (`youtube.com` and `www.youtube.com` are different origins; the popup adds the one in your address bar).

## Features

- **Randomised events**, three categories: *whispers* (subtle), *glitches* (stronger), *jumpscares* (rare).
- **The Watcher**: an original entity: a tall black silhouette, an elongated head, pale eyes (2, 3 or 4 depending on variant), thin toothy grin, red rim light. Five variants, each as a full-figure sprite and a close-up face.
- **Escalation, bounded**: Stage 1 *Anomaly* (shadows, vignette pulses, static blips) → Stage 2 *Contact* (cryptic messages, eyes in the dark, Watcher glimpses) → Stage 3 *Breach* (signal loss, text corruption, jumpscares). Thresholds are 5 and 14 events; frequency multiplier never goes below 0.7×; a hard 45 s floor applies between events no matter what. Escalation can be disabled (freezes the stage).
- **Fake-outs**: `vignette_pulse`, `faint_shadow`, `static_blip` and `false_lunge` (the screen dims, something rises, then nothing happens) are silent, harmless, and make up a large share of events.
- **Weighted selection**: at Stage 3 jumpscares are ≈ 6 % of events at Medium, ≈ 11 % at High and 0 % at Low (measured over 20,000 simulated picks in the test harness), so everything else, including the silent fake-outs, is the large majority, recently used events are skipped, and a separate jumpscare cooldown (default 8 min) applies.
- **Settings** (popup): master switch, stage display, intensity (Low/Medium/High), sound toggle (default off), frequency, cooldown, max event length, escalation toggle, reset progression, site access, cooldown/status indicator.
- **Test scare** and **Demo mode** (toggle at the bottom of the popup → a red *Demo mode* badge and four buttons: Trigger whisper / glitch / jumpscare / Preview escalation). Test and demo use the same renderer as live events, work on the active tab without waiting, and never touch progression or cooldowns.

## Architecture

```
phantom/
├─ manifest.json     MV3; optional host permissions; web-accessible assets
├─ shared.js         Config + pure logic (events, weights, stages, delays, URL guards).
│                    Loaded by the service worker (importScripts) AND as the first content script.
├─ background.js     Service worker: scheduler, site-permission sync, test/demo routing
├─ content.js        Renderer: one closed shadow root on a top-layer popover; events; cleanup
├─ popup.html/.css/.js   The UI
├─ assets/images/    watcher-{1..5}.svg, watcher-face-{1..5}.svg, logo.svg, icons, noise.png
├─ assets/audio/     scare.wav, heartbeat.wav, static.wav (synthesised, original)
├─ tools/make_assets.py  Regenerates every asset (Pillow + numpy)
└─ tests/            Optional offline harness (not needed to run the extension)
```

There is no `styles.css`: overlay CSS lives inside `content.js` and is attached to a closed shadow root so page styles cannot interfere and page scripts cannot see it.

### Scheduler (and surviving MV3 service-worker eviction)

The service worker keeps nothing in memory that matters.

- `storage.local.schedule.nextAt` is the source of truth for *when* the next event is due; one `chrome.alarms` alarm (`phantom-next`) wakes the worker at that time.
- `ensureScheduled()` runs at every worker start, on `onInstalled`, and on `onStartup`. If the alarm vanished (browser restart, update, worker restart) it is rebuilt from the stored `nextAt`; if that time has already passed, a fresh randomised delay is chosen.
- Alarm tick: skip if still in cooldown → find the focused window's active tab → require that it is a haunted, non-restricted, non-sensitive page → weighted-pick an event → deliver → record progress and cooldown → schedule the next alarm. If nothing is eligible (you are on another site, Chrome is unfocused) it retries in 1–4 minutes rather than burning the full interval, and a page that declines (you are typing, a payment field is present) is *not* counted toward progression.
- Alarm delay: mean ≈ 16 min at frequency 1 down to ≈ 2 min at frequency 10, × stage multiplier (1 / 0.85 / 0.7), × random 0.6–1.4, never below 45 s or the configured cooldown.
- Nothing polls. The content script has no timers or observers unless an event is playing.
- State-changing work is serialised through one promise chain so an alarm tick and a popup message cannot interleave.

### Event rendering and cleanup

Each event is a `Run` that owns its DOM nodes, timers, intervals, audio elements and cleanup callbacks. `Run.end()` tears all of it down, and is triggered by: natural expiry, a failsafe timer, **Esc**, the tab being hidden, page unload, a click on a jumpscare, or the next forced event. Text corruption restores the original text nodes exactly (and leaves alone any node the page changed in the meantime). Overlays are `pointer-events: none` (the page stays usable) except the jumpscare overlay, which dismisses on click.

## Safety and user control

- Off until you enable it; **master switch** in the popup; sound is a separate, default-off toggle.
- Only runs on origins you added. Never on `chrome://`, extension pages, the Web Store, or non-web schemes.
- Skips sign-in, checkout, payment, billing and account-security URLs, and any page containing a password field, card-number field, one-time-code field, or Stripe/PayPal iframe. This applies to Test and Demo too.
- Scheduled events also skip while you are typing in an input, textarea, select or contenteditable.
- Never blocks closing tabs, navigating, or disabling the extension; **Esc** cancels any event or the escalation preview.
- Intensity scales visuals, duration, volume and jumpscare weight; *Max event length* is a hard cap (1–6 s); cooldowns are configurable.
- Reduced-motion is respected: no shaking, no moving grain or bands, no scrambling animation, no lunge. Events become simple fades.
- No rapid full-screen luminance flashing: the only repeating motion is low-contrast film grain and thin horizontal bands, and nothing strobes. Even so, **this extension is not suitable for people with photosensitive epilepsy or anyone who does not want to be startled.**
- Sound uses a plain `audio.play()`. PHANTOM does **not** try to get around browser autoplay rules, so on a page you have not interacted with, sound may stay silent. That is intentional.
- It does not simulate security warnings, claim camera/microphone access, or imitate OS malware alerts. Messages are theatrical ("you blinked"), not claims about your device.
- No network access of any kind, no remote code, no analytics, no browsing history, nothing leaves the machine.

## Testing

**What has actually been run** (offline, in this repo's `tests/`; `cd tests && npm install && node run.js && node popup_smoke.js`):

- Manifest sanity (MV3, no static host access, referenced files and audio exist); no `fetch`/XHR/WebSocket/`eval` or hard-coded remote URLs in the source.
- Weighted selection statistics (stage gating, jumpscare rates, Low = no jumpscares, cooldown, no starvation), delay floor/ceiling, stage thresholds, URL guards.
- Scheduler against a **mocked** `chrome.*` API: enable schedules one alarm; a "restarted" worker rebuilds the alarm from storage; stale schedules are replaced; cooldown, restricted pages, sensitive URLs, un-added sites, unfocused browser and "page declined" paths; Test never touches progression; messages from content scripts/other extensions are ignored; master off clears the alarm.
- Every event rendered in **jsdom** with a fake clock: it renders, stays within the duration cap, removes its overlay, leaves zero timers, restores corrupted text, stops audio; plus duplicate prevention, Esc, click-to-dismiss, typing guard, password/payment-field guard, the sound toggle, and the full escalation preview (including Esc mid-preview).
- Popup smoke test in jsdom: loads without errors, starts disabled, toggles/intensity/sound/frequency/escalation persist, site permission request targets exactly one origin, demo mode shows the badge and all four buttons send the right messages.

**Not tested** (needs a real browser, please check these by hand before relying on them):

- Loading unpacked in real Chrome, and the real permission prompt (including whether the popup stays open while Chrome shows it; the background registers the site on `permissions.onAdded` either way).
- Real service-worker eviction and real alarm behaviour across a browser restart (the logic is tested against a mock, not Chrome).
- YouTube and any particular browser game; real fullscreen/top-layer stacking; real audio playback and autoplay behaviour.
- The popup's visual appearance and the overlays' look and timing in Chrome (the Watcher SVGs were rendered and eyeballed; the overlay animations and popup CSS were not).
- Other browsers (Edge/Brave likely work; untested).

### Manual checklist (5 minutes)

1. Load unpacked; popup opens; settings survive closing/reopening the popup and restarting Chrome.
2. On `https://www.youtube.com`: *Haunt this site*, accept the prompt; **Test scare** fires immediately and cleans up.
3. Turn on Demo mode: whisper / glitch / jumpscare / preview escalation each work; **Esc** cancels.
4. Master off → no events, no alarm (`chrome://extensions` → PHANTOM → *service worker* → Application → no alarm).
5. In the service-worker DevTools console, run `chrome.alarms.getAll()` while enabled (expect one `phantom-next`); click *Stop* on the worker in `chrome://serviceworker-internals`, wait, run it again (expect the alarm still there/rebuilt).
6. Visit a login/checkout page on a haunted site: Test scare should say it skipped.
7. Open `chrome://extensions`: Test scare should say PHANTOM can't run there.

## Hackathon demo script (~90 seconds)

1. **Cold open (10 s).** Play a normal YouTube video, no commentary. Say: *"This is a normal browser."*
2. **The pitch (10 s).** Click the PHANTOM icon. *"PHANTOM is a haunted browser. It's opt-in, local-only and has no backend."* Point at the tagline and the site list: *"It can only touch sites I add."*
3. **Subtle first (20 s).** Demo mode → **Trigger whisper**, then **Trigger glitch**. *"Most events are subtle: a message, a shadow, a hiccup. Nothing loud."* Mention the fake-outs: *"Some events build to nothing, on purpose."*
4. **Escalation (25 s).** **Preview escalation**. Narrate the HUD: *"Stage 1: anomalies. Stage 2: contact. Stage 3: breach."* Let it end on the jumpscare (turn **Sound** on beforehand and click the page once so the browser allows audio).
5. **Safety (15 s).** Show Intensity, Cooldown, Max length, Escalation and the master switch. Hit **Esc** during a Test scare. *"Anything cancels instantly. It refuses sign-in and payment pages. Reduced-motion is respected."*
6. **Close (10 s).** Turn Demo mode off, set Frequency to 6, leave it on, and keep talking. Let it happen on its own. *"Your browser is not alone."*

## Known limitations

- Not verified in real Chrome yet (see *Testing*). Expect small CSS/timing tweaks on first run.
- Sites must be added one origin at a time; some sites (a game inside a cross-origin iframe) only get the overlay on the top page, not inside the frame.
- Scheduled events only fire when the haunted tab is the active tab of the focused window.
- Sensitive-page detection is heuristic (URL keywords, a few host patterns, password/card/OTP inputs, Stripe/PayPal iframes). A custom payment widget that uses none of these would not be recognised.
- Text corruption touches visible text nodes outside forms/code; a framework that re-renders the same node mid-event can win the race (the original is still never overwritten with stale text).
- Audio may be blocked by autoplay policy until you interact with the page; it is never forced.
- The fake timestamp / "PLAY ▶" overlay and all messages are English only.
- Art is generated SVG (clean, original, consistent) rather than hand-painted; swap files in `assets/images/` with your own and keep the names to upgrade it.

## Manual setup remaining

None for it to run. Optional: record your own `scare.wav` / `static.wav` / `heartbeat.wav` into `assets/audio/` (keep the names), or replace the SVGs. Regenerate the originals any time with `python3 tools/make_assets.py`.
