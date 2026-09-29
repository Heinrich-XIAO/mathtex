import { v } from "convex/values";
import { mutation } from "./_generated/server";

/** Hand out a short-lived upload URL for one take's audio file. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/** Persist a take: audio storage id + the transcription metadata. */
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
    const existing = await ctx.db
      .query("takes")
      .withIndex("by_takeId", (q) => q.eq("takeId", args.takeId))
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
    await ctx.db.insert("takes", args);
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
    const existing = await ctx.db
      .query("wrongLines")
      .withIndex("by_lineId", (q) => q.eq("lineId", args.lineId))
      .unique();
    if (existing) return;
    await ctx.db.insert("wrongLines", args);
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
    const existing = await ctx.db
      .query("wrongLines")
      .withIndex("by_lineId", (q) => q.eq("lineId", args.lineId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { reason: args.reason });
      return;
    }
    await ctx.db.insert("wrongLines", args);
  },
});

/** Unmark a line (the swipe toggle). Removes the record entirely. */
export const unmarkWrong = mutation({
  args: { lineId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("wrongLines")
      .withIndex("by_lineId", (q) => q.eq("lineId", args.lineId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
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
    const existing = await ctx.db
      .query("correctLines")
      .withIndex("by_lineId", (q) => q.eq("lineId", args.lineId))
      .unique();
    if (existing) return;
    await ctx.db.insert("correctLines", args);
  },
});

/** Unmark a correct verdict. Removes the record entirely. */
export const unmarkCorrect = mutation({
  args: { lineId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("correctLines")
      .withIndex("by_lineId", (q) => q.eq("lineId", args.lineId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
