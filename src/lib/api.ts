import { SYSTEM_PROMPT, REASON_PROMPT } from "./prompt";
import { pcmToWav } from "./wav";

export type Mode = "append" | "append_lines" | "replace_line" | "delete_last" | "noop";

export interface DictationResult {
  mode: Mode;
  transcript: string;
  lines: string[];
  confidence: number;
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
    return `${backgroundText}Current file lines (most recent last):\n${numbered}\n\nTARGET LINE: line ${ctx.targetIndex + 1} (${ctx.lines[ctx.targetIndex].latex}). The audio is an edit instruction for THIS line only. Listen to the audio and produce the JSON object.`;
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

function stripFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : s;
}

/** JSON.parse with a fallback for models that emit LaTeX backslashes unescaped (\frac, \int). */
function parseJsonLenient(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return JSON.parse(sanitizeJsonBackslashes(content));
  }
}

// Walk the string respecting valid \\ pairs: double any lone backslash that
// isn't already a valid JSON escape.
function sanitizeJsonBackslashes(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      out += s[i];
      continue;
    }
    const next = s[i + 1] ?? "";
    if (next === "\\" || /^["/bfnrtu]$/.test(next)) {
      out += s.slice(i, i + 2);
      i += 1;
    } else {
      out += "\\\\";
    }
  }
  return out;
}

function parseResult(raw: string): DictationResult {  const obj = JSON.parse(stripFences(raw)) as Record<string, unknown>;
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
  const needsLatex = mode === "append" || mode === "append_lines" || mode === "replace_line";
  if (needsLatex && lines.length === 0) {
    throw new Error(`Missing "latex" in model response: ${JSON.stringify(obj).slice(0, 200)}`);
  }
  if (mode === "append_lines" && lines.length < 2) {
    throw new Error(`"append_lines" requires multiple lines: ${JSON.stringify(obj).slice(0, 200)}`);
  }
  return { mode, transcript, lines, confidence, note };
}

export async function dictate(
  wav: ArrayBuffer,
  ctx: CallContext,
  opts?: { signal?: AbortSignal; vadStats?: string },
): Promise<DictationResult> {
  return dictateAudioLlm(wav, ctx, opts);
}

export const liveTranscriptionEnabled = (): boolean => LIVE_TRANSCRIBE_MODEL.length > 0;

/** Transcribe the "what's wrong" reason clip verbatim — no math conversion. */
export async function transcribeReason(wav: ArrayBuffer): Promise<string> {
  mustConfig();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: REASON_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "The student just marked a math line wrong. Transcribe what they said is wrong with it." },
            { type: "input_audio", input_audio: { data: arrayBufferToBase64(wav), format: "wav" } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? "";
  try {
    const obj = parseJsonLenient(stripFences(content)) as { reason?: unknown };
    if (typeof obj.reason === "string" && obj.reason.trim()) return obj.reason.trim();
  } catch {
    /* fall through to raw text */
  }
  return content.trim().slice(0, 400);
}

/** Live poll during hold: transcribe the clip, convert to LaTeX, return both. */
export async function liveConvert(
  pcm: Float32Array,
  ctx: CallContext,
): Promise<{ transcript: string; result: DictationResult | null }> {
  const res = await fetch(`${BASE}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audioB64: arrayBufferToBase64(pcmToWav(pcm)),
      systemPrompt: SYSTEM_PROMPT,
      contextText: contextText(ctx),
      model: LIVE_TRANSCRIBE_MODEL || undefined,
    }),
  });
  if (!res.ok) throw new Error(`live convert ${res.status}`);
  const data = (await res.json()) as { transcript?: string; raw?: string };
  const transcript = (data.transcript ?? "").trim();
  let result: DictationResult | null = null;
  if (data.raw) {
    try {
      result = parseResult(data.raw);
    } catch {
      result = null;
    }
  }
  return { transcript, result };
}

async function dictateAudioLlm(
  wav: ArrayBuffer,
  ctx: CallContext,
  opts?: { signal?: AbortSignal; vadStats?: string },
): Promise<DictationResult> {
  mustConfig();
  const signal = opts?.signal;
  const b64 = arrayBufferToBase64(wav);

  const messages: unknown[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: contextText(ctx) },
        { type: "input_audio", input_audio: { data: b64, format: "wav" } },
      ],
    },
  ];

  const callOnce = async (useJsonFormat: boolean): Promise<string> => {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Client-side VAD diagnostics for the server logs; stripped by the
        // proxy before forwarding upstream.
        ...(opts?.vadStats ? { "x-vad-stats": opts.vadStats.slice(0, 300) } : {}),
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 400,
        stream: true,
        ...(useJsonFormat ? { response_format: { type: "json_object" } } : {}),
        messages,
      }),
      signal,
    });
    if (!res.ok) {
      const err = new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return readContent(res);
  };

  let content: string;
  try {
    content = await callOnce(true);
  } catch (e) {
    if ((e as Error & { status?: number }).status === 400) {
      content = await callOnce(false);
    } else {
      throw e;
    }
  }

  try {
    return parseResult(content);
  } catch {
    const retryRes = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 400,
        messages: [
          ...messages,
          { role: "assistant", content },
          {
            role: "user",
            content: `That was not valid JSON (${(content || "").slice(0, 120)}). Reply with ONLY the corrected JSON object in the required shape.`,
          },
        ],
      }),
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
    return parseResult(retryContent);
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