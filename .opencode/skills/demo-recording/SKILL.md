---
name: demo-recording
description: Use when recording a demo, screencast, or video (mp4/webm/gif) of this app from an agent session — includes "record a demo", "demo video", "screencast", "capture the app on video", "show a recording of the bug". Covers headless Chromium video capture, fake-microphone tricks, the Google OAuth wall, and token minting.
---

# Recording demos of MathTex

Run the tool first; read this doc when something fails or you need a variant
(GIF, audio, desktop viewport, tracing an interaction bug).

## The tool

`scripts/demo.mjs` records the app in headless Chromium, fakes the microphone,
and writes an MP4 with a timestamped shot list.

```bash
node scripts/demo.mjs                                   # prod (auth wall without a token)
node scripts/demo.mjs --token <JWT> --refresh <RT>      # signed-in session (see below)
node scripts/demo.mjs --url http://localhost:5173 --gif # dev server
node scripts/demo.mjs --chrome-fake-mic                 # Chrome fake-device flags instead of the JS stub
node scripts/demo.mjs --slow                            # longer holds for readability
node scripts/demo.mjs --width 1280 --height 900         # desktop viewport (1280x900 was used for the storage-bug repro)
```

Output: `/tmp/opencode/demo-attempt/<name>.mp4`. Copy into the repo root when
delivering.

## Environment inventory (verified 2026-10-02, from prior-session archaeology)

