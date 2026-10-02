import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  authHeaders,
  type CallContext,
  type DictationResult,
  type JsonHealth,
} from "./lib/api";
import {
  confirmVadDismiss,
  loadVerdicts,
  markCorrect,
  markWrong,
  reportVadMiss,
  setWrongReason,
  unconfirmVadDismiss,
  unmarkCorrect,
  unmarkWrong,
  unreportVadMiss,
  uploadTake,
} from "./lib/persist";
import { useInstall } from "./lib/install";
import {
  type FileMeta,
  type LineData,
  createFile,
  defaultDocumentName,
  deleteFile,
  listFiles,
  loadLines,
  pushLines,
  renameFile,
  serializeLines,
  setFileContext,
} from "./lib/workspace";
import { useConvexAuth, useAuthActions } from "@convex-dev/auth/react";
import Landing from "./Landing";

type Status = "idle" | "listening" | "thinking" | "error";

export interface Line {
  id: string;
  takeId: string;
  latex: string;
  transcript: string;
  confidence: number;
  uncertain: boolean;
  note: string;
}

/** A clip the VAD/energy gate dismissed, kept for a possible missed-speech
 *  verdict. `verdict` null = awaiting judgment; "miss" = incorrectly
 *  dismissed (was speech — report + parse); "correct" = correctly dismissed
 *  (really noise — stored in vadHits). `wav`/`final` are retained so a miss
 *  verdict can actually parse the clip instead of just logging it. */
export interface DismissedClip {
  takeId: string;
  dismissReason: string;
  vadSpeechMs?: number;
  vadMaxProb?: number;
  vadMeanProb?: number;
  transcript: string;
  asr: string;
  verdict: null | "miss" | "correct";
  parsing: boolean;
  wav?: ArrayBuffer;
  final?: DictationResult;
  finalRequest: string;
  finalHealth: JsonHealth;
  target?: number;
}

const LOW_CONFIDENCE = 0.7;
// Background context the student gives per document (Khan Academy copy,
// LaTeX, …): stored on the file in Convex (with a per-file localStorage
// cache) and sent to the LLM with every call for that file.
const CONTEXT_KEY = "mathtex.background-context";
const contextKey = (fileId: string) => `${CONTEXT_KEY}.${fileId}`;
const CONTEXT_MAX = 4000;
// Typed correction captured in the wrong-mark dialog: one sentence, capped.
const REASON_MAX = 200;

function loadStoredContext(fileId: string | null): string {
  if (!fileId) return "";
  try {
    return localStorage.getItem(contextKey(fileId)) ?? "";
  } catch {
    return "";
  }
}

