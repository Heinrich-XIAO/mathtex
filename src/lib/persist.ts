import { ConvexHttpClient } from "convex/browser";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";

const URL = import.meta.env.VITE_CONVEX_URL as string | undefined;

let client: ConvexHttpClient | null = null;

function getClient(): ConvexHttpClient | null {
  if (!URL) return null;
  if (!client) client = new ConvexHttpClient(URL);
  return client;
}

export interface TakeMeta {
  latex: string;
  transcript: string;
  note: string;
  confidence: number;
}

/** Push a dictated take's audio + metadata to Convex. Fire-and-forget. */
export async function uploadTake(
  takeId: string,
  wav: Blob | ArrayBuffer,
  meta: TakeMeta,
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
      dictatedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[convex] take upload failed", e);
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
      ...meta,
      ...(reason ? { reason } : {}),
      markedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[convex] markWrong failed", e);
  }
}

/** Attach (or update) the spoken "what's wrong" reason on a wrong mark.
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
      ...meta,
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
      ...meta,
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
