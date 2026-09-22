import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import { PushToTalk } from "./lib/recorder";
import { blobToWav } from "./lib/wav";
import { dictate, ConfigError, type DictationResult } from "./lib/api";

type Status = "idle" | "listening" | "thinking" | "error";

interface Line {
  latex: string;
  transcript: string;
  confidence: number;
  note: string;
}

const LOW_CONFIDENCE = 0.7;

function applyResult(lines: Line[], r: DictationResult): Line[] {
  switch (r.mode) {
    case "append":
      return r.latex
        ? [...lines, { latex: r.latex, transcript: r.transcript, confidence: r.confidence, note: r.note }]
        : lines;
    case "replace_line": {
      if (lines.length === 0) return lines;
      const next = [...lines];
      next[next.length - 1] = {
        latex: r.latex,
        transcript: r.transcript,
        confidence: r.confidence,
        note: r.note,
      };
      return next;
    }
    case "delete_last":
      return lines.slice(0, -1);
    default:
      return lines;
  }
}

function LineView({ line, onCopy }: { line: Line; onCopy: () => void }) {
  const html = useMemo(
    () => katex.renderToString(line.latex, { displayMode: true, throwOnError: false, strict: false }),
    [line.latex],
  );
  const low = line.confidence < LOW_CONFIDENCE;
  return (
    <div className={`line ${low ? "low" : ""}`}>
      <div className="latex" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="meta">
        <span className={`dot ${low ? "amber" : "green"}`} />
        <span className="transcript">“{line.transcript}”</span>
        {low && line.note && <span className="note">{line.note}</span>}
        <button className="copy" onClick={onCopy} title="Copy LaTeX">
          copy
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [level, setLevel] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [heard, setHeard] = useState("");
  const recorderRef = useRef<PushToTalk | null>(null);
  const statusRef = useRef<Status>("idle");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") return;
    setError("");
    setHeard("");
    // Warm the serverless function while the user is speaking (fire-and-forget)
    void fetch("/api/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
    const ptt = recorderRef.current ?? (recorderRef.current = new PushToTalk());
    ptt.onLevel = setLevel;
    try {
      await ptt.start();
      setStatus("listening");
    } catch (e) {
      setStatus("error");
      setError(
        typeof navigator.mediaDevices === "undefined"
          ? "Mic API unavailable — this app needs a secure context. Open it via https:// or localhost (not plain http:// on a LAN IP)."
          : e instanceof DOMException && e.name === "NotAllowedError"
            ? "Microphone permission denied — allow mic access and try again."
            : `Could not start recording: ${(e as Error).message}`,
      );
    }
  }, []);

  const finish = useCallback(async () => {
    if (statusRef.current !== "listening" || !recorderRef.current) return;
    setStatus("thinking");
    try {
      const blob = await recorderRef.current.stop();
      const wav = await blobToWav(blob);
      const result = await dictate(wav, { lines: lines.map((l) => ({ latex: l.latex })) }, {
        onProgress: (p) => {
          if (p.transcript) setHeard(p.transcript);
        },
      });
      setLines((prev) => applyResult(prev, result));
      setStatus("idle");
    } catch (e) {
      setStatus("error");
      setError(e instanceof ConfigError ? e.message : (e as Error).message || "Something went wrong");
    }
  }, [lines]);

  useEffect(() => {
    const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " ";
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSpace(e) || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      e.preventDefault();
      void start();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isSpace(e)) return;
      void finish();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [start, finish]);

  const listening = status === "listening";
  const thinking = status === "thinking";

  const copyLast = useCallback(async () => {
    if (lines.length === 0) return;
    const latex = lines[lines.length - 1].latex;
    try {
      await navigator.clipboard.writeText(latex);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = latex;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }, [lines]);

  return (
    <div className="app">
      <header className="header">
        <h1>MathTex</h1>
        <p className="tagline">say it, see it</p>
      </header>

      <main className="stage">
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button
              className="dismiss"
              onClick={() => {
                setError("");
                setStatus("idle");
              }}
            >
              ×
            </button>
          </div>
        )}

        {lines.length === 0 ? (
          <div className="placeholder">
            <p className="hero">
              Hold <kbd>space</kbd> — or hold the mic — and just say the math.
            </p>
            <p className="example">
              e.g. <span className="spoken">“dy dx equals x squared times x cubed”</span>
            </p>
          </div>
        ) : (
          <div className="lines">
            {lines.map((line, i) => (
              <LineView key={i} line={line} onCopy={copyLast} />
            ))}
          </div>
        )}
      </main>

      <footer className="footer">
        <div className="meter">
          <div className="fill" style={{ transform: `scaleX(${level})` }} />
        </div>
        <button
          className={`mic ${listening ? "on" : ""}`}
          disabled={thinking}
          onPointerDown={(e) => {
            e.preventDefault();
            void start();
          }}
          onPointerUp={() => void finish()}
          onPointerLeave={() => void finish()}
          title="Hold to talk"
        >
          <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden>
            <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
          </svg>
        </button>
        <div className="status">
          {thinking
            ? heard
              ? `heard: “${heard}”`
              : "thinking…"
            : listening
              ? "listening — release to send"
              : "hold space to talk"}
        </div>
      </footer>
    </div>
  );
}