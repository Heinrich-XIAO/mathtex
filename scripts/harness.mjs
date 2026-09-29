// Replay harness: runs every verdicted take (audio in _storage) back through
// the dictation pipeline and scores the output against the human verdicts.
//
// Usage (repo root):
//   node --experimental-strip-types scripts/harness.mjs \
//     [--export /tmp/opencode/convex-full] \
//     [--variants baseline,tight,twostage] [--limit N] [--only <takeIdPrefix>]
//     [--verbose] [--json OUT]
//
// Needs a `npx convex export --deployment <prod> --include-file-storage`
// snapshot (documents.jsonl per table + _storage/*.wav keyed by storage id).
// Calls go through the prod /api edge functions, so no local key is needed.

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_PROMPT as BASE_PROMPT } from "../src/lib/prompt.ts";
import { TIGHT_PROMPT, HYBRID_PROMPT, TWOSTAGE_PROMPT } from "./prompt-variants.mjs";

const MODEL = "google/gemini-3.5-flash-lite";
const API = "https://mathtex.vercel.app/api";

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const VARIANTS = String(arg("variants", "baseline,tight,twostage")).split(",");
const LIMIT = Number(arg("limit", 1e9));
const ONLY = arg("only", null);
const VERBOSE = process.argv.includes("--verbose");
const JSON_OUT = arg("json", null);
const EXPORT_DIR = arg("export", "/tmp/opencode/convex-full");