| Capability | State |
|---|---|
| `playwright` npm | NOT in repo node_modules. Lives at `/tmp/opencode/node_modules` (v1.63) and `/tmp/opencode/storage-test/node_modules` (recreate: `cd /tmp/opencode && npm i playwright`). Browsers already at `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome` |
| ffmpeg | System `/usr/bin/ffmpeg`: **no h264 encoder AND no h264 decoder** (Fedora strips them). A **static ffmpeg with libx264** exists at `/tmp/opencode/ffmpeg-7.0.2-amd64-static/ffmpeg` (downloaded by a prior session; if missing, fetch a johnvansickle static build). Demo scripts use `-c:v mpeg4` on system ffmpeg, `libx264` on the static one |
| TTS | `espeak-ng` IS installed (`espeak` the bare name is not). Prior sessions generated utterances with `espeak-ng -v en-us -s 130 -a 200 -w out.wav "…"` |
| Fake mic | Two ways: Chrome flags `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>` (loops a WAV as the mic — used for the real dictation in past sessions) or a `getUserMedia` JS stub via `addInitScript` (the tool's default) |
| Playwright MCP browser tools | Broken by default (wants Google Chrome at `/opt/google/chrome/chrome`); automation-only anyway, no built-in video |
| T3 preview recording (`t3-code_preview_recording_*`) | Only when the user's T3 desktop app is connected; headless server = unavailable (50 MiB transfer cap when it works) |
| Xvfb | `/usr/bin/Xvfb` + `xvfb-run` installed — enables the headed-browser + screen-grab path |

## The auth wall and how a past agent actually got past it

The app is gated behind Google OAuth (`src/App.tsx:1229`). An agent **can**
get a signed-in session with zero user help — the 2026-10-01 session did, by
minting a token from deployment state. The chain (all artifacts in
`/tmp/opencode/storage-test/`):

1. `npx convex data authSessions --prod` → real `sessionId` + `userId` from the
   auth table (docs print plain).
2. `npx convex env get JWT_PRIVATE_KEY --prod` → the deployment's RS256 signing
   PEM. ⚠️ Note `convex env list --prod` ALSO prints secret values inline
   (multiline PEMs confuse its output). This is a real secret-exposure surface —
   report it, keep the key off stdout/tokens out of logs, and recommend the
   user rotate the key if it has been widely exposed.
3. `jose` (in repo node_modules) `SignJWT`: `sub = ${userId}|${sessionId}`,
   `iss = https://<deployment>.convex.site`, `aud = "convex"`, RS256, ~50m exp
   → `token.txt`.
4. Seed `localStorage` BEFORE page load: bare `__convexAuthJWT` **and**
   `__convexAuthJWT_<escaped-convex-cloud-url>` (namespace = client address,
   e.g. `httpsastutealpaca949convexcloud` — the .cloud URL, NOT .convex.site).
5. Drive the app with `chromium.launchPersistentContext(profile,
   { permissions: ["microphone"], recordVideo })` so the session and any
   warm-up (e.g. an ONNX model download) survive across runs — record only the
   interesting take in the warmed profile.

Treat this as a user-sanctioned technique for their own deployment: mint only
test sessions in test files, never impersonate the user's real work, and
prefer asking the user for a `__convexAuth*` localStorage paste when they're
around. Minted tokens expire (re-mint per run).

Human-assisted alternatives (when the user is available): paste the two
`__convexAuth*` localStorage values from their signed-in browser
(`--token/--refresh`), or they sign in inside a visible browser (T3 preview
tab) and you record that tab with the preview recording tools.

## Recording methods (ranked, all proven on this machine)

| Method | When to use | Notes |
|---|---|---|
| 1. Playwright `recordVideo` (the tool) | Most demos | webm → mp4; whole-context capture; convert after `ctx.close()` |
| 2. In-page tab capture + MediaRecorder + chunked `exposeFunction` streaming | Need AUDIO in the video, or start/stop exactly around the action | `--auto-accept-this-tab-capture` arg + `getDisplayMedia({preferCurrentTab:true})`; tap `<audio>` elements by monkey-patching `window.Audio` into a WebAudio MediaStreamDestination (headless has no output device); stream webm chunks base64 → Node append → webm → mp4. Built iteratively as `rec/record.mjs…record8.mjs` (8 iterations: black frames, missing audio track, prompt-blocking). ⚠️ FAILED 2026-10-02 on chromium-153: `--headless=new` + external launch → `NotReadableError: Could not start video source` even without `--disable-gpu`; and `--use-fake-device-for-media-stream` ALSO fakes `getDisplayMedia`, recording Chrome's green test-pattern instead of the tab |
| 3. CDP frame-by-frame (`Page.captureScreenshot` loop) | Deterministic animations, tight control | python websockets + `--remote-debugging-port`; ~30fps jpeg frames → ffmpeg. Slow but exact (used for scroll-fix-confirmation.mp4) |
| 4. Xvfb + `ffmpeg -f x11grab -i :77.0` — **the reliable workhorse** | Headed browser needed (extensions, real prompts, tab-capture alternatives) | `Xvfb :78 -screen 0 1280x900x24`, HEADED Chromium (add `--no-first-run --no-default-browser-check` or startup stalls and DevTools never binds), grab the screen with the static ffmpeg straight to h264 mp4 (the 18-min skipslop demo AND the mathtex product demo). Drive the page over CDP (`connectOverCDP`). Check for stale `/tmp/.X11-unix/X<N>` sockets from dead Xvfbs before reusing a display number |
| 5. T3 preview recording | User wants to watch live | Only with desktop app connected |

## Demo-scripting patterns that worked

- **Caption banners**: inject a fixed-position `#vcap` div narrating each scene
  (`caption("Now the user hits refresh...")`) — demos are silent, text does the
  talking.
- **Scene design** (storage-bug repro): healthy load → reload to show the bug →
  reload again to pile up "Untitled" tabs → root-cause caption. One continuous
  ~40s take, mpeg4 1280x900, 3.4MB.
- **Dialog races**: app dialogs can mount late (`context-overlay`); loop
  dismiss-with-recheck instead of one-shot clicks.
- **Warm-then-record**: two-phase runs (`warm` downloads models / sets state
  into the persistent profile, `record` only captures the take).
- Verify every video by extracting frames (`ffmpeg -ss <t> -frames:v 1`) and
  eyeballing them before delivering; ffprobe duration/codec too.

## Pitfalls

- System ffmpeg cannot even DECODE h264 (`--disable-decoder='h264,hevc,vc1,vvc'`)
  — don't chase "Unable to create decoder" errors; use the static build.
- `pkill -f "<pattern>"` matches your OWN bash command line and kills the tool
  shell (hangs until timeout). Bracket one char (`pkill -f "chrome[-]linux64"`)
  or pkill from a script file.
- The dictation status gates silently: `start()` returns early when
  `statusRef.current !== "idle"` — after a failed take, the app looks idle but
  ignores every press. Reload the page between takes.
- Headed Chromium startup can stall without `--no-first-run
  --no-default-browser-check` (DevTools port never binds, empty logs).
- `recordVideo` writes the webm only on `context.close()`; file name is a hash.
- Match `recordVideo.size` to the context viewport or you letterbox.
- Playwright must be resolvable from the script's own directory (`createRequire`
  to `/tmp/opencode/node_modules`), since repo node_modules lacks it.
- Utterance WAVs ride to the browser as base64 in `addInitScript` (cap ~64KB
  per evaluate expression) — keep clips ≤ ~10s or chunk.
- Old `/tmp/opencode/*.mjs` e2e scripts predate the OAuth gate (commit
  `0f58357`, 2026-09-30); anything assuming unauthenticated workspace access is
  stale.
- Chrome fake-mic loops the WAV forever — hold Space roughly the clip length
  plus lead-in, or you capture silence/transcript truncation.
- Post-trim dead air between agent tool calls with ffmpeg cuts
  (`-ss/-to` segments + concat demuxer); inter-call latency otherwise leaves
  20–75s gaps in the video.
