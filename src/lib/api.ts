import { SYSTEM_PROMPT } from "./prompt";
import { pcmToWav } from "./wav";
import { authToken, refreshAuthToken } from "./authClient";
import { healJson, type HealedJson } from "./jsonHeal";

export type Mode = "append" | "append_lines" | "replace_line" | "delete_last" | "noop";

/** JSON health of one model response: "clean" parsed as-is, "healed" was
 *  salvaged by healJson without a retry, "repaired" needed the repair
 *  retry, "failed" never parsed (caller keeps the live provisional). */
export type JsonHealth = "clean" | "healed" | "repaired" | "failed";

export interface DictationResult {
  mode: Mode;
  transcript: string;
  lines: string[];
  confidence: number;
  uncertain: boolean;
  note: string;
}

export interface CallContext {
  lines: { latex: string }[];
  targetIndex?: number;
  /** Free-form background the student gave up front (Khan Academy copy, LaTeX,
   * anything) — a prediction hint, never a license to correct their math. */
  source?: string;
}

const BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const MODEL = import.meta.env.VITE_MODEL || "google/gemini-3.8-flash";
// Live poll model (display-only partials during the hold)
const LIVE_TRANSCRIBE_MODEL = String(import.meta.env.VITE_LIVE_TRANSCRIBE_MODEL || "");

/** The Vercel edge functions verify this Convex-issued JWT before touching
 *  the upstream key; omit when signed out (prod gate returns 401). */
export function authHeaders(): Record<string, string> {
  const token = authToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** POST with auth; on 401 the Bearer header was missing or stale (refresh
 *  gap) — force one token refresh and retry before failing the call. */
async function authPost(
  path: string,
  init: { headers?: Record<string, string>; body: string; signal?: AbortSignal },
): Promise<Response> {
  const send = () =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...init.headers, ...authHeaders() },
      body: init.body,
      signal: init.signal,
    });
  let res = await send();
  if (res.status === 401 && (await refreshAuthToken())) {
    res = await send();
  }
  return res;
}

export class ConfigError extends Error {}

function mustConfig(): void {
  if (!MODEL) {
    throw new ConfigError("Missing VITE_MODEL in .env");
  }
}

function contextText(ctx: CallContext): string {
  const background = (ctx.source ?? "").trim();
  const backgroundText = background
    ? `BACKGROUND CONTEXT (material the student is working from — a hint for prediction and disambiguation, never a license to correct their math):\n${background.slice(0, 4000)}\n\n`
    : "";
  if (ctx.lines.length === 0) {
    return `${backgroundText}The file is empty. Listen to the audio and produce the JSON object.`;
  }
  const numbered = ctx.lines
    .map((l, i) => `${i + 1}. ${l.latex || "(empty)"}`)
    .join("\n");
  if (ctx.targetIndex !== undefined && ctx.targetIndex >= 0 && ctx.targetIndex < ctx.lines.length) {
    return `${backgroundText}Current file lines (most recent last):\n${numbered}\n\nLine ${ctx.targetIndex + 1} (${ctx.lines[ctx.targetIndex].latex}) is SELECTED for editing. If the audio explicitly edits this line ("change", "replace", "fix", "make it", "instead", ...), use "replace_line" on it. If the audio is new math, output "append" as a new line — do NOT reshape what was said to resemble the selected line, and never adopt its values as your own. Listen to the audio and produce the JSON object.`;
  }
  return `${backgroundText}Current file lines (most recent last):\n${numbered}\n\nThe audio is NEW dictation to append after line ${ctx.lines.length} as a new line. It should relate naturally to the preceding lines and the background context. Use "replace_line" only if the audio is an explicit edit command for an existing line. Listen to the audio and produce the JSON object.`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Exact request body sent to the LLM, serialized for persistence. Base64
 *  audio payloads are replaced by a placeholder: the clip already lives in
 *  _storage on the same row, and Convex caps documents at 1MB, so verbatim
 *  base64 would fail large writes. */
function requestForDb(body: unknown): string {
  try {
    const clone = JSON.parse(JSON.stringify(body)) as {
      messages?: { content?: unknown }[];
    };
    for (const m of clone.messages ?? []) {
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === "object" && "input_audio" in (part as object)) {
            (part as { input_audio: { data: string } }).input_audio.data =
              "<audio in _storage>";
          }
        }
      }
    }
    return JSON.stringify(clone);
  } catch {
    return "";
  }
}

function stripFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : s;
}


function parseResult(raw: string): { result: DictationResult; healed: boolean } {
  // Salvage fenced/prose-wrapped/truncated payloads before giving up to the
  // (expensive) model repair retry. A truncation-healed parse is missing
  // whatever the model never emitted, so surface it as uncertain.
  // `healed` reports whether the first response needed salvage (anything
  // beyond a direct parse), so callers can record JSON health. Note healJson
  // also returns non-null for clean input, so a direct parse is tried first.
  let obj: Record<string, unknown>;
  let salvage: HealedJson | null = null;
  try {
    obj = JSON.parse(stripFences(raw)) as Record<string, unknown>;
  } catch {
    salvage = healJson(raw);
    if (!salvage) throw new Error(`Invalid JSON in model response: ${raw.slice(0, 120)}`);
    obj = JSON.parse(salvage.json) as Record<string, unknown>;
  }
  const healed = salvage !== null;
  const modes: Mode[] = ["append", "append_lines", "replace_line", "delete_last", "noop"];
  const mode = modes.includes(obj.mode as Mode) ? (obj.mode as Mode) : "append";
  const lines: string[] = Array.isArray(obj.latex)
    ? obj.latex.filter((l): l is string => typeof l === "string")
    : typeof obj.latex === "string"
      ? [obj.latex]
      : [];
  const transcript = typeof obj.transcript === "string" ? obj.transcript : "";
  const confidence =
    typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1
      ? obj.confidence
      : 0.8;
  const note = typeof obj.note === "string" ? obj.note : "";
  const uncertain = obj.uncertain === true || (salvage?.truncated ?? false);
  const needsLatex = mode === "append" || mode === "append_lines" || mode === "replace_line";
  if (needsLatex && lines.length === 0) {
    throw new Error(`Missing "latex" in model response: ${JSON.stringify(obj).slice(0, 200)}`);
  }
  if (mode === "append_lines" && lines.length < 2) {
    throw new Error(`"append_lines" requires multiple lines: ${JSON.stringify(obj).slice(0, 200)}`);
  }
  return { result: { mode, transcript, lines, confidence, uncertain, note }, healed };
}

