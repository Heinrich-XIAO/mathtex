# MathTex — Voice-to-LaTeX, v1 Plan

**Concept:** Push-to-talk, say math out loud, see rendered LaTeX. One audio-capable LLM owns the entire pipeline: mic audio in → `{transcript, latex}` JSON out → rendered with KaTeX. Files with multi-line equations, stored locally in the browser.

**The moment that sells it:** hold space, say *"dy dx equals x squared times x cubed"*, release → ~1.5s later you see $\frac{dy}{dx} = x^2(x^3)$ with the transcript captioned underneath. It preserves structure — it never "helpfully" simplifies x²(x³) to x⁵.

## Decisions

| | |
|---|---|
| Platform | Web app first (Vite + React + TypeScript), PWA-ready, mobile later |
| Pipeline | Single audio-capable LLM call: audio + context → strict JSON `{transcript, latex, confidence, mode}` |
| Editing UX | Conversational: "scratch that", "make it cubed instead of squared" — same LLM, same call, modes not special cases |
| Audience | Students: speed and low friction first |
| Workspace | Files with multiple equation lines each |
| Output | Copy LaTeX per line + all; export PNG/SVG |
| Storage | Local-first (IndexedDB / Dexie), cloud sync later behind a flag |
| Mic | Push-to-talk (button / hold spacebar); continuous listening not in v1 |
| Keys | Use the machine's existing key — `OPENROUTER_API_KEY` in `~/.bashrc:31` is a **Hack Club AI proxy** key (`sk-hc-v1`), not an OpenRouter key. It is read server-side by the Vite proxy and **never reaches the browser bundle** |
| Endpoint | Prod: `https://openrouter.ai/api/v1` (OpenRouter key, works from datacenter IPs). Local dev: `https://ai.hackclub.com/proxy/v1` (the Hack Club proxy **blocks datacenter IPs**, so Vercel can't use it). Upstream selected via `UPSTREAM_BASE_URL` env |
| Hosting | Vercel (https://mathtex.vercel.app): static build + serverless `api/chat/completions.js` and `api/models.js` (concrete routes — the Vite preset's builder never matched a `[...path].js` catch-all). Key injected server-side, never in the browser bundle |
| Model | Dropdown over the proxy's OpenRouter-style catalog; default = audio-capable Gemini Flash |
| Config | Key lives in a gitignored `.env`; never in code, never committed |

## Architecture

```
[ Mic (MediaRecorder, opus) ]
        │  push-to-talk release
        ▼
[ WAV encode (mono 16 kHz PCM16, client-side) ]
        ▼
[ same-origin POST /api/chat/completions ]
        ▼
[ Vite proxy → Hack Club proxy (Authorization injected server-side) ]
        │  strict JSON response
        ▼
[ parse + one auto-retry on bad JSON / missing latex ]
        ▼
[ KaTeX render ] → [ line in file ]
        ▼
[ IndexedDB (Dexie): files, lines, audio blobs ]  (M2)
```

Single model call returns:

```json
{
  "mode": "append | replace_line | delete_last | noop",
  "transcript": "dy dx equals x squared times x cubed",
  "latex": "\\frac{dy}{dx} = x^2\\left(x^3\\right)",
  "confidence": 0.93,
  "note": ""
}
```

Conversational editing falls out of the same call: the request includes recent context (last 2–3 lines + current line latex). *"scratch that"* → `delete_last`; *"make it cubed instead of squared"* → `replace_line` with corrected latex; normal dictation → `append`.

## The prompt (the actual product)

System prompt: *"You are a math dictation engine. Audio contains a student speaking mathematics. Never simplify, solve, or rearrange — transcribe structure exactly as spoken. Output only JSON."* Plus a few-shot glossary:

| Spoken | LaTeX |
|---|---|
| "x squared" / "x to the y" | `x^2` / `x^y` |
| "a over b", "fraction a over b" | `\frac{a}{b}` |
| "d y d x", "derivative of y wrt x" | `\frac{dy}{dx}` |
| "integral from 0 to 1 of x squared dx" | `\int_0^1 x^2\,dx` |
| "sum from i equals 1 to n" | `\sum_{i=1}^{n}` |
| "square root of x", "nth root" | `\sqrt{x}` / `\sqrt[n]{}` |
| "x dot", "x prime", "alpha" | `\dot{x}` / `x'` / `\alpha` |
| "the quantity x plus y" | `(x+y)` |

Failure mode: confidence below 0.7 → amber "not sure — check this" state on the line, never a silent wrong answer.

## UI

- **Left:** file list (new/rename/delete)
- **Main:** stack of lines — big KaTeX render, small gray transcript caption, confidence dot; click a line to pin cursor, re-dictate to `replace_line`
- **Bottom:** mic button + "hold space" hint + level meter + last-transcript toast
- **Per line:** copy LaTeX; **file level:** copy all, export PNG/SVG (KaTeX SVG → canvas → PNG)

## Risks

1. **Audio model mishears math** — transcript caption for trust, confidence gate, audio blob kept per line for one-click re-run through a different model.
2. **Bad JSON** — response_format json_schema where supported + Zod validation + one automatic retry with the error appended.
3. **Latency (~1–3s)** — acceptable for push-to-talk; "thinking" state + level meter makes it feel intentional.
4. **Key hygiene** — proxy key stays in gitignored `.env`; never shipped in commits.

## Latency (M1.5)

Measured baseline (prod, gemini-3.8-flash): 3.3–5.4s, ~480 reasoning tokens per call.

**Model benchmark** (espeak utterances, timed, correctness-normalized): `gemini-3.5-flash-lite` wins — 1.2–1.7s, 6/6 correct, zero reasoning tokens (vs 6.9s / 1-of-4 for 3.8-flash baseline; `qwen3.8-omni-flash` 7.6s and 0/4). Adopted.

**Changes shipped:**
- Model → `google/gemini-3.5-flash-lite`, `max_tokens` 600→400
- Prompt emits keys in fixed order (mode, transcript, latex, …) so the transcript streams before the latex
- Stream pass-through in the Vercel functions + SSE client parser with progressive transcript ("heard: …" appears while thinking)
- Lambda warm-up fired at mic press (not page load), using an invalid `{}` body so it costs nothing

**Prod timings after:** TTFB 1.24–1.33s, total 1.44–1.53s (was 3.3–5.4s). Verified in-browser with an SSE-faithful e2e (progressive transcript + render) and a real round-trip.

**Deferred options:** silence trimming (user vetoed), direct Gemini API (staying on OpenRouter for benchmarkability), two-stage streaming ASR (architecture change).

## Status

- **M1 — DONE, deployed to https://mathtex.vercel.app.** Push-to-talk → WAV → same-origin `/api` → serverless proxy → upstream LLM → JSON → KaTeX. Verified end-to-end on prod: espeak audio of the dy/dx example → `\frac{dy}{dx} = x^2 \cdot x^3`, confidence 0.98, `audio_tokens: 97`. Local https deploy (self-signed cert) also running on :4173.
- **M2 partial — shipped early:** `append_lines` mode (one utterance → multiple lines, e.g. worked steps) and per-line voice targeting (mini-mic on each line; "get rid of the x² after the x⁴" edits only that line via `replace_line` + target index in context). No-unspoken-algebra rule stays. Verified in browser.
- **M2 — DONE.** Files/multi-line persistence + undo shipped:
  - **Storage pivot: Convex, not Dexie.** The plan's Dexie decision predates the auth pivot (Google OAuth + per-user scoping); with the whole app auth-gated and verdicts already in Convex, a local-only store would split data across two stores and start empty on every other device. Workspace now persists per-user in Convex.
  - `files` + `lines` tables (per-user; `lineId` is client-generated and stable, so verdict records keep pointing at the right line across undo/redo restores — re-inserting a line gets a new `_id` but keeps its `lineId`).
  - `convex/workspace.ts`: `list/create/rename/remove/getLines/syncLines`, all `requireUser`-gated. `syncLines` replaces the file's whole stack (delete-all + re-insert with `order=index`) — files are worksheets, so full-stack writes beat diffs and make undo/redo trivial.
  - Client write-through (`src/lib/workspace.ts`): every committed lines change (dictate, delete, undo, redo, switch) pushes to Convex; rapid edits coalesce into one in-flight write of the latest stack, so out-of-order writes can't resurrect a stale snapshot.
  - File bar UI: chips (switch / inline rename / two-tap delete / new). Undo history is per-file; verdicts + typed reasons survive file switches (keyed by stable line ids).
  - Undo/redo was already in place from the verdicts work; it now also survives reload.
- **M3 — next:** settings UI (model dropdown via /api/models), PNG/SVG export, PWA.

## Deploy notes

- Vercel gotchas hit and solved: `"type": "module"` requires ESM function exports; the Vite preset never routes `[...path].js` catch-alls (use concrete files); `vercel curl` appends `x-vercel-*` bypass query params that must be stripped before forwarding upstream.
- Local dev uses the Hack Club proxy key from `~/.bashrc`; prod uses the OpenRouter key (configured as Vercel env `OPENROUTER_API_KEY`, server-side only).
- Prod is public — anyone with the URL can spend API credits. Vercel dashboard → Deployment Protection can restrict access if needed.

## Milestones

- **M1 — Core loop:** push-to-talk → proxy → JSON → KaTeX on screen. Single line, key server-side. The dy/dx example works end-to-end. ✅
- **M2 — Product:** ~~Dexie files/multi-line~~ → Convex files/multi-line (see Status), conversational editing, transcript captions, confidence states, copy, undo. ✅
- **M3 — Finish:** settings UI (model dropdown), PNG/SVG export, PWA.