// Edge function: quick single-model transcription for the live ghost line.
// POST { audioB64, model? } -> { transcript }
const TARGET = process.env.UPSTREAM_BASE_URL;
const KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL = "fish-audio/transcribe-1";

export const config = { runtime: "edge" };

export default async function handler(request) {
  if (!TARGET || !KEY) {
    return Response.json({ error: { message: "Missing UPSTREAM_BASE_URL or OPENROUTER_API_KEY" } }, { status: 500 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }
  const model = typeof body?.model === "string" && body.model ? body.model : DEFAULT_MODEL;
  if (!body?.audioB64) {
    return Response.json({ error: { message: "Missing audioB64" } }, { status: 400 });
  }
  const bytes = Uint8Array.from(atob(body.audioB64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([bytes]), "audio.wav");
  try {
    const res = await fetch(`${TARGET}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}` },
      body: form,
    });
    const d = await res.json();
    return Response.json({ transcript: (d.text ?? "").trim() });
  } catch (e) {
    return Response.json({ error: { message: String(e).slice(0, 200) } }, { status: 502 });
  }
}