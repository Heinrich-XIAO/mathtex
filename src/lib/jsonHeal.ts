/** Best-effort salvage of a broken LLM JSON payload: markdown-fenced,
 *  prose-wrapped, or cut off mid-object by max_tokens. Returns the first
 *  candidate that JSON.parse accepts (each candidate is parse-tested, so
 *  anything returned here is guaranteed valid JSON), or null when nothing
 *  parseable can be built and the caller should fail through to its
 *  normal error/retry path. `truncated` is true only for real healing —
 *  the model's output was cut off and bytes were inferred/dropped — so
 *  callers can flag the result as untrustworthy rather than silently
 *  applying a half-emitted value. */
export interface HealedJson {
  json: string;
  truncated: boolean;
}

interface Frame {
  open: string; // "{" or "["
  expect: "key" | "colon" | "value" | "sep";
  /** Index of the last safe cut point in this frame (a completed member
   *  boundary); -1 once nothing has completed. Cutting here and closing
   *  the open frames yields valid JSON. */
  good: number;
  /** Object frames: most recent completed key — used to tell a truncated
   *  "latex" value (must NOT be string-closed: that silently invents
   *  partial math) from a truncated note/transcript (harmless to close). */
  lastKey: string;
}

export function healJson(raw: string): HealedJson | null {
  let s = raw.trim();
  if (s.startsWith("```")) {
    // Accept both closed fences and fences truncated before the close.
    s = s.replace(/^```(?:json)?[ \t]*\r?\n?/, "");
    const end = s.lastIndexOf("```");
    if (end >= 0) s = s.slice(0, end);
    s = s.trim();
  }
  const start = s.search(/[{[]/);
  if (start < 0) return null; // no object at all
  s = s.slice(start); // drop leading prose

  const stack: Frame[] = [];
  let inStr = false;
  let esc = false;
  let strOpen = -1;
  let prim = false; // scanning a number/true/false/null token

  const isDelim = (c: string): boolean => '"{}[],:'.includes(c) || c === " " || c === "\t" || c === "\n" || c === "\r";

  const completeValue = (end: number): void => {
    const f = stack[stack.length - 1];
    if (f && f.expect === "value") {
      f.expect = "sep";
      f.good = end;
    }
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (prim && isDelim(c)) {
      prim = false;
      completeValue(i);
    }
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') {
        inStr = false;
        const f = stack[stack.length - 1];
        if (f) {
          if (f.expect === "key") {
            f.expect = "colon";
            f.lastKey = s.slice(strOpen + 1, i);
          } else if (f.expect === "value") {
            completeValue(i + 1);
          }
        }
      }
      continue;
    }
    switch (c) {
      case '"':
        inStr = true;
        esc = false;
        strOpen = i;
        break;
      case "{":
      case "[":
        stack.push({ open: c, expect: c === "{" ? "key" : "value", good: -1, lastKey: "" });
        break;
      case "}":
      case "]": {
        const f = stack.pop();
        if (!f || f.open !== (c === "}" ? "{" : "[")) return null; // malformed; don't guess
        const p = stack[stack.length - 1];
        if (p) {
          p.expect = "sep";
          p.good = i + 1;
        } else {
          // Outermost container closed: everything after is prose.
          return { json: s.slice(0, i + 1), truncated: false };
        }
        break;
      }
      case ":":
        if (stack[stack.length - 1]?.expect === "colon") stack[stack.length - 1].expect = "value";
        break;
      case ",": {
        const f = stack[stack.length - 1];
        if (f && f.expect === "sep") {
          f.expect = f.open === "{" ? "key" : "value";
          f.good = i; // cut before the comma
        }
        break;
      }
      case " ":
      case "\t":
      case "\n":
      case "\r":
        break;
      default:
        prim = true;
        break;
    }
  }

  // EOF mid-object: the model's output was cut off. Build candidates and
  // keep the first that parses.
  if (stack.length === 0) return null;

  const closers = (frames: Frame[]): string =>
    frames
      .slice()
      .reverse()
      .map((f) => (f.open === "{" ? "}" : "]"))
      .join("");

  // Cut candidate: drop back to the deepest completed member boundary.
  let cutFrame: Frame | null = null;
  let cutDepth = -1;
  for (let d = 0; d < stack.length; d++) {
    if (stack[d].good >= 0) {
      cutFrame = stack[d];
      cutDepth = d;
    }
  }
  const candidates: string[] = [];
  if (cutFrame) {
    candidates.push(s.slice(0, cutFrame.good) + closers(stack.slice(0, cutDepth + 1)));
  }
  // Close candidate: terminate the truncated string (dropping a dangling
  // backslash) and close everything still open. Preferred over the cut —
  // it keeps the model's partial note/transcript — EXCEPT when the tail
  // sits inside an array or a "latex" value, where string-closing would
  // silently invent partial math; there the cut (drop the member) is the
  // safer salvage and a missing field falls through to the repair retry.
  const top = stack[stack.length - 1];
  const tailUnsafeToClose = inStr && !!top && (top.open === "[" || top.lastKey === "latex");
  let tail = s;
  if (inStr && esc) tail = tail.slice(0, -1);
  const closeCandidate = tail + (inStr ? '"' : "") + closers(stack);
  if (tailUnsafeToClose) {
    candidates.push(closeCandidate); // cut candidate (if any) is tried first
  } else {
    candidates.unshift(closeCandidate); // closing keeps partial note/transcript
  }

  for (const cand of candidates) {
    try {
      JSON.parse(cand);
      return { json: cand, truncated: true };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}