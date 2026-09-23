// Edge function: ensemble transcription.
// POST { audioB64, systemPrompt, contextText, models? }
// Fans the audio out to N low-latency ASR models in parallel, then runs the
// consolidator LLM over the transcripts (with the client's system prompt and
// file context) to produce the standard dictation JSON. Returns the raw
// consolidated content plus the candidate transcripts for debugging.
const TARGET = process.env.UPSTREAM_BASE_URL;
const KEY = process.env.OPENROUTER_API_KEY;
const CONSOLIDATOR = process.env.CONSOLIDATOR_MODEL || "google/gemini-3.5-flash-lite";
const DEFAULT_MODELS = ["fish-audio/transcribe-1", "microsoft/mai-transcribe-2", "nvidia/parakeet-tdt-0.6b-v3"];

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
  const { audioB64, systemPrompt, contextText, models: requestedModels } = body ?? {};
  if (!audioB64) {
    return Response.json({ error: { message: "Missing audioB64" } }, { status: 400 });
  }

  const wavBytes = Uint8Array.from(atob(audioB64), (c) => c.charCodeAt(0));
  const models = Array.isArray(requestedModels) && requestedModels.length > 0
    ? requestedModels
    : DEFAULT_MODELS;

  const t0 = Date.now();
  const candidates = await Promise.all(
    models.map(async (model) => {
      try {
        const form = new FormData();
        form.append("model", model);
        form.append("file", new Blob([wavBytes]), "audio.wav");
        const res = await fetch(`${TARGET}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}` },
          body: form,
        });
        const d = await res.json();
        return { model, ms: Date.now() - t0, text: (d.text ?? "").trim() };
      } catch (e) {
        return { model, ms: Date.now() - t0, text: "", error: String(e).slice(0, 120) };
      }
    }),
  );

  const good = candidates.filter((c) => c.text);
  if (good.length === 0) {
    // Nothing was heard — skip the consolidation LLM call entirely
    return Response.json({ mode: "noop", lines: [], confidence: 0, note: "no speech detected by any transcriber", candidates });
  }

  const list = good
    .map((c, i) => `Candidate ${i + 1} (from ${c.model}): ${JSON.stringify(c.text)}`)
    .join("\n");
  const mergeNote =
    `These are ${good.length} independent ASR transcriptions of the SAME spoken-math utterance by a student. ` +
    `ASR models often garble spoken math symbols (e.g. "dy dx" may appear as "IDX", "i dx", "d x"). ` +
    `Merge them into the single most plausible reading (majority signal wins; use the phrase glossary to repair garbled symbols). ` +
    `Then produce the LaTeX. Output ONLY the standard JSON object in the required key order.`;
  const userText = [list, contextText ?? "", mergeNote].filter(Boolean).join("\n\n");

  try {
    const res = await fetch(`${TARGET}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: CONSOLIDATOR,
        temperature: 0,
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return Response.json({ error: { message: `Consolidator ${res.status}: ${errText.slice(0, 150)}` }, candidates }, { status: 502 });
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    return Response.json({ raw: content, candidates });
  } catch (e) {
    return Response.json({ error: { message: `Consolidator error: ${String(e).slice(0, 200)}` }, candidates }, { status: 502 });
  }
}