export async function dictate(
  wav: ArrayBuffer,
  ctx: CallContext,
  opts?: { signal?: AbortSignal; vadStats?: string; asr?: string },
): Promise<{ result: DictationResult; request: string; jsonHealth: JsonHealth }> {
  return dictateAudioLlm(wav, ctx, opts);
}

export const liveTranscriptionEnabled = (): boolean => LIVE_TRANSCRIBE_MODEL.length > 0;

/** Live poll during hold: transcribe the clip, convert to LaTeX, return both. */
export async function liveConvert(
  pcm: Float32Array,
  ctx: CallContext,
): Promise<{ transcript: string; result: DictationResult | null; request: string }> {
  const res = await authPost("/transcribe", {
    headers: {},
    body: JSON.stringify({
      audioB64: arrayBufferToBase64(pcmToWav(pcm)),
      systemPrompt: SYSTEM_PROMPT,
      contextText: contextText(ctx),
      model: LIVE_TRANSCRIBE_MODEL || undefined,
    }),
  });
  if (!res.ok) throw new Error(`live convert ${res.status}`);
  const data = (await res.json()) as { transcript?: string; raw?: string; request?: string };
  const transcript = (data.transcript ?? "").trim();
  let result: DictationResult | null = null;
  if (data.raw) {
    try {
      result = parseResult(data.raw).result;
    } catch {
      result = null;
    }
  }
  return { transcript, result, request: data.request ?? "" };
}

async function dictateAudioLlm(
  wav: ArrayBuffer,
  ctx: CallContext,
  opts?: { signal?: AbortSignal; vadStats?: string; asr?: string },
): Promise<{ result: DictationResult; request: string; jsonHealth: JsonHealth }> {
  mustConfig();
  const signal = opts?.signal;
  const b64 = arrayBufferToBase64(wav);

  // The live poll already ran a neutral ASR (fish-audio) on this clip while
  // recording; pass its hearing to the audio LLM as a cross-check witness.
  const asrText = (opts?.asr ?? "").trim();
  const text = asrText
    ? `${contextText(ctx)}\n\nASR CROSS-CHECK (an independent speech-to-text pass over the same audio; it may mishear — per the system prompt's DUAL EVIDENCE rules): ${asrText}`
    : contextText(ctx);

  const messages: unknown[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text },
        { type: "input_audio", input_audio: { data: b64, format: "wav" } },
      ],
    },
  ];

  const callOnce = async (
    useJsonFormat: boolean,
  ): Promise<{ content: string; body: Record<string, unknown> }> => {
    const body: Record<string, unknown> = {
      model: MODEL,
      temperature: 0,
      max_tokens: 400,
      stream: true,
      ...(useJsonFormat ? { response_format: { type: "json_object" } } : {}),
      messages,
    };
    const res = await authPost("/chat/completions", {
      headers: {
        // Client-side VAD diagnostics for the server logs; stripped by the
        // proxy before forwarding upstream.
        ...(opts?.vadStats ? { "x-vad-stats": opts.vadStats.slice(0, 300) } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const err = new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return { content: await readContent(res), body };
  };

  let content: string;
  let accepted: Record<string, unknown>;
  try {
    ({ content, body: accepted } = await callOnce(true));
  } catch (e) {
    if ((e as Error & { status?: number }).status === 400) {
      ({ content, body: accepted } = await callOnce(false));
    } else {
      throw e;
    }
  }

  try {
    const parsed = parseResult(content);
    return {
      result: parsed.result,
      request: requestForDb(accepted),
      jsonHealth: parsed.healed ? "healed" : "clean",
    };
  } catch {
    const retryBody = {
      model: MODEL,
      temperature: 0,
      // Headroom above the main call: if the first response was cut off by
      // max_tokens, a repair at the same cap tends to truncate identically.
      max_tokens: 700,
      messages: [
        ...messages,
        { role: "assistant", content },
        {
          role: "user",
          content: `That was not valid JSON (${(content || "").slice(0, 120)}). Reply with ONLY the corrected JSON object in the required shape.`,
        },
      ],
    };
    const retryRes = await authPost("/chat/completions", {
      body: JSON.stringify(retryBody),
      signal,
    });
    if (!retryRes.ok) {
      throw new Error(`API ${retryRes.status} on retry`);
    }
    const data = (await retryRes.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const retryContent = data.choices?.[0]?.message?.content;
    if (!retryContent) throw new Error("Model returned empty response on retry");
    const parsed = parseResult(retryContent);
    return {
      result: parsed.result,
      request: requestForDb(retryBody),
      // First response failed to parse, so even a clean retry counts as repaired.
      jsonHealth: "repaired",
    };
  }
}

async function readContent(res: Response): Promise<string> {
  if (!res.body) {
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return content;
      try {
        const j = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = j.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          content += delta;
        }
      } catch {
        /* partial SSE line */
      }
    }
  }
  return content;
}