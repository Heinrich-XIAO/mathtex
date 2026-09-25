import * as ort from "onnxruntime-web/wasm";

// Silero VAD (public/vad/silero_vad.onnx). Runs locally, ~1ms per 512-sample
// frame via WASM. Analysis runs in parallel with the API call — never
// sequentially — and the verdict is advisory: finish() soft-gates on it
// (confidence guard for low-speech clips) rather than discarding outright,
// because Silero under-reports whispered speech buried in loud noise.
// Calling convention matches @ricky0123/vad-web's proven Silero usage:
// 512-sample frames with a rolling 64-sample context, state [2,1,128],
// sr as an int64 tensor of dims [1].
let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      ort.env.wasm.numThreads = 1; // no SharedArrayBuffer/COOP needed
      // No proxy worker: ORT 1.30's worker needs variant wasm files we don't
      // ship. Session is warmed at mic press so compile cost hides in the hold.
      ort.env.wasm.wasmPaths = "/ort/"; // same-origin, no CORS/CDN dependency
      return ort.InferenceSession.create("/vad/silero_vad.onnx", {
        executionProviders: ["wasm"],
      });
    })();
  }
  return sessionPromise;
}

/** Pre-warms the ORT session; call when the mic is pressed so the WASM
 * compile (the expensive part) happens while the user is still speaking. */
export function warmVad(): void {
  void getSession();
}

const CHUNK = 512; // 32ms @ 16kHz
const CONTEXT = 64;
// Stock Silero bar is 0.5, tuned for normal voiced speech. Whispers carry no
// fundamental frequency, so their probability lands well below it — 0.35 keeps
// the frame counting for quiet speech while still rejecting bus-level noise.
const SPEECH_PROB = 0.35;

export interface SpeechAnalysis {
  ok: boolean;
  speechMs: number;
  /** Highest per-frame speech probability Silero produced. */
  maxProb: number;
  /** Average per-frame speech probability across the whole clip. */
  meanProb: number;
  /** Total 32ms frames analyzed. */
  frames: number;
}

export async function analyzeSpeech(
  pcm: Float32Array,
  sampleRate = 16000,
): Promise<SpeechAnalysis> {
  try {
    const session = await getSession();
    let state: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    const sr = new ort.Tensor("int64", [BigInt(sampleRate)]);
    let context = new Float32Array(CONTEXT);
    let frames = 0;
    let total = 0;
    let maxProb = 0;
    let sumProb = 0;

    for (let off = 0; off + CHUNK <= pcm.length; off += CHUNK) {
      const frame = pcm.slice(off, off + CHUNK);
      const input = new Float32Array(CONTEXT + CHUNK);
      input.set(context, 0);
      input.set(frame, CONTEXT);
      const out = await session.run({
        input: new ort.Tensor("float32", input, [1, input.length]),
        state,
        sr,
      });
      if (!out["stateN"] || !out["output"]) throw new Error("Silero returned no state");
      state = out["stateN"];
      const prob = (out["output"].data as Float32Array)[0];
      if (prob > SPEECH_PROB) frames++;
      if (prob > maxProb) maxProb = prob;
      sumProb += prob;
      total++;
      context = frame.slice(-CONTEXT);
    }
    return {
      ok: true,
      speechMs: Math.round((frames * CHUNK * 1000) / sampleRate),
      maxProb: Math.round(maxProb * 1000) / 1000,
      meanProb: total > 0 ? Math.round((sumProb / total) * 1000) / 1000 : 0,
      frames,
    };
  } catch {
    return { ok: false, speechMs: 0, maxProb: 0, meanProb: 0, frames: 0 };
  }
}