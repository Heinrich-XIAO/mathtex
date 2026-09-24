import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import { PushToTalk } from "./lib/recorder";
import { blobToWav } from "./lib/wav";
import { analyzeSpeech, warmVad } from "./lib/vad";
import {
  dictate,
  liveConvert,
  liveTranscriptionEnabled,
  ConfigError,
  type DictationResult,
} from "./lib/api";

type Status = "idle" | "listening" | "thinking" | "error";

interface Line {
  latex: string;
  transcript: string;
  confidence: number;
  note: string;
}

const LOW_CONFIDENCE = 0.7;

function applyResult(lines: Line[], r: DictationResult, targetIndex?: number): Line[] {
  switch (r.mode) {
    case "append":
    case "append_lines": {
      if (r.lines.length === 0) return lines;
      const newLines = r.lines.map((latex) => ({
        latex,
        transcript: r.transcript,
        confidence: r.confidence,
        note: r.note,
      }));
      return [...lines, ...newLines];
    }
    case "replace_line": {
      const idx =
        targetIndex !== undefined && targetIndex >= 0 && targetIndex < lines.length
          ? targetIndex
          : lines.length - 1;
      if (idx < 0 || r.lines.length === 0) return lines;
      const next = [...lines];
      next[idx] = {
        latex: r.lines[0],
        transcript: r.transcript || lines[idx].transcript,
        confidence: r.confidence,
        note: r.note || lines[idx].note,
      };
      return next;
    }
    case "delete_last":
      return lines.slice(0, -1);
    default:
      return lines;
  }
}

function MicGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
    </svg>
  );
}

