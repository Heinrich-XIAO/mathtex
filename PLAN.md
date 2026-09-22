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
| Keys | Use the machine's existing key — `OPENROUTER_API_KEY` in `~/.bashrc:31` is a **Hack Club AI proxy** key (`sk-hc-v1`), not an OpenRouter key |
| Endpoint | `https://ai.hackclub.com/proxy/v1` (OpenAI-compatible chat completions) |
| Model | Dropdown over the proxy's OpenRouter-style catalog; default = audio-capable Gemini Flash |
| Config | Key lives in a gitignored `.env`; never in code, never committed |

## Architecture

```
[ Mic (MediaRecorder, opus) ]
        │  push-to-talk release
        ▼
[ WAV encode (mono 16 kHz PCM16, client-side) ]
        ▼
[ Hack Club proxy: audio-capable LLM ]   ← one call: audio + context
        │  strict JSON response
        ▼
[ Zod validation + one auto-retry ] → [ KaTeX render ] → [ line in file ]
        ▼
[ IndexedDB (Dexie): files, lines, audio blobs ]
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

## Milestones

- **M1 — Core loop:** push-to-talk → proxy → JSON → KaTeX on screen. Single line, key from `.env`. The dy/dx example works end-to-end.
- **M2 — Product:** Dexie files/multi-line, conversational editing, transcript captions, confidence states, copy.
- **M3 — Finish:** settings UI (model dropdown), PNG/SVG export, undo, PWA.