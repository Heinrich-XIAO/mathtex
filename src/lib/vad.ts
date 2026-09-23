import * as ort from "onnxruntime-web";

// Silero VAD (public/vad/silero_vad.onnx). Runs locally, ~1ms per 512-sample
// frame via WASM. Analysis runs in parallel with the API call — never
// sequentially — and a no-speech result discards the response at the end.
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

export interface SpeechAnalysis {
  ok: boolean;
  speechMs: number;
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
      if ((out["output"].data as Float32Array)[0] > 0.5) frames++;
      context = frame.slice(-CONTEXT);
    }
    return { ok: true, speechMs: Math.round((frames * CHUNK * 1000) / sampleRate) };
  } catch {
    return { ok: false, speechMs: 0 };
  }
}