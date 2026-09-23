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

const b64 = Object.fromEntries(CASES.map((c) => [c.name, readFileSync(c.wav).toString("base64")]));
const norm = (s) => s.toLowerCase().replace(/\^\{(\w+)\}/g, "^$1").replace(/_/g, "_").replace(/\s+/g, " ");

const STAGE1 = [
  { model: "google/gemini-3.5-flash-lite" },
  { model: "google/gemini-3.1-flash-lite" },
  { model: "google/gemini-3.6-flash", reasoning: { effort: "low" } },
  { model: "qwen/qwen3.8-omni-flash" },
  { model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" },
];

async function audioCall(model, uName, extra = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${K}` },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 400, response_format: { type: "json_object" },
        ...extra,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [
            { type: "text", text: "The file is empty. Listen to the audio and produce the JSON object." },
            { type: "input_audio", input_audio: { data: b64[uName], format: "wav" } },
          ]},
        ],
      }),
    });
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    let latex = "", transcript = "";
    try { const j = JSON.parse(content.replace(/^```(json)?|```$/g, "")); latex = j.latex ?? ""; transcript = j.transcript ?? ""; } catch {}
    return { ok: res.status === 200 && !!latex, ms: Math.round(performance.now() - t0), latex, transcript };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), latex: "", transcript: "", err: String(e).slice(0, 80) };
  }
}

async function consolidate(candidates, uName) {
  const list = candidates
    .map((c, i) => `Candidate ${i + 1} (from ${c.model}):\n  transcript: ${JSON.stringify(c.transcript)}\n  latex: ${JSON.stringify(c.latex)}`)
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
        { role: "user", content: `${list}\n\nThese are ${candidates.length} independent outputs of different speech-to-LaTeX models transcribing the SAME single audio utterance. Merge them into the single most plausible interpretation (follow the majority where they agree; prefer complete over fragmentary). Output ONLY the standard JSON object in the required key order.` },
      ],
    }),
  });
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  let latex = "";
  try { latex = JSON.parse(content).latex ?? ""; } catch {}
  return { ms: Math.round(performance.now() - t0), latex, ok: !!latex };
}

async function baseline(uName) {
  return audioCall("google/gemini-3.5-flash-lite", uName);
}

console.log("=== single-model baseline (flash-lite) ===");
let baseOk = 0;
const baseTimes = [];
for (const c of CASES) {
  const r = await audioCall("google/gemini-3.5-flash-lite", c.name);
  baseTimes.push(r.ms);
  const hit = norm(r.latex).includes(norm(c.expect[0])) && c.expect.every((e) => norm(r.latex).includes(e.toLowerCase()));
  if (hit) baseOk++;
  console.log(`  ${c.name.padEnd(9)} ${String(r.ms).padStart(5)}ms ${hit ? "OK " : "MISS"} ${r.latex.slice(0, 70)}`);
  await new Promise((r2) => setTimeout(r2, 300));
}
console.log(`baseline: ${(baseTimes.reduce((a, b) => a + b, 0) / baseTimes.length / 1000).toFixed(2)}s avg, ${baseOk}/${CASES.length} correct`);

console.log("=== ensemble (5 parallel audio models -> text consolidator) ===");
let ensOk = 0;
const ensTimes = [];
for (const c of CASES) {
  const t0 = performance.now();
  const stage1 = await Promise.all(STAGE1.map((s) => audioCall(s.model, c.name, { reasoning: s.reasoning })));
  const s1ms = Math.max(...stage1.map((r) => r.ms));
  const s2 = await consolidate(stage1, c.name);
  const total = Math.round(performance.now() - t0);
  ensTimes.push(total);
  const hit = c.expect.every((e) => norm(s2.latex).includes(e.toLowerCase()));
  if (hit) ensOk++;
  console.log(`  ${c.name.padEnd(9)} s1=${String(s1ms).padStart(5)}ms s2=${String(s2.ms).padStart(5)}ms total=${String(total).padStart(5)}ms ${hit ? "OK " : "MISS"} ${s2.latex.slice(0, 60)}`);
  await new Promise((r2) => setTimeout(r2, 300));
}
console.log(`ensemble: ${(ensTimes.reduce((a, b) => a + b, 0) / ensTimes.length / 1000).toFixed(2)}s avg, ${ensOk}/${CASES.length} correct`);