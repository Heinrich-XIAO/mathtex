import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";

type UserTable = "takes" | "wrongLines" | "correctLines";

/** Every write goes through here: no identity, no write. */
async function requireUser(ctx: MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Unauthenticated");
  return userId;
}

/** Decision latency for a verdict: ms from the line's dictation (the take's
 *  dictatedAt) to the mark. Absent when the take row isn't visible yet
 *  (seeded legacy lines) or the mark precedes it (clock skew). */
async function verdictLatency(
  ctx: MutationCtx,
  userId: Id<"users">,
  takeId: string,
  markedAt: number,
): Promise<number | undefined> {
  const take = await ctx.db
    .query("takes")
    .withIndex("by_user_takeId", (q) => q.eq("userId", userId).eq("takeId", takeId))
    .unique();
  if (!take) return undefined;
  const latency = markedAt - take.dictatedAt;
  return latency >= 0 ? latency : undefined;
}

/** Hand out a short-lived upload URL for one take's audio file. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Persist a take: audio storage id + the transcription metadata.
 *  Idempotent per (user, takeId); adopts an orphan row left over from
 *  before auth, so a re-dictated legacy takeId becomes owned instead of
 *  colliding. */
export const saveTake = mutation({
  args: {
    takeId: v.string(),
    storageId: v.id("_storage"),
    latex: v.string(),
    transcript: v.string(),
    note: v.string(),
    confidence: v.number(),
    uncertain: v.optional(v.boolean()),
    asr: v.optional(v.string()),
    dictatedAt: v.number(),
    request: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("takes")
      .withIndex("by_user_takeId", (q) => q.eq("userId", userId).eq("takeId", args.takeId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        storageId: args.storageId,
        latex: args.latex,
        transcript: args.transcript,
        note: args.note,
        confidence: args.confidence,
        uncertain: args.uncertain,
        asr: args.asr,
        ...(args.request !== undefined ? { request: args.request } : {}),
      });
      return;
    }
    await ctx.db.insert("takes", { ...args, userId });
  },
});

/** Mark a line wrong. Idempotent per lineId. */
export const markWrong = mutation({
  args: {
    lineId: v.string(),
    takeId: v.string(),
    latex: v.string(),
    transcript: v.string(),
    note: v.string(),
    confidence: v.number(),
    uncertain: v.optional(v.boolean()),
    markedAt: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("wrongLines")
      .withIndex("by_lineId", (q) => q.eq("lineId", args.lineId))
      .unique();
    if (existing) return;
    const latencyMs = await verdictLatency(ctx, userId, args.takeId, args.markedAt);
    await ctx.db.insert("wrongLines", {
      ...args,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      userId,
    });
  },
});

/** Attach or update the typed correction on a wrong mark.
 *  Upserts: if the mark hasn't landed yet (race), insert it complete. */
export const setWrongReason = mutation({
  args: {
    lineId: v.string(),
    takeId: v.string(),
    latex: v.string(),
    transcript: v.string(),
    note: v.string(),
    confidence: v.number(),
    uncertain: v.optional(v.boolean()),
    markedAt: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("wrongLines")
      .withIndex("by_lineId", (q) => q.eq("lineId", args.lineId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { reason: args.reason });
      return;
    }
    const latencyMs = await verdictLatency(ctx, userId, args.takeId, args.markedAt);
    await ctx.db.insert("wrongLines", {
      ...args,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      userId,
    });
  },
});

/** Unmark a line (the swipe toggle). Removes the record entirely. */
export const unmarkWrong = mutation({
  args: { lineId: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("wrongLines")
      .withIndex("by_lineId", (q) => q.eq("lineId", args.lineId))
      .unique();
    if (existing && existing.userId === userId) await ctx.db.delete(existing._id);
  },
});

/** Mark a line correct. Idempotent per lineId. */
export const markCorrect = mutation({
  args: {
    lineId: v.string(),
    takeId: v.string(),
    latex: v.string(),
    transcript: v.string(),
    note: v.string(),
    confidence: v.number(),
    uncertain: v.optional(v.boolean()),
    markedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("correctLines")
      .withIndex("by_lineId", (q) => q.eq("lineId", args.lineId))
      .unique();
    if (existing) return;
    const latencyMs = await verdictLatency(ctx, userId, args.takeId, args.markedAt);
    await ctx.db.insert("correctLines", {
      ...args,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      userId,
    });
  },
});

/** Unmark a correct verdict. Removes the record entirely. */
export const unmarkCorrect = mutation({
  args: { lineId: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("correctLines")
      .withIndex("by_lineId", (q) => q.eq("lineId", args.lineId))
      .unique();
    if (existing && existing.userId === userId) await ctx.db.delete(existing._id);
  },
});

/** One-off: assign every pre-auth orphan row to the given email's user
 *  account. Runs from the CLI (unauthenticated), so it's gated by a secret
 *  stored as the ADMIN_BACKFILL_SECRET deployment env var. */
export const backfillOrphans = mutation({
  args: { secret: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    // process isn't in the app-side type graph (this file is pulled into the
    // Vite tsconfig via _generated/api), so reach for it untyped.
    const secret = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.ADMIN_BACKFILL_SECRET;
    if (!secret || args.secret !== secret) {
      throw new Error("Invalid backfill secret");
    }
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .unique();
    if (!user) {
      throw new Error(`No signed-in user with email ${args.email} — sign in first`);
    }
    const counts: Record<UserTable, number> = { takes: 0, wrongLines: 0, correctLines: 0 };
    for (const table of ["takes", "wrongLines", "correctLines"] as const) {
      for await (const row of ctx.db.query(table)) {
        if (row.userId === undefined) {
          await ctx.db.patch(row._id, { userId: user._id });
          counts[table] += 1;
        }
      }
    }
    return counts;
  },
});