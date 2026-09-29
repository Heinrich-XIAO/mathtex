import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import katex from "katex";
import { PushToTalk } from "./lib/recorder";
import { blobToWav } from "./lib/wav";
import { analyzeSpeech, warmVad } from "./lib/vad";
import {
  dictate,
  liveConvert,
  liveTranscriptionEnabled,
  ConfigError,
  type CallContext,
  type DictationResult,
} from "./lib/api";
import {
  markCorrect,
  markWrong,
  setWrongReason,
  unmarkCorrect,
  unmarkWrong,
  uploadTake,
} from "./lib/persist";
import { useInstall } from "./lib/install";

type Status = "idle" | "listening" | "thinking" | "error";

interface Line {
  id: string;
  takeId: string;
  latex: string;
  transcript: string;
  confidence: number;
  uncertain: boolean;
  note: string;
}

const LOW_CONFIDENCE = 0.7;
// Background context the student gives at load (Khan Academy copy, LaTeX, …):
// stored so it survives reloads and sent to the LLM with every call.
const CONTEXT_KEY = "mathtex.background-context";
const CONTEXT_MAX = 4000;
// Typed correction captured in the wrong-mark dialog: one sentence, capped.
const REASON_MAX = 200;

function loadStoredContext(): string {
  try {
    return localStorage.getItem(CONTEXT_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeContext(v: string): void {
  try {
    localStorage.setItem(CONTEXT_KEY, v);
  } catch {
    /* private mode: context just won't persist */
  }
}
/** Belt-and-braces for clips the VAD couldn't confirm: noise reaches the
 * model too, and a mutating result from it must be confident to land. */
const LOW_VAD_MIN_CONFIDENCE = 0.5;
// Destructive results (replace_line on a selected line, delete_last from noise)
// need real confidence to execute; below this they downgrade to a safe no-op
// or an extra append. Appends are exempt — a wrong extra line is a swipe away.
const MUTATION_MIN_CONFIDENCE = 0.8;

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function applyResult(
  lines: Line[],
  r: DictationResult,
  targetIndex?: number,
  takeId?: string,
): Line[] {
  switch (r.mode) {
    case "append":
    case "append_lines": {
      if (r.lines.length === 0) return lines;
      const tid = takeId ?? uid();
      const newLines = r.lines.map((latex) => ({
        id: uid(),
        takeId: tid,
        latex,
        transcript: r.transcript,
        confidence: r.confidence,
        uncertain: r.uncertain,
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
        id: uid(),
        takeId: takeId ?? uid(),
        latex: r.lines[0],
        transcript: r.transcript || lines[idx].transcript,
        confidence: r.confidence,
        uncertain: r.uncertain,
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

function InstallGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden>
      <path d="M12 3v10.17l-3.59-3.58L7 11l5 5 5-5-1.41-1.41L12 13.17V3zM5 19h14v2H5z" />
    </svg>
  );
}

function ContextGlyph() {
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
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  );
}

function XGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

const BAR_COUNT = 15;

/** Wispr-style waveform: rolling history of mic levels, painted via direct
 * DOM writes so the rAF loop never re-renders React. */
function Waveform({ level, active }: { level: { current: number }; active: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const histRef = useRef<number[]>(new Array(BAR_COUNT).fill(0.14));
  const emaRef = useRef(0);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const bars = Array.from(root.children) as HTMLElement[];
    let raf = 0;
    let lastPush = 0;
    const tick = (t: number) => {
      if (t - lastPush >= 60) {
        lastPush = t;
        const target = active ? Math.min(1, (level.current ?? 0) * 1.35) : 0;
        emaRef.current += (target - emaRef.current) * 0.45;
        const hist = histRef.current;
        hist.push(Math.max(0.14, emaRef.current));
        hist.shift();
        for (let i = 0; i < BAR_COUNT; i++) {
          bars[i].style.transform = `scaleY(${hist[i].toFixed(3)})`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, level]);
  return (
    <div ref={rootRef} className="waveform" aria-hidden>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span key={i} />
      ))}
    </div>
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

// Tinder-style verdicts: swipe right = correct, swipe left = wrong.
// Commit past this distance, or on a quick horizontal flick.
const SWIPE_COMMIT = 72;
const FLICK_VX = 0.6;

function LineView({
  line,
  targeted,
  provisional,
  verdict,
  reason,
  swipeEnabled,
  onMicDown,
  onMicUp,
  onDelete,
  onSetVerdict,
  onCancelDictation,
}: {
  line: Line;
  targeted: boolean;
  provisional: boolean;
  verdict: "wrong" | "correct" | undefined;
  reason: string | undefined;
  swipeEnabled: boolean;
  onMicDown: () => void;
  onMicUp: () => void;
  onDelete: () => void;
  onSetVerdict: (verdict: "wrong" | "correct" | undefined) => void;
  onCancelDictation: () => void;
}) {
  const html = useMemo(
    () => katex.renderToString(line.latex, { displayMode: true, throwOnError: false, strict: false }),
    [line.latex],
  );
  const low = line.confidence < LOW_CONFIDENCE || line.uncertain;

  // Tinder swipe: the row body tracks the pointer — right for correct, left
  // for wrong. Stamps fade in with drag distance via direct DOM writes;
  // React only sees the committed verdict.
  const bodyRef = useRef<HTMLDivElement>(null);
  const stampRightRef = useRef<HTMLDivElement>(null);
  const stampLeftRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({
    id: -1,
    startX: 0,
    startY: 0,
    active: false,
    lastX: 0,
    lastT: 0,
    vx: 0,
    enabled: false,
    fromMic: false,
  });
  const suppressClickRef = useRef(false);

  const setBody = useCallback((x: number, animated: boolean) => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.transition = animated ? "transform 220ms cubic-bezier(0.2, 0.7, 0.3, 1)" : "none";
    el.style.transform = `translateX(${x}px)`;
  }, []);

  const setStamps = useCallback((dx: number) => {
    const o = Math.max(0, Math.min(1, (Math.abs(dx) - 28) / 80));
    const right = stampRightRef.current;
    const left = stampLeftRef.current;
    if (right) right.style.opacity = dx > 0 ? o.toFixed(2) : "0";
    if (left) left.style.opacity = dx < 0 ? o.toFixed(2) : "0";
  }, []);

  // The content can change underneath (undo/redo/voice edit) — reset the row
  useEffect(() => {
    setBody(0, false);
    setStamps(0);
  }, [line.latex, setBody, setStamps]);

  // Capture-phase handlers: they see presses that land on the row's buttons
  // (the line mic calls stopPropagation in its own bubble handler) so the
  // swipe can arbitrate against them.
  const onRowPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    d.id = e.pointerId;
    d.startX = e.clientX;
    d.startY = e.clientY;
    d.active = false;
    d.lastX = e.clientX;
    d.lastT = e.timeStamp;
    d.vx = 0;
    d.enabled = swipeEnabled;
    suppressClickRef.current = false;
    const t = e.target as HTMLElement | null;
    d.fromMic = !!t?.closest?.(".line-mic, .line-delete");
  };

  const onRowPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d.id === -1 || e.pointerId !== d.id) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.active) {
      // Standard mobile pattern: a press stays a press until the finger
      // travels sideways past the slop; then the swipe steals the gesture —
      // cancelling a mic hold in flight. Vertical movement never claims:
      // native scrolling keeps winning.
      const slop = d.fromMic ? 24 : 10;
      if (Math.abs(dx) < slop || Math.abs(dx) <= Math.abs(dy)) return;
      if (!d.enabled && !d.fromMic) return;
      d.active = true;
      if (d.fromMic) onCancelDictation();
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.vx = (e.clientX - d.lastX) / dt;
    d.lastX = e.clientX;
    d.lastT = e.timeStamp;
    const next = Math.max(-96, Math.min(96, dx));
    setBody(next, false);
    setStamps(next);
  };

  const onRowPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d.id === -1 || e.pointerId !== d.id) return;
    d.id = -1;
    if (!d.active) return;
    d.active = false;
    suppressClickRef.current = true;
    const dx = e.clientX - d.startX;
    // A drag from the mic/✕ only cancels an in-flight hold; it never marks.
    const commit = !d.fromMic && (Math.abs(dx) >= SWIPE_COMMIT || Math.abs(d.vx) >= FLICK_VX);
    setBody(0, true);
    setStamps(0);
    if (commit) onSetVerdict(dx >= 0 ? "correct" : "wrong");
  };

  // Tap a marked row to clear its verdict (taps on the mic/✕ buttons excluded)
  const onRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!verdict) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.(".line-mic, .line-delete")) return;
    onSetVerdict(undefined);
  };

  return (
    <div
      className={`line ${low ? "low" : ""} ${verdict ? `verdict-${verdict}` : ""} ${targeted ? "targeted" : ""} ${provisional ? "provisional" : ""}`}
      title={low ? line.note : undefined}
      onClick={onRowClick}
      onPointerDownCapture={onRowPointerDown}
      onPointerMoveCapture={onRowPointerMove}
      onPointerUpCapture={onRowPointerEnd}
      onPointerCancelCapture={onRowPointerEnd}
    >
      <div ref={bodyRef} className="line-body">
        <div className="latex" dangerouslySetInnerHTML={{ __html: html }} />
        {verdict === "wrong" && reason ? <div className="line-reason">“{reason}”</div> : null}
      </div>
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
      <button
        className="line-delete"
        onClick={() => onDelete()}
        title="Delete line (Ctrl+Z to undo)"
        aria-label="Delete line"
      >
        <XGlyph size={13} />
      </button>
      <div ref={stampRightRef} className="stamp stamp-right" aria-hidden>
        Correct
      </div>
      <div ref={stampLeftRef} className="stamp stamp-left" aria-hidden>
        Wrong
      </div>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  // Verdicts live outside the undo history on purpose: Ctrl+Z never
  // reverts a mark — tapping a marked row clears it. "wrong" | "correct"
  // per line id.
  const [verdicts, setVerdicts] = useState<Record<string, "wrong" | "correct" | undefined>>({});
  // The typed correction captured after a wrong-swipe, per line id.
  const [reasons, setReasons] = useState<Record<string, string>>({});
  // Line awaiting its typed correction (the swipe-left dialog); tracked by id
  // so deletes/undos can't silently retarget the dialog at a different line.
  const [reasonTargetId, setReasonTargetId] = useState<string | null>(null);
  const reasonTargetIdRef = useRef<string | null>(null);
  const [correctionDraft, setCorrectionDraft] = useState("");
  const [past, setPast] = useState<Line[][]>([]);
  const [future, setFuture] = useState<Line[][]>([]);
  const [targetIndex, setTargetIndex] = useState<number | undefined>(undefined);
  const [liveResult, setLiveResult] = useState<DictationResult | null>(null);
  const [provisionalFrom, setProvisionalFrom] = useState<number | null>(null);
  // Background context for the LLM: `source` is what gets sent, the dialog
  // drafts an edit of it. Never opens on its own — only via the footer ghost.
  const [source, setSource] = useState<string>(() => loadStoredContext());
  const [contextOpen, setContextOpen] = useState(false);
  const [contextDraft, setContextDraft] = useState<string>(() => loadStoredContext());
  const contextInputRef = useRef<HTMLTextAreaElement | null>(null);
  const liveCoverageRef = useRef(0); // ms of audio covered by the last completed poll
  const liveRequestRef = useRef<string>(""); // last poll's upstream LLM request
  const asrRef = useRef(""); // last poll's neutral ASR transcript — witness for finalize
  const liveTimer = useRef<number | null>(null);
  const liveInFlight = useRef(false);
  const pollFailures = useRef(0);
  const [pollWarning, setPollWarning] = useState(false);
  const targetRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    targetRef.current = targetIndex;
  }, [targetIndex]);
  useEffect(() => {
    reasonTargetIdRef.current = reasonTargetId;
  }, [reasonTargetId]);
  const ctxRef = useRef<CallContext>({ lines: [] });
  ctxRef.current = { lines: lines.map((l) => ({ latex: l.latex })), targetIndex, source };
  const linesRef = useRef<Line[]>([]);
  linesRef.current = lines;
  const recorderRef = useRef<PushToTalk | null>(null);
  const levelRef = useRef(0);
  const cancelReqRef = useRef(false);
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
    // The correction dialog owns the keyboard while open — no dictation.
    if (reasonTargetIdRef.current) return;
    cancelReqRef.current = false;
    setError("");
    setLiveResult(null);
    pollFailures.current = 0;
    setPollWarning(false);
    liveCoverageRef.current = 0;
    asrRef.current = "";
    // Warm the serverless function while the user is speaking (fire-and-forget)
    void fetch("/api/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
    const ptt = recorderRef.current ?? (recorderRef.current = new PushToTalk());
    ptt.onLevel = (level) => {
      levelRef.current = level;
    };
    levelRef.current = 0;
    warmVad(); // WASM compile happens during the user's hold, not after release
    try {
      await ptt.start();
      if (cancelReqRef.current) {
        // Cancelled while the mic was still opening (e.g. a swipe stole the
        // gesture during the hold): tear the fresh take down again.
        cancelReqRef.current = false;
        try {
          await ptt.stop();
        } catch {
          /* already stopped */
        }
        return;
      }
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
            const { result, request, transcript } = await liveConvert(pcm, ctxRef.current);
            liveRequestRef.current = request;
            if (transcript.trim()) asrRef.current = transcript;
              if (statusRef.current === "listening") {
                if (result && (result.mode === "append" || result.mode === "append_lines" || result.mode === "replace_line")) {
                  setLiveResult(result);
                } else {
                  setLiveResult(null); // noop / delete_last / clear by voice
                }
              }
              pollFailures.current = 0;
              setPollWarning(false);
            }
          } catch {
            pollFailures.current += 1;
            if (pollFailures.current >= 2 && statusRef.current === "listening") {
              setPollWarning(true);
            }
          }
          liveInFlight.current = false;
        }
        if (statusRef.current === "listening") {
          liveTimer.current = window.setTimeout(() => void poll(), 1200);
        }
      };
      if (liveTranscriptionEnabled()) {
        // First poll scheduled (not run inline): statusRef hasn't settled yet.
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
    setPollWarning(false);
    const target = targetRef.current;
    setStatus("thinking");
    try {
      const { blob, durationMs, peak } = await recorderRef.current.stop();
      // Blank recording (tap, click, silence, ambient noise): discard before calling the API
      const isTargetedEdit = target !== undefined;
      const minDuration = isTargetedEdit ? 800 : 400;
      const minPeak = isTargetedEdit ? 0.09 : 0.06;
      if (durationMs < minDuration || peak < minPeak) {
        console.info(
          `[dictation] discard-blank dur=${durationMs}ms peak=${peak.toFixed(3)}`,
        );
        setTargetIndex(undefined);
        setStatus("idle");
        return;
      }
      const wavAndPcm = await blobToWav(blob);
      const speechPromise = analyzeSpeech(wavAndPcm.pcm);
      const takeId = uid();
      const ctx = { lines: lines.map((l) => ({ latex: l.latex })), targetIndex: target, source };
      const before = lines;
      let promotedAt: number | null = null;

      // 1) Instant: promote the live provisional equation as a faded line
      if (
        liveResult &&
        (liveResult.mode === "append" || liveResult.mode === "append_lines" || liveResult.mode === "replace_line")
      ) {
        const next = applyResult(before, liveResult, target, takeId);
        if (next !== before) {
          setPast((p) => [...p.slice(-49), before]);
          setFuture([]);
          setLines(next);
          promotedAt =
            liveResult.mode === "replace_line"
              ? target !== undefined && target < before.length
                ? target
                : before.length - 1
              : before.length;
        }
      }

      // 2) VAD verdict — advisory, never a hard gate. Silero under-reports
      //    whispered speech (no f0), especially under bus noise, so a low
      //    speechMs no longer discards the clip: it still goes to the LLM,
      //    which transcribes intelligible whispers and noops on pure noise.
      //    Only the confidence guard in step 3 can still throw it away.
      const speech = await speechPromise;
      const minSpeechMs = target !== undefined ? 600 : 350;
      const vadConfirmed = !speech.ok || speech.speechMs >= minSpeechMs;
      const vadStats = speech.ok
        ? `speech=${speech.speechMs}ms/${speech.frames}fr max=${speech.maxProb.toFixed(3)} mean=${speech.meanProb.toFixed(3)}`
        : "vad=err";
      console.info(`[dictation] dur=${durationMs}ms peak=${peak.toFixed(3)} ${vadStats} ${vadConfirmed ? "vad-ok" : "vad-low"}`);

      // 3) Authoritative finalize: the audio-LLM hears the full clip and
      //    replaces the provisional with the accurate result. One retry —
      //    transient 429/5xx/network blips are common; a short backoff first.
      let final: DictationResult | null = null;
      let finalRequest = "";
      let finalErr: unknown = null;
      try {
        ({ result: final, request: finalRequest } = await dictate(wavAndPcm.wav, ctx, {
          vadStats,
          asr: asrRef.current,
        }));
      } catch (e) {
        finalErr = e;
        await new Promise((r) => setTimeout(r, 700));
        try {
          ({ result: final, request: finalRequest } = await dictate(wavAndPcm.wav, ctx, {
            vadStats,
            asr: asrRef.current,
          }));
          finalErr = null;
        } catch (e2) {
          finalErr = e2;
        }
      }
      const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
      if (final) {
        // 3b) Recovery bias for destructive modes: the corpus's only destructive
        //    failure (a 0.58-confidence replace clobbering a good line) is
        //    cheaper to prevent than to undo — an append of a stray line is a
        //    swipe away from deletion, an overwrite is not. Downgrade mutating
        //    results that arrive under-confident instead of executing them.
        if (final.mode === "replace_line" && final.confidence < MUTATION_MIN_CONFIDENCE) {
          final = { ...final, mode: "append" };
        } else if (final.mode === "delete_last" && !vadConfirmed && final.confidence < MUTATION_MIN_CONFIDENCE) {
          final = { ...final, mode: "noop" };
        }
        // 3c) Confidence guard for low-VAD clips: hallucinated edits from
        //    noise come back unsure — only confident mutations may land.
        //    noop is harmless either way; vad-ok clips skip the guard.
        const guardRejects =
          !vadConfirmed &&
          final.mode !== "noop" &&
          final.confidence < LOW_VAD_MIN_CONFIDENCE;
        console.info(
          `[dictation] final mode=${final.mode} conf=${final.confidence.toFixed(2)}${
            guardRejects ? " discard-guard" : ""
          }`,
        );
        if (guardRejects) {
          if (promotedAt !== null) setLines(before);
          setProvisionalFrom(null);
          setTargetIndex(undefined);
          setLiveResult(null);
          setStatus("idle");
          return;
        }
        setProvisionalFrom(null);
        const res = final;
        setLines((prev) => applyResult(promotedAt !== null ? before : prev, res, target, takeId));
        // Upload every take's audio immediately, whatever the line's fate
        void uploadTake(takeId, wavAndPcm.wav, {
          latex: final.lines.join("\n"),
          transcript: final.transcript,
          note: final.note,
          confidence: final.confidence,
          uncertain: final.uncertain,
          asr: asrRef.current,
        }, finalRequest);
      } else if (promotedAt !== null) {
        // Keep the promoted provisional as a solid line, but say why it's unconfirmed
        setProvisionalFrom(null);
        setError(`Finalize failed — kept the live preview: ${describe(finalErr)}`);
        void uploadTake(takeId, wavAndPcm.wav, {
          latex: liveResult?.lines[0] ?? "",
          transcript: liveResult?.transcript ?? "",
          note: liveResult?.note ?? "",
          confidence: liveResult?.confidence ?? 0,
          uncertain: liveResult?.uncertain ?? false,
          asr: asrRef.current,
        }, liveRequestRef.current);
      } else {
        // No provisional existed: without this the attempt would vanish silently
        setProvisionalFrom(null);
        setTargetIndex(undefined);
        setLiveResult(null);
        setStatus("error");
        setError(`Finalize failed: ${describe(finalErr)}`);
        return;
      }
      setTargetIndex(undefined);
      setLiveResult(null);
      setStatus("idle");
    } catch (e) {
      setTargetIndex(undefined);
      setProvisionalFrom(null);
      setStatus("error");
      setError(e instanceof ConfigError ? e.message : (e as Error).message || "Something went wrong");
    }
  }, [lines, liveResult, source, stopLivePolls]);

  // Discard the in-flight recording entirely (Wispr-style ✕, or a swipe
  // stealing a mic hold): stop capture, drop the live preview, restore state.
  const cancel = useCallback(() => {
    // A start() may still be in flight (permission prompt, warm-up): flag it
    // so it aborts instead of resurrecting a cancelled take.
    cancelReqRef.current = true;
    if (statusRef.current !== "listening" || !recorderRef.current) return;
    stopLivePolls();
    setPollWarning(false);
    void recorderRef.current.stop().catch(() => {});
    setTargetIndex(undefined);
    setProvisionalFrom(null);
    setLiveResult(null);
    setStatus("idle");
  }, [stopLivePolls]);

  // Background-context dialog: save persists (and trims) the draft, "no
  // context" clears it entirely; reopening prefills with what's active.
  const saveContext = useCallback(() => {
    const v = contextDraft.trim().slice(0, CONTEXT_MAX);
    setSource(v);
    storeContext(v);
    setContextOpen(false);
  }, [contextDraft]);

  const skipContext = useCallback(() => {
    setSource("");
    storeContext("");
    setContextDraft("");
    setContextOpen(false);
  }, []);

  // Empty the draft in place and hand focus back to the textarea, so fresh
  // context can be typed without closing the dialog first.
  const clearContextDraft = useCallback(() => {
    setContextDraft("");
    contextInputRef.current?.focus();
  }, []);

  const openContextDialog = useCallback(() => {
    setContextDraft(source);
    setContextOpen(true);
  }, [source]);

  // Typed correction for a wrong-marked line: Save persists it onto the wrong
  // record (upsert), an empty input or Skip just closes the dialog.
  const saveCorrection = useCallback(() => {
    const line = linesRef.current.find((l) => l.id === reasonTargetIdRef.current);
    if (line) {
      const text = correctionDraft.trim().slice(0, REASON_MAX);
      if (text) {
        setReasons((prev) => ({ ...prev, [line.id]: text }));
        void setWrongReason(
          line.id,
          line.takeId,
          {
            latex: line.latex,
            transcript: line.transcript,
            note: line.note,
            confidence: line.confidence,
            uncertain: line.uncertain,
          },
          text,
        );
      }
    }
    setCorrectionDraft("");
    setReasonTargetId(null);
  }, [correctionDraft]);

  const skipCorrection = useCallback(() => {
    setCorrectionDraft("");
    setReasonTargetId(null);
  }, []);

  const undo = useCallback(() => {
    setProvisionalFrom(null);
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [lines, ...f.slice(0, 49)]);
      setLines(prev);
      return p.slice(0, -1);
    });
  }, [lines]);

  const redo = useCallback(() => {
    setProvisionalFrom(null);
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPast((p) => [...p.slice(-49), lines]);
      setLines(next);
      return f.slice(1);
    });
  }, [lines]);

  // Swipe-to-delete: remove one line, keep it reachable via undo
  const deleteLine = useCallback((idx: number) => {
    const before = linesRef.current;
    if (idx < 0 || idx >= before.length) return;
    if (before[idx].id === reasonTargetIdRef.current) setReasonTargetId(null);
    setProvisionalFrom(null);
    setPast((p) => [...p.slice(-49), before]);
    setFuture([]);
    setLines(before.filter((_, i) => i !== idx));
    // The wrong-flag record survives in the database by design
  }, []);

  // Set a line's verdict ("wrong" or "correct"), or clear it with undefined.
  // Ctrl+Z never touches verdicts — tapping a marked row clears it, after
  // which either swipe is available again.
  const setVerdict = useCallback(
    (idx: number, verdict: "wrong" | "correct" | undefined) => {
      const line = linesRef.current[idx];
      if (!line) return;
      const meta = {
        latex: line.latex,
        transcript: line.transcript,
        note: line.note,
        confidence: line.confidence,
        uncertain: line.uncertain,
      };
      setVerdicts((prev) => {
        const next = { ...prev };
        if (verdict === undefined) delete next[line.id];
        else next[line.id] = verdict;
        return next;
      });
      if (verdict === undefined) {
        void unmarkWrong(line.id);
        void unmarkCorrect(line.id);
        setReasons((prev) => {
          if (!(line.id in prev)) return prev;
          const next = { ...prev };
          delete next[line.id];
          return next;
        });
      } else if (verdict === "wrong") {
        void unmarkCorrect(line.id);
        void markWrong(line.id, line.takeId, meta);
      } else {
        void unmarkWrong(line.id);
        void markCorrect(line.id, line.takeId, meta);
      }
    },
    [],
  );

  useEffect(() => {
    const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " ";
    const isUndo = (e: KeyboardEvent) =>
      (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey;
    const isRedo = (e: KeyboardEvent) =>
      ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z");
    const onKeyDown = (e: KeyboardEvent) => {
      if (contextOpen || reasonTargetId !== null) return;
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
      if (contextOpen || reasonTargetId !== null) return;
      if (!isSpace(e)) return;
      void finish();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [contextOpen, reasonTargetId, start, finish, undo, redo]);

  const listening = status === "listening";
  const thinking = status === "thinking";
  const reasonLine = reasonTargetId ? lines.find((l) => l.id === reasonTargetId) : undefined;
  const { mode: installMode, install, dismiss: dismissInstall } = useInstall();

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
                key={line.id}
                line={line}
                targeted={targetIndex === i}
                provisional={provisionalFrom !== null && i >= provisionalFrom}
                verdict={verdicts[line.id]}
                reason={reasons[line.id]}
                swipeEnabled={!listening && !thinking}
                onMicDown={() => {
                  setTargetIndex(i);
                  void start();
                }}
                onMicUp={() => void finish()}
                onDelete={() => deleteLine(i)}
                onSetVerdict={(v) => {
                  setVerdict(i, v);
                  if (v === "wrong") {
                    // Wrong-swipe opens the typed-correction dialog
                    setCorrectionDraft("");
                    setReasonTargetId(line.id);
                  } else if (reasonTargetIdRef.current === line.id) {
                    setReasonTargetId(null);
                  }
                }}
                onCancelDictation={cancel}
              />
            ))}
          </div>
        )}

        {liveResult && liveResult.lines[0] && (listening || thinking) && (
          <PendingEquation latex={liveResult.lines[0]} />
        )}
      </main>

      {reasonLine && (
        <div className="reason-sheet" role="dialog" aria-label="Typed correction">
          <div className="reason-what">
            <span className="reason-label">Marked wrong</span>
            <div
              className="reason-latex"
              dangerouslySetInnerHTML={{
                __html: katex.renderToString(reasonLine.latex, {
                  displayMode: false,
                  throwOnError: false,
                  strict: false,
                }),
              }}
            />
          </div>
          <form
            className="reason-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveCorrection();
            }}
          >
            <input
              className="reason-input"
              value={correctionDraft}
              onChange={(e) => setCorrectionDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") skipCorrection();
              }}
              placeholder="What should it be?"
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
            <button type="submit" className="reason-save">
              Save
            </button>
            <button type="button" className="reason-skip" onClick={skipCorrection}>
              Skip
            </button>
          </form>
        </div>
      )}

      <footer className="footer">
        {pollWarning && listening && (
          <span className="poll-warning" role="status">
            live preview unavailable — still recording
          </span>
        )}
        <div className="history">
          <button
            className={`ghost context-ghost ${source ? "has-context" : ""}`}
            onClick={openContextDialog}
            title="Background context for the AI"
          >
            <ContextGlyph />
          </button>
          <button className="ghost" disabled={past.length === 0} onClick={undo} title="Undo (Ctrl+Z)">
            <ArrowGlyph />
          </button>
          <button className="ghost" disabled={future.length === 0} onClick={redo} title="Redo (Ctrl+Shift+Z)">
            <ArrowGlyph mirrored />
          </button>
        </div>
        <div className="dictation">
          {listening && (
            <button
              className="orb orb-cancel"
              onClick={() => void cancel()}
              title="Cancel — discard this recording"
              aria-label="Cancel dictation"
            >
              <XGlyph />
            </button>
          )}
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
            aria-label="Hold to dictate"
            title={listening && targetIndex !== undefined ? `Editing line ${targetIndex + 1}` : undefined}
          >
            {listening || thinking ? (
              <Waveform level={levelRef} active={listening} />
            ) : (
              <MicGlyph size={20} />
            )}
          </button>
          {listening && (
            <button
              className="orb orb-confirm"
              onClick={() => void finish()}
              title="Finish — transcribe now"
              aria-label="Finish dictation"
            >
              <CheckGlyph />
            </button>
          )}
        </div>
        {installMode === "install" && (
          <button className="install" onClick={install} title="Install MathTex as an app">
            <InstallGlyph />
          </button>
        )}
      </footer>
      {installMode === "ios" && (
        <div className="install-hint" role="status">
          <span>
            Install: tap <b>Share</b> then <b>Add to Home Screen</b>
          </span>
          <button className="install-hint-dismiss" onClick={dismissInstall} title="Dismiss">
            ×
          </button>
        </div>
      )}
      {contextOpen && (
        <div className="context-overlay" role="dialog" aria-modal="true" aria-labelledby="context-title">
          <div className="context-dialog">
            <h2 id="context-title">Any context for the AI?</h2>
            <textarea
              className="context-input"
              ref={contextInputRef}
              value={contextDraft}
              onChange={(e) => setContextDraft(e.target.value)}
              placeholder="e.g. the problem statement you copied, or the LaTeX of the previous steps…"
              rows={6}
              autoFocus
            />
            <div className="context-actions">
              <button className="context-secondary context-clear" onClick={clearContextDraft}>
                Clear
              </button>
              <button className="context-secondary" onClick={skipContext}>
                No context
              </button>
              <button className="context-primary" onClick={saveContext}>
                Save context
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}