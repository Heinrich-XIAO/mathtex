import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { getConvexClient } from "./authClient";
import type { JsonHealth } from "./api";

function getClient() {
  return getConvexClient();
}

export interface TakeMeta {
  latex: string;
  transcript: string;
  note: string;
  confidence: number;
  /** True when the model flagged part of the transcription as guessed/inferred. */
  uncertain?: boolean;
  /** Neutral ASR witness transcript (fish-audio) captured during the hold. */
  asr?: string;
  /** JSON health of the model response: clean/healed/repaired/failed. */
  jsonHealth?: JsonHealth;
  /** True when this take was dismissed (VAD/energy gate) instead of landing. */
  dismissed?: boolean;
  /** Why the clip was dismissed: "vad-guard" or "blank". */
  dismissReason?: string;
  /** VAD snapshot at dismiss time, for tuning thresholds from real misses. */
  vadSpeechMs?: number;
  vadMaxProb?: number;
  vadMeanProb?: number;
}

export interface VadMissMeta {
  transcript: string;
  asr?: string;
  vadSpeechMs?: number;
  vadMaxProb?: number;
  vadMeanProb?: number;
  dismissReason?: string;
}

/** Push a dictated take's audio + metadata to Convex. Fire-and-forget.
 *  `request` is the exact LLM request body (JSON string, audio stripped). */
export async function uploadTake(
  takeId: string,
  wav: Blob | ArrayBuffer,
  meta: TakeMeta,
  request?: string,
): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    const uploadUrl = await c.mutation(api.takes.generateUploadUrl, {});
    const body = wav instanceof Blob ? wav : new Blob([wav], { type: "audio/wav" });
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": body.type || "audio/wav" },
      body,
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
    await c.mutation(api.takes.saveTake, {
      takeId,
      storageId,
      ...meta,
      ...(request ? { request } : {}),
      dictatedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[convex] take upload failed", e);
  }
}

/** Verdict-shaped slice of TakeMeta: what the verdict tables store. */
function verdictMeta(meta: TakeMeta) {
  return {
    latex: meta.latex,
    transcript: meta.transcript,
    note: meta.note,
    confidence: meta.confidence,
    ...(meta.uncertain !== undefined ? { uncertain: meta.uncertain } : {}),
  };
}

/** Report a dismissed clip as real speech (VAD false negative).
 *  Fire-and-forget. Idempotent per takeId; the audio evidence lives on the
 *  matching takes row (dismissed=true). */
export async function reportVadMiss(takeId: string, meta: VadMissMeta): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.mutation(api.takes.reportVadMiss, {
      takeId,
      transcript: meta.transcript,
      ...(meta.asr !== undefined ? { asr: meta.asr } : {}),
      ...(meta.vadSpeechMs !== undefined ? { vadSpeechMs: meta.vadSpeechMs } : {}),
      ...(meta.vadMaxProb !== undefined ? { vadMaxProb: meta.vadMaxProb } : {}),
      ...(meta.vadMeanProb !== undefined ? { vadMeanProb: meta.vadMeanProb } : {}),
      ...(meta.dismissReason !== undefined ? { dismissReason: meta.dismissReason } : {}),
      reportedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[convex] reportVadMiss failed", e);
  }
}

/** Retract a missed-speech report. Fire-and-forget. */
export async function unreportVadMiss(takeId: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.mutation(api.takes.unreportVadMiss, { takeId });
  } catch (e) {
    console.warn("[convex] unreportVadMiss failed", e);
  }
}

/** Flag a line as wrong in the database. Fire-and-forget. */
export async function markWrong(
  lineId: string,
  takeId: string,
  meta: TakeMeta,
  reason?: string,
): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.mutation(api.takes.markWrong, {
      lineId,
      takeId,
      ...verdictMeta(meta),
      ...(reason ? { reason } : {}),
      markedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[convex] markWrong failed", e);
  }
}

/** Attach (or update) the typed correction on a wrong mark.
 *  Upserts, so a late reason lands even if the mark raced ahead. Fire-and-forget. */
export async function setWrongReason(
  lineId: string,
  takeId: string,
  meta: TakeMeta,
  reason: string,
): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.mutation(api.takes.setWrongReason, {
      lineId,
      takeId,
      ...verdictMeta(meta),
      reason,
      markedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[convex] setWrongReason failed", e);
  }
}

/** Remove a line's wrong flag in the database. Fire-and-forget. */
export async function unmarkWrong(lineId: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.mutation(api.takes.unmarkWrong, { lineId });
  } catch (e) {
    console.warn("[convex] unmarkWrong failed", e);
  }
}

/** Flag a line as correct in the database. Fire-and-forget. */
export async function markCorrect(
  lineId: string,
  takeId: string,
  meta: TakeMeta,
): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.mutation(api.takes.markCorrect, {
      lineId,
      takeId,
      ...verdictMeta(meta),
      markedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[convex] markCorrect failed", e);
  }
}

/** Remove a line's correct flag in the database. Fire-and-forget. */
export async function unmarkCorrect(lineId: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.mutation(api.takes.unmarkCorrect, { lineId });
  } catch (e) {
    console.warn("[convex] unmarkCorrect failed", e);
  }
}
