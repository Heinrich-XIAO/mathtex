// Demo recorder for MathTex. Drives the production app (or any URL) in
// headless Chromium, fakes the microphone with a WAV utterance, records video
// with Playwright's recordVideo, and writes an MP4 (+ optional GIF).
//
// Auth: the app is gated behind Google OAuth. This script cannot complete
// OAuth by itself. Pass `--token <jwt>` (and optionally `--refresh <rt>`) from
// a human's signed-in session, or `--storage-state <file.json>` from a
// Playwright storageState export. With no auth, it records the landing page
// through the Google OAuth wall and exits with unblock instructions.
//
// Usage (repo root):
//   node scripts/demo.mjs [--url https://mathtex.vercel.app] \
//     [--utterance /path/to/speech.wav] [--out /tmp/opencode/demo-attempt] \
//     [--name my-demo] [--token <jwt>] [--refresh <rt>] \
//     [--storage-state state.json] [--gif] [--slow] [--list-audio]
//
// Requires: playwright in /tmp/opencode/node_modules (created by a prior
// session: `cd /tmp/opencode && npm i playwright`) and the Chromium build at
// ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome.
// System ffmpeg lacks libx264 here, so MP4 output uses the mpeg4 encoder.

import { createRequire } from "node:module";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const require = createRequire("/tmp/opencode/node_modules/");
const { chromium } = require("playwright");

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const URL = arg("url", "https://mathtex.vercel.app");
const OUT_DIR = resolve(arg("out", "/tmp/opencode/demo-attempt"));
const NAME = arg("name", "demo");
const TOKEN = has("token") ? arg("token", null) : null;
const REFRESH = arg("refresh", null);
const STORAGE_STATE = arg("storage-state", null);
const GIF = has("gif");
const SLOW = has("slow");
const WIDTH = Number(arg("width", 430));
const HEIGHT = Number(arg("height", 820));

const CHROME_FAKE_MIC = has("chrome-fake-mic");

const VIEWPORT = { width: WIDTH, height: HEIGHT };
const STEP = SLOW ? 1200 : 450;

// ---------- browser binary ----------
function findChromium() {
  const cache = join(process.env.HOME ?? "", ".cache/ms-playwright");
  if (!existsSync(cache)) throw new Error("No ms-playwright cache found; run `npx playwright install chromium`");
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort();
  for (const d of dirs.reverse()) {
    const p = join(cache, d, "chrome-linux64/chrome");
    if (existsSync(p)) return p;
  }
  throw new Error("No chromium binary under ~/.cache/ms-playwright");
}

// ---------- ffmpeg (prefer the static libx264 build from prior sessions) ----------
const STATIC_FFMPEG = "/tmp/opencode/ffmpeg-7.0.2-amd64-static/ffmpeg";
function ffmpeg() {
  return existsSync(STATIC_FFMPEG) ? STATIC_FFMPEG : "ffmpeg";
}
function toMp4(webm, mp4) {
  // static build: h264; system ffmpeg (Fedora) has no h264 encoder — use mpeg4
  const codec = ffmpeg() === "ffmpeg" ? "mpeg4" : "libx264";
  execFileSync(ffmpeg(), ["-y", "-v", "error", "-i", webm, "-c:v", codec, ...(codec === "libx264" ? ["-crf", "23"] : ["-q:v", "4"]), "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
}

// ---------- fake microphone ----------
// Two supported modes:
//  1. Chrome fake-device flags (--use-fake-device-for-media-stream +
//     --use-file-for-fake-audio-capture=<wav>): Chrome loops the WAV as the
//     "microphone". No JS injection; used by verify/record runs in past sessions.
//  2. getUserMedia stub (addInitScript): plays the WAV into a
//     MediaStreamDestination with lead-in silence so the level meter rises.
// Mode 1 is set at launch; mode 2 is injected pre-load for every page.
function micStubScript() {
  return (b) => {
    const raw = Uint8Array.from(atob(b), (c) => c.charCodeAt(0)).buffer;
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext({ sampleRate: 16000 });
      const clip = await ctx.decodeAudioData(raw.slice(0));
      const buf = ctx.createBuffer(1, Math.ceil(0.6 * 16000) + clip.length, 16000);
      buf.copyToChannel(clip.getChannelData(0), 0, Math.ceil(0.6 * 16000));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest);
      src.start();
      return dest.stream;
    };
  };
}

function loadUtteranceB64() {
  const u = arg("utterance", null);
  const p = u ?? "/tmp/opencode/mathtex-e2e/test-utterance.wav";
  if (!existsSync(p)) {
    console.error(`No utterance WAV at ${p}. Point --utterance at a 16-24 kHz mono WAV of speech`);
    process.exit(1);
  }
  return readFileSync(p).toString("base64");
}

// ---------- storage helpers ----------
function escapeNamespace(url) {
  return url.replace(/[^a-zA-Z0-9]/g, "");
}

const JWT_KEY = "__convexAuthJWT";
const REFRESH_KEY = "__convexAuthRefreshToken";

const log = (...a) => console.log(`[demo] ${new Date().toISOString().slice(11, 19)}`, ...a);
const beats = [];
const beat = (t, label) => { beats.push(`${t}s  ${label}`); log(label); };

