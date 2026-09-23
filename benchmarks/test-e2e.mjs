import { readFileSync } from "node:fs";

const WS = "/home/bobstevens/mathtex";
const ENV = Object.fromEntries(
  readFileSync(`${WS}/.env`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

// Extract the real SYSTEM_PROMPT from the repo source (no interpolations, safe to eval)
const promptSrc = readFileSync(`${WS}/src/lib/prompt.ts`, "utf8");
const SYSTEM_PROMPT = promptSrc
  .replace(/^export const SYSTEM_PROMPT = `/s, "")
  .replace(/`;$/s, "");

const b64 = readFileSync("/tmp/opencode/mathtex-e2e/test-utterance.wav").toString("base64");

const res = await fetch(`${ENV.VITE_API_BASE_URL}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${ENV.VITE_API_KEY}` },
  body: JSON.stringify({
    model: ENV.VITE_MODEL,
    temperature: 0,
    max_tokens: 600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "The file is empty. Listen to the audio and produce the JSON object." },
          { type: "input_audio", input_audio: { data: b64, format: "wav" } },
        ],
      },
    ],
  }),
});

console.log("HTTP", res.status);
const data = await res.json();
console.log(JSON.stringify(data.choices?.[0]?.message?.content ?? data, null, 2));