function ArrowGlyph({ mirrored = false }: { mirrored?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={mirrored ? { transform: "scaleX(-1)" } : undefined}
    >
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

function PendingEquation({ latex }: { latex: string }) {
  const html = useMemo(
    () => katex.renderToString(latex, { displayMode: true, throwOnError: false, strict: false }),
    [latex],
  );
  return (
    <div className="pending-line" aria-live="polite">
      <div className="latex" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function LineView({
  line,
  targeted,
  onMicDown,
  onMicUp,
}: {
  line: Line;
  targeted: boolean;
  onMicDown: () => void;
  onMicUp: () => void;
}) {
  const html = useMemo(
    () => katex.renderToString(line.latex, { displayMode: true, throwOnError: false, strict: false }),
    [line.latex],
  );
  const low = line.confidence < LOW_CONFIDENCE;
  return (
    <div className={`line ${low ? "low" : ""} ${targeted ? "targeted" : ""}`} title={low ? line.note : undefined}>
      <div className="latex" dangerouslySetInnerHTML={{ __html: html }} />
      <button
        className="line-mic"
        title="Hold to edit this line by voice"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          onMicDown();
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          onMicUp();
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <MicGlyph />
      </button>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [past, setPast] = useState<Line[][]>([]);
  const [future, setFuture] = useState<Line[][]>([]);
  const [targetIndex, setTargetIndex] = useState<number | undefined>(undefined);
  const [liveResult, setLiveResult] = useState<DictationResult | null>(null);
  const liveCoverageRef = useRef(0); // ms of audio covered by the last completed poll
  const liveTimer = useRef<number | null>(null);
  const liveInFlight = useRef(false);
  const targetRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    targetRef.current = targetIndex;
  }, [targetIndex]);
  const ctxRef = useRef<{ lines: { latex: string }[]; targetIndex?: number }>({ lines: [] });
  ctxRef.current = { lines: lines.map((l) => ({ latex: l.latex })), targetIndex };
  const recorderRef = useRef<PushToTalk | null>(null);
  const statusRef = useRef<Status>("idle");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const stopLivePolls = useCallback(() => {
    if (liveTimer.current !== null) {
      window.clearTimeout(liveTimer.current);
      liveTimer.current = null;
    }
    liveInFlight.current = false;
  }, []);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") return;
    setError("");
    setLiveResult(null);
    liveCoverageRef.current = 0;
    // Warm the serverless function while the user is speaking (fire-and-forget)
    void fetch("/api/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
    const ptt = recorderRef.current ?? (recorderRef.current = new PushToTalk());
    warmVad(); // WASM compile happens during the user's hold, not after release
    try {
      await ptt.start();
      setStatus("listening");
      // Live transcription loop: re-transcribe the growing audio every 1.2s
      const poll = async () => {
        const rec = recorderRef.current;
        if (!rec || statusRef.current !== "listening") return;
        if (!liveInFlight.current) {
          liveInFlight.current = true;
          try {
            const { pcm, durationMs } = rec.snapshotPcm();
            if (durationMs > 700) {
            const { result } = await liveConvert(pcm, ctxRef.current);
              if (statusRef.current === "listening") {
                if (result && (result.mode === "append" || result.mode === "append_lines" || result.mode === "replace_line")) {
                  setLiveResult(result);
                } else {
                  setLiveResult(null); // noop / delete_last / clear by voice
                }
              }
            }
          } catch {
            /* transient — next poll retries */
          }
          liveInFlight.current = false;
        }
        if (statusRef.current === "listening") {
          liveTimer.current = window.setTimeout(() => void poll(), 1200);
        }
      };
      if (liveTranscriptionEnabled()) {
        // First poll scheduled (not run inline): statusRef hasn't settled yet
        liveTimer.current = window.setTimeout(() => void poll(), 1200);
      }
    } catch (e) {
      setStatus("error");
      setError(
        typeof navigator.mediaDevices === "undefined"
          ? "Mic API unavailable — open via https:// or localhost."
          : e instanceof DOMException && e.name === "NotAllowedError"
            ? "Microphone permission denied — allow mic access and try again."
            : `Could not start recording: ${(e as Error).message}`,
      );
    }
  }, []);

  const finish = useCallback(async () => {
    if (statusRef.current !== "listening" || !recorderRef.current) return;
    stopLivePolls();
    const target = targetRef.current;
    setStatus("thinking");
    try {
      const { blob, durationMs, peak } = await recorderRef.current.stop();
      // Blank recording (tap, click, silence, ambient noise): discard before calling the API
      const isTargetedEdit = target !== undefined;
      const minDuration = isTargetedEdit ? 800 : 400;
      const minPeak = isTargetedEdit ? 0.09 : 0.06;
      if (durationMs < minDuration || peak < minPeak) {
        setTargetIndex(undefined);
        setStatus("idle");
        return;
      }
      const wavAndPcm = await blobToWav(blob);
      // VAD runs while the release pass happens — no-speech results are
      // discarded when both complete
      const speechPromise = analyzeSpeech(wavAndPcm.pcm);
      const minSpeechMs = target !== undefined ? 600 : 350;
      const ctx = { lines: lines.map((l) => ({ latex: l.latex })), targetIndex: target };
      let result: DictationResult | null = null;
      // Fresh live coverage: the provisional equation IS the result — promote it.
      // Stale (audio grew after the last poll): one final full-clip poll first.
      const fresh =
        liveResult !== null &&
        liveCoverageRef.current >= Math.max(600, durationMs - 600);
      if (fresh) {
        result = liveResult;
      } else {
        // Stale: one final full-clip poll (transcribe + convert), then promote
        try {
          const { result: r } = await liveConvert(wavAndPcm.pcm, ctx);
          result = r;
        } catch {
          result = null; // fall back to the single audio-LLM path
        }
      }
      if (!result) {
        result = await dictate(wavAndPcm.wav, ctx);
      }
      const speech = await speechPromise;
      if (speech.ok && speech.speechMs < minSpeechMs) {
        setTargetIndex(undefined);
        setLiveResult(null);
        setStatus("idle");
        return;
      }
      const next = applyResult(lines, result, target);
      if (next !== lines) {
        setPast((p) => [...p.slice(-49), lines]);
        setFuture([]);
        setLines(next);
      }
      setTargetIndex(undefined);
      setLiveResult(null);
      setStatus("idle");
    } catch (e) {
      setTargetIndex(undefined);
      setLiveResult(null);
      setStatus("error");
      setError(e instanceof ConfigError ? e.message : (e as Error).message || "Something went wrong");
    }
  }, [lines, liveResult, stopLivePolls]);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [lines, ...f.slice(0, 49)]);
      setLines(prev);
      return p.slice(0, -1);
    });
  }, [lines]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPast((p) => [...p.slice(-49), lines]);
      setLines(next);
      return f.slice(1);
    });
  }, [lines]);

  useEffect(() => {
    const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " ";
    const isUndo = (e: KeyboardEvent) =>
      (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey;
    const isRedo = (e: KeyboardEvent) =>
      ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z");
    const onKeyDown = (e: KeyboardEvent) => {
      if (isUndo(e)) {
        e.preventDefault();
        undo();
        return;
      }
      if (isRedo(e)) {
        e.preventDefault();
        redo();
        return;
      }
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
  }, [start, finish, undo, redo]);

  const listening = status === "listening";
  const thinking = status === "thinking";

  return (
    <div className={`app${listening ? " listening" : ""}`}>
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
            <p>Hold the pill and say the math.</p>
            <p className="example">e.g. “dy dx equals x squared times x cubed”</p>
          </div>
        ) : (
          <div className="lines">
            {lines.map((line, i) => (
              <LineView
                key={i}
                line={line}
                targeted={targetIndex === i}
                onMicDown={() => {
                  setTargetIndex(i);
                  void start();
                }}
                onMicUp={() => void finish()}
              />
            ))}
          </div>
        )}

        {liveResult && liveResult.lines[0] && (listening || thinking) && (
          <PendingEquation latex={liveResult.lines[0]} />
        )}
      </main>

      <footer className="footer">
        <div className="history">
          <button className="ghost" disabled={past.length === 0} onClick={undo} title="Undo (Ctrl+Z)">
            <ArrowGlyph />
          </button>
          <button className="ghost" disabled={future.length === 0} onClick={redo} title="Redo (Ctrl+Shift+Z)">
            <ArrowGlyph mirrored />
          </button>
        </div>
        <button
          className={`pill ${listening ? "listening" : ""} ${thinking ? "thinking" : ""}`}
          disabled={thinking}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            void start();
          }}
          onPointerUp={() => void finish()}
          onContextMenu={(e) => e.preventDefault()}
          title={listening && targetIndex !== undefined ? `Editing line ${targetIndex + 1}` : undefined}
        />
      </footer>
    </div>
  );
}