/** The pre-per-document global value, adopted once into the open file. */
function loadLegacyGlobalContext(): string {
  try {
    return localStorage.getItem(CONTEXT_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeContext(fileId: string | null, v: string): void {
  if (!fileId) return;
  try {
    localStorage.setItem(contextKey(fileId), v);
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

/** The persisted line shape (workspace.ts) back into a UI line. */
function toLine(w: LineData): Line {
  return {
    id: w.lineId,
    takeId: w.takeId,
    latex: w.latex,
    transcript: w.transcript,
    confidence: w.confidence,
    uncertain: w.uncertain,
    note: w.note,
  };
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

function SignOutGlyph() {
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
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
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

function PencilGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={11}
      height={11}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
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

// Fractions (\frac, \sqrt, delimiters) are unbreakable: KaTeX pre-chunks
// breakable units (relations / binary ops) so .katex-display > .katex wraps
// first via CSS. A wrap whose first line is a tiny orphan (e.g. `x =` above
// a tall fraction) is degenerate — KaTeX broke at the relation but the
// remainder can't sit beside it, so we treat that as "can't wrap".
// Hierarchy: wrap (CSS, only when the wrap is proper) → shrink-to-fit
// (this hook, floor LATEX_MIN_SCALE) → horizontal scroll (CSS overflow-x).
// Shrinking is the last resort before scrolling.
const LATEX_MIN_SCALE = 0.55;

// Group .katex-html's direct children (KaTeX's break chunks) into visual
// lines by vertical overlap — inline boxes on the same line always overlap
// vertically, and normal flow never overlaps across lines.
function latexVisualLines(el: HTMLElement): { width: number }[] {
  const html = el.querySelector(".katex-html");
  if (!html) return [];
  const lines: { top: number; bottom: number; left: number; right: number }[] = [];
  for (const child of Array.from(html.children) as HTMLElement[]) {
    if (getComputedStyle(child).position === "absolute") continue;
    const r = child.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cur = lines[lines.length - 1];
    if (cur) {
      const overlap = Math.min(cur.bottom, r.bottom) - Math.max(cur.top, r.top);
      if (overlap > 0.5) {
        cur.top = Math.min(cur.top, r.top);
        cur.bottom = Math.max(cur.bottom, r.bottom);
        cur.left = Math.min(cur.left, r.left);
        cur.right = Math.max(cur.right, r.right);
        continue;
      }
    }
    lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  }
  return lines.map((l) => ({ width: l.right - l.left }));
}

function useAutoShrink(dep: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let disposed = false;
    const fit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (disposed || !el.isConnected) return;
        // Everything below is measured at the base font size so the decision
        // is stable across repeated runs (RO re-entry after fontSize changes).
        el.style.fontSize = "";
        const avail = el.clientWidth;
        if (avail <= 0) return;
        // Natural unwrapped width (max-content, same tick, never painted).
        el.style.width = "max-content";
        const natural = el.clientWidth;
        el.style.width = "";
        if (natural <= avail + 1) return; // fits on one line at full size.
        const basePx = parseFloat(getComputedStyle(el).fontSize) || 20.8;
        const lines = latexVisualLines(el);
        const wrappedW = el.scrollWidth;
        if (lines.length > 1) {
          const maxW = Math.max(...lines.map((l) => l.width));
          const hanging = lines[0].width < 0.5 * maxW; // orphan prefix like `x =`
          if (!hanging) {
            if (wrappedW <= avail + 1) return; // proper wrap fits — keep it.
            // Wrap is proper but one line still overflows: keep the wrap and
            // shrink just enough for the widest wrapped line.
            const s = Math.max(LATEX_MIN_SCALE, avail / wrappedW);
            if (s < 1) el.style.fontSize = `${(basePx * s).toFixed(2)}px`;
            return;
          }
        }
        // No proper wrap (atomic remainder or hanging prefix): one line.
        const scale = avail / natural;
        if (scale >= LATEX_MIN_SCALE) {
          el.style.fontSize = `${(basePx * Math.min(1, scale) * 0.999).toFixed(2)}px`;
          return;
        }
        // Even the floor can't make one line fit: scroll (CSS fallback).
        el.style.fontSize = `${(basePx * LATEX_MIN_SCALE).toFixed(2)}px`;
      });
    };
    fit();
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    const fontsReady = document.fonts?.ready;
    if (fontsReady) {
      void fontsReady
        .then(() => {
          if (!disposed) fit();
        })
        .catch(() => {});
    }
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [dep]);
  return ref;
}

function PendingEquation({ latex }: { latex: string }) {
  const html = useMemo(
    () => katex.renderToString(latex, { displayMode: true, throwOnError: false, strict: false }),
    [latex],
  );
  const fitRef = useAutoShrink(html);
  return (
    <div className="pending-line" aria-live="polite">
      <div ref={fitRef} className="latex" dangerouslySetInnerHTML={{ __html: html }} />
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

  const fitRef = useAutoShrink(html);

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
        <div ref={fitRef} className="latex" dangerouslySetInnerHTML={{ __html: html }} />
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

/** Dismissed-as-noise banner with the same Tinder swipe as lines: right =
 *  correctly dismissed (really noise), left = incorrectly dismissed (was
 *  speech — reports the miss and parses the clip). Buttons mirror the
 *  swipes for desktop; × just hides without storing a verdict. */
function DismissBanner({
  clip,
  swipeEnabled,
  onCorrect,
  onMiss,
  onUndo,
  onHide,
}: {
  clip: DismissedClip;
  swipeEnabled: boolean;
  onCorrect: () => void;
  onMiss: () => void;
  onUndo: () => void;
  onHide: () => void;
}) {
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

  useEffect(() => {
    setBody(0, false);
    setStamps(0);
  }, [clip.takeId, setBody, setStamps]);

  const heard = (clip.transcript || clip.asr).slice(0, 80);

  return (
    <div
      className="dismiss-banner"
      role="status"
      onPointerDownCapture={(e) => {
        const d = dragRef.current;
        d.id = e.pointerId;
        d.startX = e.clientX;
        d.startY = e.clientY;
        d.active = false;
        d.lastX = e.clientX;
        d.lastT = e.timeStamp;
        d.vx = 0;
        suppressClickRef.current = false;
      }}
      onPointerMoveCapture={(e) => {
        const d = dragRef.current;
        if (d.id === -1 || e.pointerId !== d.id) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (!d.active) {
          if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy)) return;
          if (!swipeEnabled) return;
          d.active = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        const dt = e.timeStamp - d.lastT;
        if (dt > 0) d.vx = (e.clientX - d.lastX) / dt;
        d.lastX = e.clientX;
        d.lastT = e.timeStamp;
        const next = Math.max(-96, Math.min(96, dx));
        setBody(next, false);
        setStamps(next);
      }}
      onPointerUpCapture={(e) => {
        const d = dragRef.current;
        if (d.id === -1 || e.pointerId !== d.id) return;
        d.id = -1;
        if (!d.active) return;
        d.active = false;
        suppressClickRef.current = true;
        const dx = e.clientX - d.startX;
        const commit = Math.abs(dx) >= SWIPE_COMMIT || Math.abs(d.vx) >= FLICK_VX;
        setBody(0, true);
        setStamps(0);
        if (commit) {
          if (dx >= 0) onCorrect();
          else onMiss();
        }
      }}
      onPointerCancelCapture={() => {
        dragRef.current.id = -1;
        dragRef.current.active = false;
        setBody(0, true);
        setStamps(0);
      }}
    >
      <div ref={bodyRef} className="dismiss-banner-body">
        {clip.parsing ? (
          <span>Parsing dismissed clip…</span>
        ) : clip.verdict === "miss" ? (
          <>
            <span>Reported as missed speech — parsing…</span>
            <button className="dismiss" onClick={onHide} aria-label="Dismiss">
              ×
            </button>
          </>
        ) : clip.verdict === "correct" ? (
          <>
            <span>Marked correctly dismissed.</span>
            <button className="dismiss-action" onClick={onUndo}>
              Undo
            </button>
            <button className="dismiss" onClick={onHide} aria-label="Dismiss">
              ×
            </button>
          </>
        ) : (
          <>
            <span>
              Dismissed as bg noise
              {clip.vadSpeechMs !== undefined ? ` · ${clip.vadSpeechMs}ms` : ""}
              {heard ? ` — “${heard}”` : ""}
            </span>
            <button
              className="dismiss-action primary"
              onClick={(e) => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                e.stopPropagation();
                onMiss();
              }}
              title="Report as real speech and parse it"
            >
              That was speech
            </button>
            <button
              className="dismiss-action"
              onClick={(e) => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                e.stopPropagation();
                onCorrect();
              }}
              title="Confirm this really was noise"
            >
              Correct
            </button>
            <button
              className="dismiss"
              onClick={onHide}
              aria-label="Dismiss without saving"
              title="Dismiss without saving"
            >
              ×
            </button>
          </>
        )}
      </div>
      <div ref={stampRightRef} className="stamp stamp-right" aria-hidden>
        Correct
      </div>
      <div ref={stampLeftRef} className="stamp stamp-left" aria-hidden>
        Speech
      </div>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  // Neutral "heard you, did nothing, here's why" banner for every automatic
  // no-op discard (blank gate, model noop, held-back delete, structural
  // no-op). Unlike `error` (red, failure) this is informational; unlike
  // `dismissed` (amber, reportable with audio) it carries no verdict actions.
  const [notice, setNotice] = useState<string | null>(null);
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
  // Workspace persistence (Convex): file list + the active file's stack,
  // written through on every lines change.
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [wsLoading, setWsLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [targetIndex, setTargetIndex] = useState<number | undefined>(undefined);
  const [liveResult, setLiveResult] = useState<DictationResult | null>(null);
  const [provisionalFrom, setProvisionalFrom] = useState<number | null>(null);
  // Latest dismissed clip (VAD/energy gate): kept so a false negative ("I
  // spoke, it heard nothing") can be reported as real speech. Audio is
  // already uploaded as a dismissed take; a miss verdict adds a vadMisses
  // row and parses the clip, a correct verdict adds a vadHits row.
  const [dismissed, setDismissed] = useState<DismissedClip | null>(null);
  const dismissedRef = useRef<DismissedClip | null>(null);
  useEffect(() => {
    dismissedRef.current = dismissed;
  }, [dismissed]);
  // Background context for the LLM: `source` is what gets sent, the dialog
  // drafts an edit of it. Per-document: switching files swaps it; saves land
  // on the active file (Convex + per-file local cache). The dialog opens
  // only when a new document is created — never on startup — prefilled from
  // the new file (empty).
  const [source, setSource] = useState<string>("");
  const [contextOpen, setContextOpen] = useState(false);
  const [contextDraft, setContextDraft] = useState<string>("");
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
  const activeFileIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeFileIdRef.current = activeFileId;
  }, [activeFileId]);
  const renamingIdRef = useRef<string | null>(null);
  useEffect(() => {
    renamingIdRef.current = renamingId;
  }, [renamingId]);
  // Guards the sync effect while a file switch/boot is swapping the stack —
  // a mid-switch write could otherwise push one file's lines under another.
  const switchLockRef = useRef(false);
  const lastSyncRef = useRef("");
  const bootRef = useRef<Promise<void> | null>(null);

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
    setNotice(null);
    setLiveResult(null);
    pollFailures.current = 0;
    setPollWarning(false);
    liveCoverageRef.current = 0;
    asrRef.current = "";
    // Warm the serverless function while the user is speaking (fire-and-forget).
    // Authenticated so the ping exercises the full path instead of bouncing
    // off the JWT gate — and stops spamming 401s into the server logs.
    void fetch("/api/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
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
        // A longer hold that still trips the energy gate could be a whisper
        // or a mic issue — keep its audio and offer a missed-speech report
        // via the dismissed banner. Shorter holds get a notice banner instead
        // of vanishing silently: no audio is retained for these.
        if (durationMs >= 800) {
          const blankTakeId = uid();
          const blankAsr = asrRef.current;
          try {
            const wavAndPcmBlank = await blobToWav(blob);
            const blankSpeech = await analyzeSpeech(wavAndPcmBlank.pcm);
            void uploadTake(blankTakeId, wavAndPcmBlank.wav, {
              latex: "",
              transcript: "",
              note: "",
              confidence: 0,
              ...(blankAsr ? { asr: blankAsr } : {}),
              dismissed: true,
              dismissReason: "blank",
              ...(blankSpeech.ok
                ? {
                    vadSpeechMs: blankSpeech.speechMs,
                    vadMaxProb: blankSpeech.maxProb,
                    vadMeanProb: blankSpeech.meanProb,
                  }
                : {}),
            }, "");
            setDismissed({
              takeId: blankTakeId,
              dismissReason: "blank",
              ...(blankSpeech.ok
                ? {
                    vadSpeechMs: blankSpeech.speechMs,
                    vadMaxProb: blankSpeech.maxProb,
                    vadMeanProb: blankSpeech.meanProb,
                  }
                : {}),
              transcript: "",
              asr: blankAsr,
              verdict: null,
              parsing: false,
              wav: wavAndPcmBlank.wav.slice(0),
              finalRequest: "",
              finalHealth: "failed",
              target,
            });
          } catch {
            // Conversion failed: still offer the report (metadata-only).
            setDismissed({
              takeId: blankTakeId,
              dismissReason: "blank",
              transcript: "",
              asr: blankAsr,
              verdict: null,
              parsing: false,
              finalRequest: "",
              finalHealth: "failed",
              target,
            });
          }
        } else {
          setNotice(
            isTargetedEdit
              ? "Heard almost nothing — hold the line mic longer and say the full edit."
              : "Heard almost nothing — hold the pill longer and speak up.",
          );
        }
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
      let finalHealth: JsonHealth = "failed";
      let finalErr: unknown = null;
      try {
        ({ result: final, request: finalRequest, jsonHealth: finalHealth } = await dictate(wavAndPcm.wav, ctx, {
          vadStats,
          asr: asrRef.current,
        }));
      } catch (e) {
        finalErr = e;
        await new Promise((r) => setTimeout(r, 700));
        try {
          ({ result: final, request: finalRequest, jsonHealth: finalHealth } = await dictate(wavAndPcm.wav, ctx, {
            vadStats,
            asr: asrRef.current,
          }));
          finalErr = null;
        } catch (e2) {
          finalErr = e2;
        }
      }
      const describe = (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        // The browser's raw network failure — say what it means to a student.
        return msg === "Failed to fetch" || msg === "Load failed"
          ? "network unreachable — check your connection and retry"
          : msg;
      };
      if (final) {
        // 3b) Recovery bias for destructive modes: the corpus's only destructive
        //    failure (a 0.58-confidence replace clobbering a good line) is
        //    cheaper to prevent than to undo — an append of a stray line is a
        //    swipe away from deletion, an overwrite is not. Downgrade mutating
        //    results that arrive under-confident instead of executing them.
        let deleteHeldBack = false;
        if (final.mode === "replace_line" && final.confidence < MUTATION_MIN_CONFIDENCE) {
          final = { ...final, mode: "append" };
        } else if (final.mode === "delete_last" && !vadConfirmed && final.confidence < MUTATION_MIN_CONFIDENCE) {
          final = { ...final, mode: "noop" };
          deleteHeldBack = true;
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
          // Keep the audio: a VAD false negative ("I spoke, it heard
          // nothing") stays reportable via the dismissed banner instead of
          // vanishing. The takes row carries dismissed=true + VAD stats.
          void uploadTake(takeId, wavAndPcm.wav, {
            latex: final.lines.join("\n"),
            transcript: final.transcript,
            note: final.note,
            confidence: final.confidence,
            uncertain: final.uncertain,
            ...(asrRef.current ? { asr: asrRef.current } : {}),
            jsonHealth: finalHealth,
            dismissed: true,
            dismissReason: "vad-guard",
            ...(speech.ok
              ? {
                  vadSpeechMs: speech.speechMs,
                  vadMaxProb: speech.maxProb,
                  vadMeanProb: speech.meanProb,
                }
              : {}),
          }, finalRequest);
          setDismissed({
            takeId,
            dismissReason: "vad-guard",
            ...(speech.ok
              ? {
                  vadSpeechMs: speech.speechMs,
                  vadMaxProb: speech.maxProb,
                  vadMeanProb: speech.meanProb,
                }
              : {}),
            transcript: final.transcript,
            asr: asrRef.current,
            verdict: null,
            parsing: false,
            wav: wavAndPcm.wav.slice(0),
            final,
            finalRequest,
            finalHealth,
            target,
          });
          setProvisionalFrom(null);
          setTargetIndex(undefined);
          setLiveResult(null);
          setStatus("idle");
          return;
        }
        setProvisionalFrom(null);
        const res = final;
        // Model noop: nothing to add, but never silent — banner what was
        // heard (or that nothing intelligible arrived). The take is still
        // uploaded below so the audio stays reachable.
        if (res.mode === "noop") {
          if (promotedAt !== null) setLines(before);
          const heard = (res.transcript || asrRef.current).trim().slice(0, 80);
          setNotice(
            deleteHeldBack
              ? `Kept the last line — the delete sounded unsure${heard ? ` (“${heard}”)` : ""}.`
              : heard
                ? `Heard “${heard}” — no math to add.`
                : "Heard no math — nothing added.",
          );
          void uploadTake(takeId, wavAndPcm.wav, {
            latex: final.lines.join("\n"),
            transcript: final.transcript,
            note: final.note,
            confidence: final.confidence,
            uncertain: final.uncertain,
            asr: asrRef.current,
            jsonHealth: finalHealth,
          }, finalRequest);
          setTargetIndex(undefined);
          setLiveResult(null);
          setStatus("idle");
          return;
        }
        // Structural no-op: a mutating mode that lands on nothing
        // (replace_line with no lines, delete_last on an empty file). The
        // applyResult call would leave the stack visually untouched, so say
        // so instead of going quiet.
        {
          const baseForCheck = promotedAt !== null ? before : linesRef.current;
          const probe = applyResult(baseForCheck, res, target, takeId);
          const structuralNoop =
            probe === baseForCheck ||
            (res.mode === "delete_last" && baseForCheck.length === 0);
          if (structuralNoop) {
            if (promotedAt !== null) setLines(before);
            setNotice(
              res.mode === "delete_last"
                ? "Nothing to delete — the file is empty."
                : res.mode === "replace_line"
                  ? "Nothing to replace — there is no line to edit yet."
                  : "Nothing changed — nothing added.",
            );
            void uploadTake(takeId, wavAndPcm.wav, {
              latex: final.lines.join("\n"),
              transcript: final.transcript,
              note: final.note,
              confidence: final.confidence,
              uncertain: final.uncertain,
              asr: asrRef.current,
              jsonHealth: finalHealth,
            }, finalRequest);
            setTargetIndex(undefined);
            setLiveResult(null);
            setStatus("idle");
            return;
          }
        }
        setNotice(null);
        setLines((prev) => applyResult(promotedAt !== null ? before : prev, res, target, takeId));
        // Upload every take's audio immediately, whatever the line's fate
        void uploadTake(takeId, wavAndPcm.wav, {
          latex: final.lines.join("\n"),
          transcript: final.transcript,
          note: final.note,
          confidence: final.confidence,
          uncertain: final.uncertain,
          asr: asrRef.current,
          jsonHealth: finalHealth,
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
          jsonHealth: "failed",
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

  // Point the context state at a file: server value wins, then the per-file
  // offline cache, then the legacy pre-per-document global (adopted once into
  // this file and consumed, so new files start empty).
  const applyFileContext = useCallback((f: FileMeta) => {
    let ctx = f.context;
    if (ctx) {
      storeContext(f.id, ctx);
    } else {
      ctx = loadStoredContext(f.id);
      if (!ctx) {
        const legacy = loadLegacyGlobalContext();
        if (legacy) {
          ctx = legacy;
          storeContext(f.id, legacy);
          try {
            localStorage.removeItem(CONTEXT_KEY);
          } catch {
            /* private mode: legacy key just lingers */
          }
          void setFileContext(f.id, legacy);
          setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, context: legacy } : x)));
        }
      }
    }
    setSource(ctx);
    setContextDraft(ctx);
  }, []);

  // Background-context dialog: save persists (and trims) the draft onto the
  // active file, "no context" clears that file's context entirely; reopening
  // prefills with what's active.
  const saveContext = useCallback(() => {
    const v = contextDraft.trim().slice(0, CONTEXT_MAX);
    const fid = activeFileIdRef.current;
    setSource(v);
    storeContext(fid, v);
    if (fid) {
      setFiles((prev) => prev.map((f) => (f.id === fid ? { ...f, context: v } : f)));
      void setFileContext(fid, v);
    }
    setContextOpen(false);
  }, [contextDraft]);

  const skipContext = useCallback(() => {
    const fid = activeFileIdRef.current;
    setSource("");
    storeContext(fid, "");
    if (fid) {
      setFiles((prev) => prev.map((f) => (f.id === fid ? { ...f, context: "" } : f)));
      void setFileContext(fid, "");
    }
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

  // Dismissal verdicts, mirroring the line swipes: right = correctly
  // dismissed (really noise → vadHits row), left = incorrectly dismissed
  // (was speech → vadMisses row + actually parse the clip).
  function dismissedMeta(d: DismissedClip) {
    return {
      transcript: d.transcript,
      ...(d.asr ? { asr: d.asr } : {}),
      ...(d.vadSpeechMs !== undefined ? { vadSpeechMs: d.vadSpeechMs } : {}),
      ...(d.vadMaxProb !== undefined ? { vadMaxProb: d.vadMaxProb } : {}),
      ...(d.vadMeanProb !== undefined ? { vadMeanProb: d.vadMeanProb } : {}),
      dismissReason: d.dismissReason,
    };
  }

  const confirmDismissed = useCallback(() => {
    setDismissed((d) => {
      if (!d || d.verdict !== null || d.parsing) return d;
      void confirmVadDismiss(d.takeId, dismissedMeta(d));
      return { ...d, verdict: "correct" as const };
    });
  }, []);

  const undoDismissedVerdict = useCallback(() => {
    setDismissed((d) => {
      if (!d || d.verdict === null || d.parsing) return d;
      if (d.verdict === "correct") void unconfirmVadDismiss(d.takeId);
      else void unreportVadMiss(d.takeId);
      return { ...d, verdict: null };
    });
  }, []);

  // × hides without storing — the dismissed take row keeps the audio, just
  // with no verdict attached.
  const hideDismissed = useCallback(() => {
    setDismissed(null);
  }, []);

  // Swipe/button left on the banner: the dismissal was wrong, so report the
  // miss AND parse the clip — applying the discarded result, or running the
  // model on the retained audio when there is none (blank gate).
  const parseDismissed = useCallback(async () => {
    const d = dismissedRef.current;
    if (!d || d.verdict !== null || d.parsing) return;
    if (statusRef.current !== "idle") return;
    void reportVadMiss(d.takeId, dismissedMeta(d));
    setDismissed({ ...d, verdict: "miss" as const, parsing: true });
    setStatus("thinking");
    try {
      const target = d.target;
      if (d.final) {
        // VAD-guard case: the model already heard the clip — the user's
        // override bypasses the confidence guard and lands it.
        const res = d.final;
        const before = linesRef.current;
        setPast((p) => [...p.slice(-49), before]);
        setFuture([]);
        setLines(applyResult(before, res, target, d.takeId));
        if (d.wav) {
          void uploadTake(d.takeId, d.wav, {
            latex: res.lines.join("\n"),
            transcript: res.transcript,
            note: res.note,
            confidence: res.confidence,
            uncertain: res.uncertain,
            ...(d.asr ? { asr: d.asr } : {}),
            jsonHealth: d.finalHealth,
            dismissed: false,
            dismissReason: d.dismissReason,
            ...(d.vadSpeechMs !== undefined ? { vadSpeechMs: d.vadSpeechMs } : {}),
            ...(d.vadMaxProb !== undefined ? { vadMaxProb: d.vadMaxProb } : {}),
            ...(d.vadMeanProb !== undefined ? { vadMeanProb: d.vadMeanProb } : {}),
          }, d.finalRequest);
        }
      } else if (d.wav) {
        // Blank-gate case: never sent to the model — run it now against the
        // current file context.
        const ctxNow: CallContext = {
          lines: linesRef.current.map((l) => ({ latex: l.latex })),
          targetIndex: target,
          source,
        };
        const { result, request, jsonHealth } = await dictate(d.wav, ctxNow, {
          asr: d.asr,
        });
        const before = linesRef.current;
        setPast((p) => [...p.slice(-49), before]);
        setFuture([]);
        setLines(applyResult(before, result, target, d.takeId));
        void uploadTake(d.takeId, d.wav, {
          latex: result.lines.join("\n"),
          transcript: result.transcript,
          note: result.note,
          confidence: result.confidence,
          uncertain: result.uncertain,
          ...(d.asr ? { asr: d.asr } : {}),
          jsonHealth,
          dismissed: false,
          dismissReason: d.dismissReason,
          ...(d.vadSpeechMs !== undefined ? { vadSpeechMs: d.vadSpeechMs } : {}),
          ...(d.vadMaxProb !== undefined ? { vadMaxProb: d.vadMaxProb } : {}),
          ...(d.vadMeanProb !== undefined ? { vadMeanProb: d.vadMeanProb } : {}),
        }, request);
      } else {
        throw new Error("no audio retained for this clip");
      }
      setTargetIndex(undefined);
      setLiveResult(null);
      setProvisionalFrom(null);
      setDismissed(null);
      setStatus("idle");
    } catch (e) {
      setDismissed((prev) =>
        prev && prev.takeId === d.takeId ? { ...prev, verdict: null, parsing: false } : prev,
      );
      setStatus("error");
      setError(`Parse failed: ${(e as Error).message || "Something went wrong"}`);
    }
  }, [source]);

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
      if (contextOpen || reasonTargetId !== null || confirmDeleteId !== null) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      if (isUndo(e)) {
        if (typing) return; // inputs keep their own undo
        e.preventDefault();
        undo();
        return;
      }
      if (isRedo(e)) {
        if (typing) return;
        e.preventDefault();
        redo();
        return;
      }
      if (!isSpace(e) || e.repeat || typing) return;
      e.preventDefault();
      void start();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (contextOpen || reasonTargetId !== null || confirmDeleteId !== null) return;
      if (!isSpace(e)) return;
      void finish();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [contextOpen, reasonTargetId, confirmDeleteId, start, finish, undo, redo]);

  const listening = status === "listening";
  const thinking = status === "thinking";
  const reasonLine = reasonTargetId ? lines.find((l) => l.id === reasonTargetId) : undefined;
  const deleteTarget = confirmDeleteId ? files.find((f) => f.id === confirmDeleteId) : undefined;
  const { mode: installMode, install, dismiss: dismissInstall } = useInstall();

  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();

  const wsLines = useMemo<LineData[]>(
    () =>
      lines.map((l) => ({
        lineId: l.id,
        takeId: l.takeId,
        latex: l.latex,
        transcript: l.transcript,
        confidence: l.confidence,
        uncertain: l.uncertain,
        note: l.note,
      })),
    [lines],
  );

  // Verdicts live in Convex (wrongLines/correctLines) but stamps live in
  // React state — repaint them after every lines load, or a reload wipes
  // the colors while the rows survive. Merge-only: a swipe that lands
  // while the fetch is in flight keeps winning over the stale read.
  const hydrateVerdicts = useCallback((lineIds: string[]) => {
    if (lineIds.length === 0) return;
    void loadVerdicts(lineIds).then((vs) => {
      if (vs.length === 0) return;
      setVerdicts((prev) => {
        const next = { ...prev };
        for (const v of vs) {
          if (!(v.lineId in prev)) next[v.lineId] = v.verdict;
        }
        return next;
      });
      setReasons((prev) => {
        const next = { ...prev };
        for (const v of vs) {
          if (v.verdict === "wrong" && v.reason && !(v.lineId in prev)) {
            next[v.lineId] = v.reason;
          }
        }
        return next;
      });
    });
  }, []);

  // Workspace boot: open the newest file (creating a first one for new
  // users). bootRef holds the in-flight promise so StrictMode's double
  // effect can't create two default-named files.
  const bootWorkspace = useCallback(() => {
    if (bootRef.current) return;
    bootRef.current = (async () => {
      setWsLoading(true);
      try {
        let list = await listFiles();
        let isNew = false;
        if (list.length === 0) {
          const defaultName = defaultDocumentName();
          const id = await createFile(defaultName);
          if (id) {
            list = [{ id, name: defaultName, updatedAt: Date.now(), context: "" }];
            isNew = true;
          }
        }
        setFiles(list);
        const first = list[0];
        if (first) {
          switchLockRef.current = true;
          setActiveFileId(first.id);
          applyFileContext(first);
          // First-ever boot created this document — prompt for its context.
          // Returning users with existing files never see this on startup.
          if (isNew) setContextOpen(true);
          const loaded = await loadLines(first.id);
          if (loaded) {
            setLines(loaded.map(toLine));
            lastSyncRef.current = serializeLines(loaded);
          }
          switchLockRef.current = false;
          if (loaded) hydrateVerdicts(loaded.map((l) => l.lineId));
        }
      } catch (e) {
        console.warn("[workspace] boot failed", e);
      } finally {
        setWsLoading(false);
      }
    })();
  }, [hydrateVerdicts, applyFileContext]);

  useEffect(() => {
    if (isAuthenticated) {
      bootWorkspace();
    } else if (bootRef.current) {
      // Signed out: clear workspace state so the next sign-in boots fresh
      bootRef.current = null;
      setFiles([]);
      setActiveFileId(null);
      setSource("");
      setContextDraft("");
      setLines([]);
      setVerdicts({});
      setReasons({});
      setDismissed(null);
      setPast([]);
      setFuture([]);
      setWsLoading(true);
    }
  }, [isAuthenticated, bootWorkspace]);

  // Write-through: every committed lines change (dictate, delete, undo,
  // redo, file switch) lands in Convex. lastSyncRef skips no-op rewrites;
  // pushLines coalesces bursts into the latest stack.
  useEffect(() => {
    if (!activeFileId || !isAuthenticated || switchLockRef.current) return;
    const payload = serializeLines(wsLines);
    if (payload === lastSyncRef.current) return;
    lastSyncRef.current = payload;
    void pushLines(activeFileId, wsLines).catch(() => {
      // Failed write: clear the marker so the next change retries it
      lastSyncRef.current = "";
    });
  }, [wsLines, activeFileId, isAuthenticated]);

  // Switch files: history resets (undo is per-file) and the background
  // context swaps to the new file's; verdicts and typed
  // reasons survive — they're keyed by globally-unique line ids.
  const switchFile = useCallback(async (f: FileMeta) => {
    if (f.id === activeFileIdRef.current) return;
    switchLockRef.current = true;
    setConfirmDeleteId(null);
    setRenamingId(null);
    setNotice(null);
    setActiveFileId(f.id);
    applyFileContext(f);
    setLines([]);
    setPast([]);
    setFuture([]);
    lastSyncRef.current = "[]";
    const loaded = await loadLines(f.id);
    if (loaded) {
      setLines(loaded.map(toLine));
      lastSyncRef.current = serializeLines(loaded);
    }
    switchLockRef.current = false;
    if (loaded) hydrateVerdicts(loaded.map((l) => l.lineId));
  }, [hydrateVerdicts, applyFileContext]);

  const newFile = useCallback(async () => {
    const defaultName = defaultDocumentName();
    const id = await createFile(defaultName);
    if (!id) return;
    const file: FileMeta = { id, name: defaultName, updatedAt: Date.now(), context: "" };
    setFiles((prev) => [file, ...prev]);
    await switchFile(file);
    // A new document starts context-free — prompt for it now.
    setContextDraft("");
    setContextOpen(true);
  }, [switchFile]);

  const beginRename = useCallback((f: FileMeta) => {
    setConfirmDeleteId(null);
    setRenamingId(f.id);
    setRenameDraft(f.name);
  }, []);

  const commitRename = useCallback(() => {
    const id = renamingIdRef.current;
    setRenamingId(null);
    if (!id) return;
    const name = renameDraft.trim().slice(0, 60) || defaultDocumentName();
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
    void renameFile(id, name);
  }, [renameDraft]);

  // Delete file: ✕ opens a confirmation dialog (same overlay style as the
  // background-context dialog); Delete confirms, Cancel/Esc/overlay dismisses.
  const requestDelete = useCallback((f: FileMeta) => {
    setConfirmDeleteId(f.id);
  }, []);

  const cancelDelete = useCallback(() => {
    setConfirmDeleteId(null);
  }, []);

  const confirmDelete = useCallback(() => {
    const id = confirmDeleteId;
    if (!id) return;
    setConfirmDeleteId(null);
    void (async () => {
      await deleteFile(id);
      const rest = files.filter((x) => x.id !== id);
      setFiles(rest);
      if (id === activeFileIdRef.current) {
        if (rest[0]) {
          await switchFile(rest[0]);
        } else {
          switchLockRef.current = true;
          setActiveFileId(null);
          setSource("");
          setContextDraft("");
          setLines([]);
          setPast([]);
          setFuture([]);
          lastSyncRef.current = "[]";
          switchLockRef.current = false;
        }
      }
    })();
  }, [confirmDeleteId, files, switchFile]);

  // wsLoading only gates the signed-in path — an unauthenticated visitor
  // must reach the Landing page, not wait on a workspace that never boots.
  if (isLoading || (isAuthenticated && wsLoading)) {
    return (
      <div className="landing">
        <div className="landing-card">
          <p className="landing-muted">Loading…</p>
        </div>
      </div>
    );
  }
  if (!isAuthenticated) return <Landing />;

  return (
    <div className={`app${listening ? " listening" : ""}`}>
      <header className="filebar">
        <button className="file-new" onClick={() => void newFile()} title="New file" aria-label="New file">
          +
        </button>
        {files.map((f) => {
          const active = f.id === activeFileId;
          return (
            <div key={f.id} className={`file-chip${active ? " active" : ""}`}>
              {renamingId === f.id ? (
                <input
                  className="file-rename-input"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={commitRename}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="File name"
                />
              ) : (
                <>
                  <button className="file-name" onClick={() => void switchFile(f)}>
                    {f.name}
                  </button>
                  {active && (
                    <>
                      <button
                        className="file-action"
                        onClick={() => beginRename(f)}
                        title="Rename file"
                        aria-label="Rename file"
                      >
                        <PencilGlyph />
                      </button>
                      <button
                        className="file-action danger"
                        onClick={() => requestDelete(f)}
                        title="Delete file"
                        aria-label="Delete file"
                      >
                        <XGlyph size={11} />
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}
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
        {notice && !listening && !thinking && (
          <div className="notice-banner" role="status">
            {notice}
            <button className="dismiss" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {dismissed && !listening && (!thinking || dismissed.parsing) && (
          <DismissBanner
            clip={dismissed}
            swipeEnabled={!dismissed.parsing && dismissed.verdict === null}
            onCorrect={confirmDismissed}
            onMiss={() => void parseDismissed()}
            onUndo={undoDismissedVerdict}
            onHide={hideDismissed}
          />
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
          <button className="ghost" onClick={() => void signOut()} title="Sign out">
            <SignOutGlyph />
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
      {deleteTarget && (
        <div
          className="context-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-title"
          onClick={cancelDelete}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancelDelete();
          }}
        >
          <div className="context-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 id="delete-title">Delete “{deleteTarget.name}”?</h2>
            <p className="context-sub">This will permanently delete the file and its lines.</p>
            <div className="context-actions">
              <button className="context-secondary" onClick={cancelDelete} autoFocus>
                Cancel
              </button>
              <button className="context-primary danger" onClick={confirmDelete}>
                Delete
              </button>
            </div>
          </div>
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