// Edge function: live poll — transcribe the growing clip, then convert the
// transcript to LaTeX in the same call. POST { audioB64, systemPrompt,
// contextText?, model? } -> { transcript, raw }
// The client renders raw (a standard dictation JSON) as the provisional
// equation; voice canceling emerges from the system prompt's own modes.
import { verifyAuth, unauthorized } from "./_lib.js";

const TARGET = process.env.UPSTREAM_BASE_URL;
const KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_TRANSCRIBER = "fish-audio/transcribe-1";
const CONVERTER = process.env.CONSOLIDATOR_MODEL || "google/gemini-3.5-flash-lite";

export const config = { runtime: "edge" };

const trunc = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

export default async function handler(request) {
  const t0 = Date.now();
  const userId = await verifyAuth(request);
  if (!userId) return unauthorized("missing/invalid/expired token");
  if (!TARGET || !KEY) {
    return Response.json({ error: { message: "Missing UPSTREAM_BASE_URL or OPENROUTER_API_KEY" } }, { status: 500 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }
  const model = typeof body?.model === "string" && body.model ? body.model : DEFAULT_TRANSCRIBER;
  if (!body?.audioB64 || typeof body?.systemPrompt !== "string") {
    return Response.json({ error: { message: "Missing audioB64 or systemPrompt" } }, { status: 400 });
  }
  const bytes = Uint8Array.from(atob(body.audioB64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([bytes]), "audio.wav");

  let transcript = "";
  try {
    const res = await fetch(`${TARGET}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}` },
      body: form,
    });
    const d = await res.json();
    transcript = (d.text ?? "").trim();
  } catch (e) {
    return Response.json({ error: { message: String(e).slice(0, 200) } }, { status: 502 });
  }
  if (!transcript) {
    console.log(JSON.stringify({ route: "transcribe", model, user: userId, transcript: "", ms: Date.now() - t0 }));
    return Response.json({ transcript: "", raw: "" });
  }

  const userText = [
    `ASR transcription of the audio (may be partial and mid-sentence):`,
    JSON.stringify(transcript),
    "",
    body.contextText ? `File context:\n${body.contextText}` : "",
    `Convert this transcription to LaTeX per the rules. If the transcription is or ends with a cancel/scratch/redo instruction, respond per the modes.`,
  ].filter(Boolean).join("\n");

  const chatBody = {
    model: CONVERTER,
    temperature: 0,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: body.systemPrompt },
      { role: "user", content: userText },
    ],
  };

  try {
    const res = await fetch(`${TARGET}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(chatBody),
    });
    if (!res.ok) {
      const errText = await res.text();
      return Response.json({ transcript, error: { message: `Converter ${res.status}: ${errText.slice(0, 150)}` } }, { status: 502 });
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    console.log(
      JSON.stringify({ route: "transcribe", model, user: userId, transcript: trunc(transcript), raw: trunc(content), ms: Date.now() - t0 }),
    );
    return Response.json({ transcript, raw: content, request: JSON.stringify(chatBody) });
  } catch (e) {
    return Response.json({ transcript, error: { message: String(e).slice(0, 200) } }, { status: 502 });
  }
}