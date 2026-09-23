import { readFileSync } from "node:fs";

const K = JSON.parse(readFileSync("/home/bobstevens/.local/share/opencode/auth.json", "utf8")).openrouter.key;
const SYSTEM_PROMPT = readFileSync("/home/bobstevens/mathtex/src/lib/prompt.ts", "utf8")
  .replace(/^export const SYSTEM_PROMPT = `/s, "").replace(/`;$/s, "");

const CASES = [
  { wav: "test-dydx.wav", name: "dydx", expect: ["\\frac{dy}{dx}", "x^2"] },
  { wav: "test-integral.wav", name: "integral", expect: ["\\int", "x^2"] },
  { wav: "test-limit.wav", name: "limit", expect: ["\\lim", "\\frac", "\\sin"] },
];
const b64 = Object.fromEntries(CASES.map((c) => [c.name, readFileSync(c.wav).toString("base64")]));
const norm = (s) => s.toLowerCase().replace(/\^\{(\w+)\}/g, "^$1").replace(/\s+/g, " ");

async function call(model, uName) {
  const t0 = performance.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${K}` },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 400, response_format: { type: "json_object" },
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
    let latex = "";
    try { latex = JSON.parse(content.replace(/^```(json)?|```$/g, "")).latex ?? ""; } catch {}
    return { ok: !!latex, ms: Math.round(performance.now() - t0), latex };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), latex: "", err: String(e).slice(0, 60) };
  }
}

const MODELS = [
  "google/gemini-3.5-flash-lite",
  "xiaomi/mimo-v2.6-pro-ultraspeed",
  "xiaomi/mimo-v2.6-flash",
  "xiaomi/mimo-v2.6-pro",
];
for (const m of MODELS) {
  console.log("=== " + m);
  const times = [];
  let ok = 0;
  for (const c of CASES) {
    for (let run = 0; run < 2; run++) {
      const r = await call(m, c.name);
      times.push(r.ms);
      const hit = c.expect.every((e) => norm(r.latex).includes(e.toLowerCase()));
      if (hit) ok++;
      console.log(`  ${c.name.padEnd(9)} ${String(r.ms).padStart(6)}ms ${hit ? "OK  " : "MISS"} ${r.latex.slice(0, 60)}${r.err ? " ERR:" + r.err : ""}`);
      await new Promise((res) => setTimeout(res, 300));
    }
  }
  console.log(`${m}: avg ${(times.reduce((a, b) => a + b) / times.length / 1000).toFixed(2)}s, correct ${ok}/${times.length}`);
}