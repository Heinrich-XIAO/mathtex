import { readFileSync } from "node:fs";
const K = JSON.parse(readFileSync("/home/bobstevens/.local/share/opencode/auth.json", "utf8")).openrouter.key;
const SYSTEM_PROMPT = readFileSync("/home/bobstevens/mathtex/src/lib/prompt.ts", "utf8").replace(/^export const SYSTEM_PROMPT = `/s, "").replace(/`;$/s, "");
const UTTERANCES = [
  { wav: "/tmp/opencode/mathtex-e2e/test-utterance.wav", name: "dydx" },
  { wav: "/tmp/opencode/mathtex-e2e/test-integral.wav", name: "integral" },
];
const CONFIGS = [
  { model: "google/gemini-3.5-flash-lite" },
  { model: "google/gemini-3.1-flash-lite" },
  { model: "google/gemini-3.6-flash", reasoning: { effort: "low" } },
];
const b64 = Object.fromEntries(UTTERANCES.map((u) => [u.name, readFileSync(u.wav).toString("base64")]));
const norm = (s) => s.toLowerCase().replace(/\^\{(\w+)\}/g, "^$1").replace(/\s+/g, " ");
async function call(model, uName) {
  const t0 = performance.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${K}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 400, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [
          { type: "text", text: "The file is empty. Listen to the audio and produce the JSON object." },
          { type: "input_audio", input_audio: { data: b64[uName], format: "wav" } },
        ]},
      ] }),
  });
  const data = await res.json();
  return { ms: Math.round(performance.now() - t0), content: data.choices?.[0]?.message?.content ?? "", err: data.error?.message };
}
for (const cfg of CONFIGS) {
  console.log("=== " + cfg.model);
  for (const u of UTTERANCES) {
    for (let run = 0; run < 3; run++) {
      const r = await call(cfg.model, u.name);
      const latex = (() => { try { return JSON.parse(r.content.replace(/^```(json)?|```$/g, "")).latex; } catch { return "PARSE_FAIL: " + r.content.slice(0, 90); } })();
      console.log(`  ${u.name.padEnd(9)} ${String(r.ms).padStart(5)}ms  ${latex}`);
      await new Promise((res) => setTimeout(res, 400));
    }
  }
}
