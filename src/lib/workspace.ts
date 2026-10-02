import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { getConvexClient, waitForAuthToken } from "./authClient";

export interface FileMeta {
  id: string;
  name: string;
  updatedAt: number;
}

/** The persisted shape of a line: App's Line with `id` renamed `lineId`. */
export interface LineData {
  lineId: string;
  takeId: string;
  latex: string;
  transcript: string;
  confidence: number;
  uncertain: boolean;
  note: string;
}

function getClient() {
  return getConvexClient();
}

function warn(e: unknown, what: string) {
  console.warn(`[workspace] ${what} failed`, e);
}

/** All files for the signed-in user, newest first. */
export async function listFiles(): Promise<FileMeta[]> {
  const c = getClient();
  if (!c) return [];
  try {
    // Boot race guard: hold for the auth token before the first query, or
    // the list can go out unauthenticated and read as empty (see
    // waitForAuthToken in authClient).
    await waitForAuthToken(5000);
    return await c.query(api.workspace.list, {});
  } catch (e) {
    warn(e, "listFiles");
    return [];
  }
}

export async function createFile(name: string): Promise<string | null> {
  const c = getClient();
  if (!c) return null;
  try {
    return await c.mutation(api.workspace.create, { name });
  } catch (e) {
    warn(e, "createFile");
    return null;
  }
}

export async function renameFile(id: string, name: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.mutation(api.workspace.rename, { id: id as Id<"files">, name });
  } catch (e) {
    warn(e, "renameFile");
  }
}

export async function deleteFile(id: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.mutation(api.workspace.remove, { id: id as Id<"files"> });
  } catch (e) {
    warn(e, "deleteFile");
  }
}

/** Load a file's lines. Null means the load failed — the caller keeps
 *  whatever it had instead of clobbering it with an empty stack. */
export async function loadLines(fileId: string): Promise<LineData[] | null> {
  const c = getClient();
  if (!c) return null;
  try {
    return await c.query(api.workspace.getLines, { fileId: fileId as Id<"files"> });
  } catch (e) {
    warn(e, "loadLines");
    return null;
  }
}

export function serializeLines(lines: LineData[]): string {
  return JSON.stringify(lines);
}

// Write-through sync with coalescing: rapid edits (undo spam, dictation
// promote+finalize) collapse into one in-flight write of the latest stack,
// so out-of-order writes can never resurrect a stale snapshot. Callers all
// await the same drain, so a failed final write is observable to the UI.
let pending: { fileId: string; lines: LineData[] } | null = null;
let drain: Promise<void> | null = null;

async function drainLatest(): Promise<void> {
  let lastError: unknown = null;
  while (pending) {
    const job = pending;
    pending = null;
    const c = getClient();
    if (!c) continue;
    try {
      await c.mutation(api.workspace.syncLines, {
        fileId: job.fileId as Id<"files">,
        lines: job.lines,
      });
    } catch (e) {
      lastError = e;
      warn(e, "syncLines");
    }
  }
  if (lastError) throw lastError;
}

/** Push the full stack for a file. Resolves when the latest state has
 *  landed; rejects if that final write failed. */
export function pushLines(fileId: string, lines: LineData[]): Promise<void> {
  pending = { fileId, lines };
  if (!drain) {
    drain = drainLatest().finally(() => {
      drain = null;
    });
  }
  return drain;
}
