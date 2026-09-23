# Latency & architecture benchmarks (experimental record)

All scripts in this folder were run on 2026-09-22 against OpenRouter with the
espeak-synthesized spoken-math battery (8 utterances: dydx, integral, sum,
sqrt, frac, exp, greek, limit). The shipped app does NOT use any of this —
these were experiments explored to reduce latency / improve accuracy.

## Outcome

Shipped: single audio-in LLM, `google/gemini-3.5-flash-lite` (~1.5s prod
end-to-end, streaming SSE + progressive transcript). Everything below was
rejected on data.

## 1. Model matrix (audio-in chat models)

| Config | Avg | Correct |
|---|---|---|
| gemini-3.8-flash (baseline) | 6.92s | 1/4* |
| gemini-3.8-flash + effort:low | 5.44s | 3/4* |
| gemini-3.7-flash + effort:low | 2.92s | 2/4* |
| gemini-3.6-flash + effort:low | 1.86s | 2/4* |
| **gemini-3.5-flash-lite** | **1.32s** | **3/4* / 6/6 normalized** |
| gemini-3.1-flash-lite | 1.34s | 2/4* |
| qwen/qwen3.8-omni-flash | 7.57s | 0/4* |

*early runs used an over-strict checker (required literal `x^{2}`); normalized
rerun confirmed flash-lite 6/6 including dydx + integral.

## 2. "First three audio-capable models in API order" (all Xiaomi MiMo)

| Model | Avg | Correct |
|---|---|---|
| google/gemini-3.5-flash-lite | 1.39s | 6/6 |
| xiaomi/mimo-v2.6-pro-ultraspeed | 8.49s | 4/6 |
| xiaomi/mimo-v2.6-flash | 4.71s | 6/6 |
| xiaomi/mimo-v2.6-pro | 9.28s | 4/6 |

Despite the name, "ultraspeed" is 6x slower. Two MiMo variants return empty
latex on the limit case.

## 3. Ensemble: 5 parallel audio-in LLMs -> text consolidator

Configs: 3.5-flash-lite + 3.1-flash-lite + 3.6-flash(low) + qwen3.8-omni +
nemotron-3-nano-omni:free in parallel, then flash-lite merges candidates.

Result: **21.77s avg** (bound by slowest member; nemotron/qwen outliers up to
81s), 8/8 correct. No accuracy gain over single flash-lite; rejected.

## 4. Transcription ensemble: 5 parallel ASR -> text consolidator

Layer 1 (parallel): whisper-1, gpt-4o-mini-transcribe, gpt-4o-transcribe,
whisper-large-v3-turbo, deepgram/nova-3. Layer 2: flash-lite merges transcripts.

Result: **3.41s avg, 7/8** vs baseline 1.57s / 8/8.

- Strength: repair-by-majority works. All ASR garbled "dy dx" ("IDX", "idea x",
  "I d x") except gpt-4o-transcribe (verbatim "dy/dx equals x squared times x
  cubed"); consolidator produced perfect `\frac{dy}{dx} = x^2(x^3)`.
  Hallucinations from nova-3 / whisper-large-v3-turbo get outvoted.
- Weakness: when ALL ASR miss something it is unrecoverable — "a over b equals
  c" -> every model dropped the leading "a" -> `\frac{1}{b}` (MISS). The
  audio-native model hears the full audio and got it right.
- Verdict: a robustness play, not a latency play. Could return later as a
  hybrid: single flash-lite primary; confidence < 0.7 fans out to the ASR
  ensemble for a second opinion.

## Raw layer-1 transcripts (dydx case)

- whisper-1: "idx equals x squared times x cubed"
- gpt-4o-mini-transcribe: "Ideax equals x squared times x cubed."
- gpt-4o-transcribe: "dy/dx equals x squared times x cubed"
- whisper-large-v3-turbo: "IDX equals X squared times X cubed."
- nova-3: "I d x equal x squared times x cubed."

## Known cosmetic bug (from battery)

flash-lite occasionally emits double backslash (`\\sqrt{x} + 1` instead of
`\sqrt{x} + 1`) — renders as a line-break before the radical. Consider a small
output sanitizer in M2.

## Caveats

espeak's robotic TTS likely flatters audio-native models and penalizes ASR;
8-case synthetic battery is directional.