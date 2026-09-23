import { readFileSync } from "node:fs";

const K = JSON.parse(readFileSync("/home/bobstevens/.local/share/opencode/auth.json", "utf8")).openrouter.key;
const SYSTEM_PROMPT = readFileSync("/home/bobstevens/mathtex/src/lib/prompt.ts", "utf8")
  .replace(/^export const SYSTEM_PROMPT = `/s, "").replace(/`;$/s, "");

const UTTERANCES = [
  { wav: "/tmp/opencode/mathtex-e2e/test-utterance.wav", expect: ["\\frac{dy}{dx}", "x^{2}"], name: "dydx" },
  { wav: "/tmp/opencode/mathtex-e2e/test-integral.wav", expect: ["\\int", "x^{2}"], name: "integral" },
];

const CONFIGS = [
  { model: "google/gemini-3.8-flash" },
  { model: "google/gemini-3.8-flash", reasoning: { effort: "low" } },
  { model: "google/gemini-3.7-flash", reasoning: { effort: "low" } },
  { model: "google/gemini-3.6-flash", reasoning: { effort: "low" } },
  { model: "google/gemini-3.5-flash-lite" },
  { model: "google/gemini-3.1-flash-lite" },
  { model: "qwen/qwen3.8-omni-flash" },
];

const b64 = Object.fromEntries(
  UTTERANCES.map((u) => [u.name, readFileSync(u.wav).toString("base64")]),
);

async function call(model, uName, extra) {
  const t0 = performance.now();
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
  const ms = Math.round(performance.now() - t0);
  const content = data.choices?.[0]?.message?.content ?? "";
  const reasoning = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  return { ok: res.status === 200, ms, content, reasoning, err: data.error?.message };
}

const results = [];
for (const cfg of CONFIGS) {
  const row = { cfg: cfg.model + (cfg.reasoning ? " +effort:low" : ""), times: [], ok: 0, reasoning: [] };
  for (const u of UTTERANCES) {
    for (let run = 0; run < 2; run++) {
      const r = await call(cfg.model, u.name, { reasoning: cfg.reasoning });
      row.times.push(r.ms);
      if (r.err) { console.log(`  ERR ${row.cfg} ${u.name}: ${r.err?.slice(0, 80)}`); continue; }
      row.reasoning.push(r.reasoning);
      const hit = u.expect.every((e) => r.content.toLowerCase().includes(e.toLowerCase()));
      if (hit) row.ok++;
      if (run === 0 && u.name === "dydx") row.sample = r.content.replace(/\s+/g, " ").slice(0, 110);
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  const avg = row.times.length ? (row.times.reduce((a, b) => a + b) / row.times.length / 1000).toFixed(2) : "n/a";
  const med = row.reasoning.length ? Math.round(row.reasoning.reduce((a, b) => a + b, 0) / row.reasoning.length) : "-";
  console.log(`${row.cfg.padEnd(52)} avg ${(avg + "s").padStart(6)} | correct ${row.ok}/4 | reasoning~${med}`);
  results.push({ ...row, avg: Number(avg) });
}