// ---------- corpus ----------
const readTable = (name) =>
  readFileSync(join(EXPORT_DIR, name, "documents.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

const takes = readTable("takes");
const correctRows = readTable("correctLines");
const wrongRows = readTable("wrongLines");

const verdict = new Map();
for (const r of correctRows) verdict.set(r.takeId, { kind: "correct", reason: "" });
for (const r of wrongRows) verdict.set(r.takeId, { kind: "wrong", reason: r.reason ?? "" });

const storageDir = join(EXPORT_DIR, "_storage");
const wavFor = new Map(
  readdirSync(storageDir)
    .filter((f) => f.endsWith(".wav"))
    .map((f) => [f.replace(/\.wav$/, ""), join(storageDir, f)]),
);

const corpus = takes.filter(
  (t) => verdict.has(t.takeId) && wavFor.has(t.storageId) && (!ONLY || t.takeId.startsWith(ONLY)),
);
if (LIMIT < corpus.length) corpus.length = LIMIT;
const takeById = new Map(takes.map((t) => [t.takeId, t]));

// ---------- scoring ----------
const norm = (s) =>
  (s ?? "")
    .toLowerCase()
    .replace(/\\left|\\right|\\,|\\!|\\;/g, "")
    .replace(/\^\{([^}]*)\}/g, "^$1")
    .replace(/\s+/g, "");

// Wrong-marked genuine failures, keyed by takeId prefix. latex/notLatex regexes
// run against normalized latex; `asr` cross-checks against the neutral ASR
// hearing; `flag` demands an uncertainty signal; `manual` needs human review.
// Case rules keyed by takeId prefix (wrong-marked genuine failures).
// Regexes run against the NORMALIZED latex: lowercased, \left/\right/\, and
// ALL whitespace stripped, ^{n} -> ^n. Write patterns accordingly (no spaces).
const CASES = {
  bfdd76da: { manual: true, why: "wanted g'(x)=0; audio disputed — review transcript" },
  "99d773a8": { latex: /2\(x-2\)/, warn: true, why: 'middle factor meant 2(x-2) ("2x minus 2")' },
  "355d84ba": { latex: /f''/, why: "said f double prime" },
  "5f33948e": { latex: /x=1/, notLatex: /\\pm/, why: 'said "x equals one"' },
  f872f552: { latex: /\\pm1/, notLatex: /x=1\\implies/, warn: true, why: "uh-repair should replace, not chain" },
  "71dbfaad": { asr: true, why: "did they say < 1? must match ASR hearing, not context" },
  "319eb2e5": { latex: /\(-5\)/, notLatex: /\(0\)>/, why: "said g''(-5) < 0" },
  a1f5977f: { notLatex: /-50/, why: "-50 was never spoken" },
  d00d5587: { flag: true, why: "mumbled tail — flag it, don't invent the exponent" },
  b2d85638: { latex: /h''\(/, notLatex: /h'''/, why: "h double prime" },
  "3373f5df": { latex: /h''\(/, notLatex: /h'''/, why: "double prime" },
  "1faae6e0": { latex: /h''\(/, notLatex: /h'''|\(-5\)=/, why: "h'' of 0; append, don't rewrite line 5" },
  "191abb02": { latex: /h''\(/, notLatex: /h'''|\(-5\)|\(-2\)\^\(-3\)/, why: "h''(0); must not clobber target line 2" },
};

function score(take, out, asr) {
  const v = verdict.get(take.takeId);
  const id = take.takeId.slice(0, 8);
  // takes.latex only ever stored lines[0], so replay checks compare line 1
  const first = (out?.latex ?? [])[0] ?? "";
  const n = norm(first);

  if (v.kind === "correct") {
    const pass = n === norm(take.latex);
    return { pass, why: pass ? "reproduced" : `drift: ${JSON.stringify(first.slice(0, 60))}` };
  }
  const rule = CASES[id];
  if (!rule) {
    const pass = n === norm(take.latex);
    return { pass, why: pass ? "reproduced (UI-test mark)" : `drift: ${JSON.stringify(first.slice(0, 60))}` };
  }
  const fails = [];
  const nLatex = norm((out?.latex ?? []).join(" "));
  if (rule.latex && !rule.latex.test(nLatex)) fails.push(`missing /${rule.latex.source}/`);
  if (rule.notLatex && rule.notLatex.test(nLatex)) fails.push(`forbidden /${rule.notLatex.source}/`);
  if (rule.flag) {
    const flagged = out?.uncertain === true || /mumbl|unclear|guess|context|hesitat|truncat/i.test(out?.note ?? "");
    if (!flagged) fails.push("no uncertainty flag on garbled audio");
  }
  if (rule.asr) {
    const m = (asr ?? "").match(/(less|greater) than (zero|one|two|negative \w+|[a-z]+)/i);
    if (m) {
      const operand = { zero: "0", one: "1", two: "2" }[m[2].toLowerCase()] ?? m[2];
      const op = /less/i.test(m[1]) ? "<" : ">";
      if (!nLatex.includes(`${op} ${operand}`) && !nLatex.includes(`${op}(${operand})`)) {
        fails.push(`ASR heard "${m[0]}", latex disagrees`);
      }
    } else {
      fails.push("ASR heard no comparison — review");
    }
  }
  if (rule.manual) return { pass: null, why: "MANUAL: " + rule.why };
  if (rule.warn && fails.length) return { pass: null, why: `SOFT: ${fails.join("; ")}` };
  return { pass: fails.length === 0, why: fails.join("; ") || rule.why };
}

// transcript fidelity vs the neutral ASR hearing (1 for two-stage by design)
function fidelity(modelTranscript, asr) {
  const A = new Set((asr ?? "").toLowerCase().match(/[a-z0-9'-]+/g) ?? []);
  const B = (modelTranscript ?? "").toLowerCase().match(/[a-z0-9'-]+/g) ?? [];
  if (!B.length) return 1;
  return B.filter((w) => A.has(w)).length / B.length;
}

// ---------- pipeline ----------
// Takes that predate request-logging: hand-reconstructed file context from
// the session timeline. Empty string = empty file.
const HAND_CONTEXT = {
  d414dc14: "1. x^{2} + 1",
  "56837742": "1. x^{2} + 1",
  f2183364: "1. x^{2} + 1",
  b80db626: "1. x^{2} + 1",
  bfdd76da: "1. g'(x) = 4x^{3} - 5x^{4}\n2. g''(x) = 12x^{2} - 20x^{3}\n3. g'(x) = 0",
  c87f9716: "",
  "99d773a8": "1. h(x) = x^{2}(x - 2)^{2}(x - 1)^{2}",
};
const APPEND_TEXT =
  'The audio is NEW dictation to append after the last line as a new line. It should relate naturally to the preceding lines and the background context. Use "replace_line" only if the audio is an explicit edit command for an existing line. Listen to the audio and produce the JSON object.';

function contextTextOf(take) {
  if (take.request) {
    const req = JSON.parse(take.request);
    for (const m of req.messages) {
      if (Array.isArray(m.content)) {
        const t = m.content.find((p) => p?.type === "text");
        if (t) return t.text;
      } else if (typeof m.content === "string") return m.content;
    }
  }
  const ctx = HAND_CONTEXT[take.takeId.slice(0, 8)];
  return ctx === undefined
    ? "The file is empty. Listen to the audio and produce the JSON object."
    : `Current file lines (most recent last):\n${ctx}\n\n${APPEND_TEXT}`;
}

function buildMessages(take, systemPrompt) {
  const b64 = readFileSync(wavFor.get(take.storageId), "base64");
  const t0 = Date.now();
  const messages = take.request
    ? JSON.parse(take.request).messages.map((m) =>
        Array.isArray(m.content)
          ? {
              ...m,
              content: m.content.map((p) =>
                p && "input_audio" in p ? { ...p, input_audio: { ...p.input_audio, data: b64 } } : p,
              ),
            }
          : m,
      )
    : [
        {
          role: "user",
          content: [
            { type: "text", text: contextTextOf(take) },
            { type: "input_audio", input_audio: { data: b64, format: "wav" } },
          ],
        },
      ];
  const sys = messages[0]?.role === "system" ? { ...messages[0], content: systemPrompt } : { role: "system", content: systemPrompt };
  return { messages: [sys, ...messages.filter((m) => m.role !== "system")], t0 };
}

async function runSinglePass(take, systemPrompt, asrHint) {
  const { messages, t0 } = buildMessages(take, systemPrompt);
  if (asrHint) {
    // hybrid: inject the neutral ASR hearing as a cross-check hint
    const i = messages.findIndex((m) => m.role === "user" && Array.isArray(m.content));
    if (i >= 0) {
      const textPart = messages[i].content.find((p) => p?.type === "text");
      if (textPart) {
        messages[i] = {
          ...messages[i],
          content: [
            { type: "text", text: `${textPart.text}\n\nASR CROSS-CHECK (a second, independent speech-to-text pass; it may mishear — but if it clearly disagrees with what you thought was said, re-listen and prefer what it confirms): ${asrHint}` },
            ...messages[i].content.slice(1),
          ],
        };
      }
    }
  }
  const call = (msgs) =>
    fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 400,
        stream: false,
        response_format: { type: "json_object" },
        messages,
      }),
    });
  let res = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 400,
      stream: false,
      response_format: { type: "json_object" },
      messages,
    }),
  });
  let data = await res.json();
  let content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(data.error?.message ?? `no content (${res.status})`);
  try {
    JSON.parse(content);
  } catch {
    // same repair retry the app does: invalid/truncated JSON -> one fix-up turn
    const retry = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [
          ...messages,
          { role: "assistant", content },
          { role: "user", content: `That was not valid JSON. Reply with ONLY the corrected JSON object in the required shape.` },
        ],
      }),
    });
    const d2 = await retry.json();
    content = d2.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty retry");
  }
  return { raw: content, ms: Date.now() - t0 };
}

