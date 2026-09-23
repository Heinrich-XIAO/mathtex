import { SYSTEM_PROMPT } from "./prompt";

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
}

const BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const MODEL = import.meta.env.VITE_MODEL || "google/gemini-3.5-flash-lite";

export class ConfigError extends Error {}

function mustConfig(): void {
  if (!MODEL) {
    throw new ConfigError("Missing VITE_MODEL in .env");
  }
}

function contextText(ctx: CallContext): string {
  if (ctx.lines.length === 0) {
    return "The file is empty. Listen to the audio and produce the JSON object.";
  }
  const numbered = ctx.lines
    .map((l, i) => `${i + 1}. ${l.latex || "(empty)"}`)
    .join("\n");
  if (ctx.targetIndex !== undefined && ctx.targetIndex >= 0 && ctx.targetIndex < ctx.lines.length) {
    return `Current file lines (most recent last):\n${numbered}\n\nTARGET LINE: line ${ctx.targetIndex + 1} (${ctx.lines[ctx.targetIndex].latex}). The audio is an edit instruction for THIS line only. Listen to the audio and produce the JSON object.`;
  }
  return `Current file lines (most recent last):\n${numbered}\n\nThe current line is line ${ctx.lines.length}. Listen to the audio and produce the JSON object.`;
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

function parseResult(raw: string): DictationResult {
  const obj = JSON.parse(stripFences(raw)) as Record<string, unknown>;
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
  opts?: { signal?: AbortSignal },
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