// ---------- main ----------
mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({
  executablePath: findChromium(),
  args: CHROME_FAKE_MIC
    ? [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${arg("utterance", "/tmp/opencode/mathtex-e2e/test-utterance.wav")}`,
        "--autoplay-policy=no-user-gesture-required",
      ]
    : ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: OUT_DIR, size: VIEWPORT } });
if (STORAGE_STATE && existsSync(STORAGE_STATE)) await ctx.addCookies(JSON.parse(readFileSync(STORAGE_STATE, "utf8")).cookies ?? []);

const page = await ctx.newPage();
await page.addInitScript(micStubScript(), loadUtteranceB64());

const extraInit = [];
if (TOKEN) {
  // ConvexAuthProvider namespaces localStorage keys by the Convex client
  // address (the *.convex.cloud URL, escaped). Past sessions also seed the
  // bare key — belt and suspenders across app versions.
  const ns = escapeNamespace(arg("convex-ns", "https://astute-alpaca-949.convex.cloud"));
  extraInit.push(`
    localStorage.setItem("__convexAuthJWT", ${JSON.stringify(TOKEN)});
    localStorage.setItem(${JSON.stringify(`${JWT_KEY}_${ns}`)}, ${JSON.stringify(TOKEN)});
    ${REFRESH ? `localStorage.setItem(${JSON.stringify(`${REFRESH_KEY}_${ns}`)}, ${JSON.stringify(REFRESH)});` : ""}
    localStorage.setItem("mathtex.background-context", "");
  `);
  await page.addInitScript(extraInit.join("\n"));
}

await page.goto(URL, { waitUntil: "networkidle" });
beat(0, `loaded ${URL}`);

// Auth gate check
const gated = await page.locator(".landing-google").count();
if (gated) {
  beat(2, "AUTH GATE: landing page with Google sign-in");
  await page.click(".landing-google");
  await page.waitForURL(/accounts\.google\.com/, { timeout: 20000 }).catch(() => {});
  beat(5, `AUTH GATE: redirected to ${page.url().slice(0, 60)}… — agent cannot complete OAuth`);
  await page.waitForTimeout(2500);
  await ctx.close();
  await browser.close();
  const wallVideo = await videoPath(OUT_DIR);
  if (wallVideo) {
    const mp4 = join(OUT_DIR, `${NAME}.mp4`);
    toMp4(wallVideo, mp4);
    log(`mp4: ${mp4}`);
  }
  console.log(`
──────────────────────────────────────────────────────────────
Auth wall reached. To record the real product demo, unblock with
ONE of these (then re-run this script):

 1. Paste a session token from a signed-in browser. In that browser's
    DevTools console on the app origin run:
      JSON.stringify(Object.fromEntries(Object.entries(localStorage)
        .filter(([k]) => k.startsWith("__convexAuth"))))
    then: node scripts/demo.mjs --token <JWT> --refresh <refreshToken>

 2. Export a Playwright storageState from a signed-in context
    (human signs in once in a headed browser you keep alive) and run:
      node scripts/demo.mjs --storage-state state.json

 3. Have a human sign in inside a visible browser (e.g. the T3 desktop
    preview tab) and record that tab instead of headless.

Video: ${OUT_DIR}/${NAME}.mp4
──────────────────────────────────────────────────────────────`);
  process.exit(0);
}

// ---------- the actual demo (only reachable when authenticated) ----------
beat(2, "workspace loaded");
const pill = page.locator(".pill");
if (await pill.count()) {
  await pill.hover().catch(() => {});
  await page.waitForTimeout(STEP);
  const box = await pill.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  beat(4, "push-to-talk: recording (fake mic plays utterance)");
  await page.waitForTimeout(SLOW ? 4500 : 3800); // utterance is ~3.9s
  await page.mouse.up();
  beat(9, "released: transcribing…");
  await page.waitForSelector(".lines .line", { timeout: 30000 });
  const latex = await page.locator(".line .latex").first().textContent();
  beat(12, `KaTeX rendered: ${latex?.slice(0, 60)}`);

  // second take with a swipe-to-correct flourish
  const row = await page.locator(".lines .line").first().boundingBox();
  const y = row.y + row.height / 2;
  await page.mouse.move(row.x + row.width - 30, y);
  await page.mouse.down();
  await page.mouse.move(row.x + row.width - 30 - 110, y, { steps: 8 });
  await page.mouse.up();
  beat(15, "swipe: verdict / correction sheet");
  await page.waitForTimeout(STEP * 2);
  if (await page.locator(".reason-sheet").count()) {
    await page.fill(".reason-input", "should be x = 5, not x = -5");
    await page.press(".reason-input", "Enter");
    beat(18, "typed correction saved");
  }
  await page.waitForTimeout(STEP);
} else {
  beat(2, "no .pill found — UI may have changed, adjust the demo script");
  await page.waitForTimeout(4000);
}

await page.waitForTimeout(1500);
await ctx.close();
await browser.close();

const video = await videoPath(OUT_DIR);
if (video) {
  const mp4 = join(OUT_DIR, `${NAME}.mp4`);
  toMp4(video, mp4);
  log(`mp4: ${mp4}`);
  if (GIF) {
    const gif = join(OUT_DIR, `${NAME}.gif`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", video, "-vf", "fps=12,scale=360:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", gif]);
    log(`gif: ${gif}`);
  }
}

console.log(`\nShot list (for the changelog / PR description):\n${beats.map((b) => `  ${b}`).join("\n")}`);

async function videoPath(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".webm"));
  return files.length ? join(dir, files[0]) : null;
}