async function runTwoStage(take, systemPrompt) {
  const b64 = readFileSync(wavFor.get(take.storageId), "base64");
  const t0 = Date.now();
  const res = await fetch(`${API}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioB64: b64, systemPrompt, contextText: contextTextOf(take) }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  return { raw: d.raw ?? "", asr: d.transcript ?? "", ms: Date.now() - t0 };
}

const stripFences = (s) => {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : s;
};

function parseResult(raw) {
  const obj = JSON.parse(stripFences(String(raw)).trim());
  return {
    mode: obj.mode,
    transcript: typeof obj.transcript === "string" ? obj.transcript : "",
    latex: Array.isArray(obj.latex) ? obj.latex.filter((l) => typeof l === "string") : [obj.latex ?? ""],
    confidence: typeof obj.confidence === "number" ? obj.confidence : 0.8,
    note: typeof obj.note === "string" ? obj.note : "",
    uncertain: obj.uncertain === true,
  };
}

async function callTranscribe(audioB64, systemPrompt, contextText) {
  const res = await fetch(`${API}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioB64, systemPrompt, contextText }),
  });
  return res.json();
}

// neutral ASR witness (fish-audio) — raw transcript, converter prompt minimal
async function getAsr(take) {
  const b64 = readFileSync(wavFor.get(take.storageId), "base64");
  const d = await callTranscribe(b64, "You are a speech-to-text echo. Output the JSON transcript unchanged.", "");
  return d.transcript ?? "";
}

