import { readFileSync } from "node:fs";

const K = JSON.parse(readFileSync("/home/bobstevens/.local/share/opencode/auth.json", "utf8")).openrouter.key;
const SYSTEM_PROMPT = readFileSync("/home/bobstevens/mathtex/src/lib/prompt.ts", "utf8")
  .replace(/^export const SYSTEM_PROMPT = `/s, "").replace(/`;$/s, "");

const CASES = [
  { wav: "test-dydx.wav", name: "dydx", expect: ["\\frac{dy}{dx}", "x^2"] },
  { wav: "test-integral.wav", name: "integral", expect: ["\\int", "x^2"] },
  { wav: "test-sum.wav", name: "sum", expect: ["\\sum", "i^2"] },
  { wav: "test-sqrt.wav", name: "sqrt", expect: ["\\sqrt"] },
  { wav: "test-frac.wav", name: "frac", expect: ["\\frac{a}{b}"] },
  { wav: "test-exp.wav", name: "exp", expect: ["e^"] },
  { wav: "test-greek.wav", name: "greek", expect: ["\\alpha", "\\beta"] },
  { wav: "test-limit.wav", name: "limit", expect: ["\\lim", "\\frac", "\\sin"] },
];

const TX_MODELS = [
  "openai/whisper-1",
  "openai/gpt-4o-mini-transcribe",
  "openai/gpt-4o-transcribe",
  "openai/whisper-large-v3-turbo",
  "deepgram/nova-3",
];

const norm = (s) => s.toLowerCase().replace(/\^\{(\w+)\}/g, "^$1").replace(/\s+/g, " ");

async function transcribe(model, file) {
  const t0 = performance.now();
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([readFileSync(`/tmp/opencode/mathtex-e2e/${file}`)]), file);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${K}` },
      body: form,
    });
    const data = await res.json();
    return { ok: !!data.text, ms: Math.round(performance.now() - t0), text: (data.text ?? "").trim() };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), text: "", err: String(e).slice(0, 60) };
  }
}

async function consolidate(transcripts, name) {
  const list = transcripts
    .map((t, i) => `Candidate ${i + 1}: ${JSON.stringify(t)}`)
    .join("\n");
  const t0 = performance.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${K}` },
    body: JSON.stringify({
      model: "google/gemini-3.5-flash-lite", temperature: 0, max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `These are ${transcripts.length} independent ASR transcriptions of the SAME spoken-math utterance by a student. Transcription models often garble spoken math symbols (e.g. "dy dx" may appear as "IDX", "idea x", "I d x"). Merge them into the single most plausible reading (majority signal wins; use the phrase glossary to repair symbol garbling). Then produce the LaTeX. Output ONLY the standard JSON object in the required key order.\n\n${list}` },
      ],
    }),
  });
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  let latex = "";
  try { latex = JSON.parse(content).latex ?? ""; } catch {}
  return { ms: Math.round(performance.now() - t0), latex, ok: !!latex };
}

console.log("=== transcripts (layer 1 quality) ===");
const report = [];
let ensOk = 0;
const ensTimes = [];
for (const c of CASES) {
  const t0 = performance.now();
  const layer1 = await Promise.all(TX_MODELS.map((m) => transcribe(m, c.wav)));
  const s1ms = Math.max(...layer1.map((r) => r.ms));
  const s2 = await consolidate(layer1.map((r) => r.text), c.name);
  const total = Math.round(performance.now() - t0);
  ensTimes.push(total);
  const hit = c.expect.every((e) => norm(s2.latex).includes(e.toLowerCase()));
  if (hit) ensOk++;
  console.log(`  ${c.name.padEnd(9)} s1=${String(s1ms).padStart(5)}ms s2=${String(s2.ms).padStart(5)}ms total=${String(total).padStart(5)}ms ${hit ? "OK  " : "MISS"} ${s2.latex.slice(0, 70)}`);
  report.push({ name: c.name, transcripts: layer1.map((r, i) => `${TX_MODELS[i].split("/")[1]}: "${r.text}"`), final: s2.latex });
  await new Promise((r2) => setTimeout(r2, 300));
}
console.log(`ensemble-TX: ${(ensTimes.reduce((a, b) => a + b, 0) / ensTimes.length / 1000).toFixed(2)}s avg, ${ensOk}/${CASES.length} correct`);
console.log("\n=== raw transcripts ===");
for (const r of report) console.log(`\n[${r.name}]\n  ` + r.transcripts.join("\n  "));