function tryParse(raw) {
  try {
    return parseResult(raw);
  } catch (e) {
    return { parseError: `${String(raw).slice(0, 100)}… ERR:${e.message}` };
  }
}

// ---------- run ----------
const PROMPTS = { baseline: BASE_PROMPT, tight: TIGHT_PROMPT, hybrid: HYBRID_PROMPT, twostage: TWOSTAGE_PROMPT };
const results = [];
let n = 0;
for (const take of corpus) {
  const v = verdict.get(take.takeId);
  const rec = {
    takeId: take.takeId.slice(0, 8),
    verdict: v.kind,
    reason: v.reason.slice(0, 90),
    spoken: take.transcript.slice(0, 70),
    variants: {},
  };
  for (const variant of VARIANTS) {
    try {
      if (variant === "twostage") {
        const r = await runTwoStage(take, PROMPTS.twostage);
        rec.variants[variant] = { out: r.raw ? tryParse(r.raw) : null, asr: r.asr, ms: r.ms };
      } else if (variant === "hybrid") {
        // stage 0: neutral ASR witness; stage 1: audio-LLM pass with the hint
        const asr = await getAsr(take);
        const r = await runSinglePass(take, PROMPTS.hybrid, asr);
        rec.variants[variant] = { out: tryParse(r.raw), asr, ms: r.ms };
      } else {
        const r = await runSinglePass(take, PROMPTS[variant]);
        rec.variants[variant] = { out: tryParse(r.raw), asr: null, ms: r.ms };
      }
    } catch (e) {
      rec.variants[variant] = { out: null, asr: null, err: String(e).slice(0, 160) };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  results.push(rec);
  if (VERBOSE) console.error(`[${++n}/${corpus.length}] ${take.takeId.slice(0, 8)} ${v.kind}`);
}

// ---------- report ----------
const byId = new Map(takes.map((t) => [t.takeId.slice(0, 8), t]));
const summary = {};
for (const variant of VARIANTS) {
  let pass = 0, warn = 0, fail = 0, lat = 0, latN = 0, fid = 0, fidN = 0;
  for (const rec of results) {
    const r = rec.variants[variant];
    if (!r || r.err || !r.out || r.out.parseError) { fail++; continue; }
    const s = score(byId.get(rec.takeId), r.out, r.asr);
    if (s.pass === true) pass++;
    else if (s.pass === null) warn++;
    else fail++;
    if (r.ms) { lat += r.ms; latN++; }
    if (r.asr !== null && r.out?.transcript) { fid += fidelity(r.out.transcript, r.asr); fidN++; }
  }
  summary[variant] = {
    pass, warn, fail, total: pass + warn + fail,
    avgMs: latN ? Math.round(lat / latN) : null,
    transcriptFidelity: fidN ? +(fid / fidN).toFixed(3) : null,
  };
}

console.log("\n=== summary per variant (pass / warn / fail of verdicted takes) ===");
for (const [k, s] of Object.entries(summary)) console.log(k.padEnd(10), JSON.stringify(s));

console.log("\n=== wrong-verdict cases ===");
for (const rec of results.filter((r) => r.verdict === "wrong")) {
  const take = byId.get(rec.takeId);
  const cells = VARIANTS.map((v) => {
    const r = rec.variants[v];
    if (!r || r.err) return `${v}: ERR`;
    if (!r.out || r.out.parseError) return `${v}: PARSE-FAIL`;
    const s = score(take, r.out, r.asr);
    return `${v}: ${s.pass === null ? "WARN" : s.pass ? "pass" : "FAIL"}${s.pass !== true ? ` (${String(s.why).slice(0, 55)})` : ""}`;
  });
  console.log(`${rec.takeId} ${rec.reason ? `["${rec.reason.slice(0, 40)}"]` : ""}\n   ${cells.join("\n   ")}`);
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ summary, results }, null, 2));
console.log(`\ncorpus: ${results.length} takes (${results.filter(r => r.verdict === "wrong").length} wrong)`);
