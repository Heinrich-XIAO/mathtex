import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";

/** Every write goes through here: no identity, no write. */
async function requireUser(ctx: MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Unauthenticated");
  return userId;
}

/** Newest file first — the client opens the top one. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return (
      await ctx.db
        .query("files")
        .withIndex("by_user_updated", (q) => q.eq("userId", userId))
        .order("desc")
        .collect()
    ).map((f) => ({ id: f._id, name: f.name, updatedAt: f.updatedAt, context: f.context ?? "" }));
  },
});

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    return await ctx.db.insert("files", {
      userId,
      name: args.name,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const rename = mutation({
  args: { id: v.id("files"), name: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const file = await ctx.db.get(args.id);
    if (!file || file.userId !== userId) return;
    // updatedAt tracks line activity, not renames — no bump, so a rename
    // doesn't jump the file to the top of the list.
    await ctx.db.patch(args.id, { name: args.name });
  },
});

/** Set a file's background context. Like rename, this doesn't bump
 *  updatedAt — editing context shouldn't reorder the file list. */
export const setContext = mutation({
  args: { id: v.id("files"), context: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const file = await ctx.db.get(args.id);
    if (!file || file.userId !== userId) return;
    await ctx.db.patch(args.id, { context: args.context.slice(0, 4000) });
  },
});

/** Delete a file and every line in it. Verdict records survive by design. */
export const remove = mutation({
  args: { id: v.id("files") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const file = await ctx.db.get(args.id);
    if (!file || file.userId !== userId) return;
    for await (const line of ctx.db
      .query("lines")
      .withIndex("by_file_order", (q) => q.eq("fileId", args.id))) {
      await ctx.db.delete(line._id);
    }
    await ctx.db.delete(args.id);
  },
});

/** A file's lines, in stack order. */
export const getLines = query({
  args: { fileId: v.id("files") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const file = await ctx.db.get(args.fileId);
    if (!file || file.userId !== userId) return [];
    return (
      await ctx.db
        .query("lines")
        .withIndex("by_file_order", (q) => q.eq("fileId", args.fileId))
        .order("asc")
        .collect()
    ).map((l) => ({
      lineId: l.lineId,
      takeId: l.takeId,
      latex: l.latex,
      transcript: l.transcript,
      confidence: l.confidence,
      uncertain: l.uncertain ?? false,
      note: l.note,
    }));
  },
});

/** Write-through sync: replace the file's lines with the client's stack.
 *  Files are small (a worksheet), so delete-all + re-insert with
 *  order=index beats incremental diffs and keeps undo/redo trivial. */
export const syncLines = mutation({
  args: {
    fileId: v.id("files"),
    lines: v.array(
      v.object({
        lineId: v.string(),
        takeId: v.string(),
        latex: v.string(),
        transcript: v.string(),
        confidence: v.number(),
        uncertain: v.optional(v.boolean()),
        note: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.userId !== userId) return;
    for await (const line of ctx.db
      .query("lines")
      .withIndex("by_file_order", (q) => q.eq("fileId", args.fileId))) {
      await ctx.db.delete(line._id);
    }
    for (const [i, line] of args.lines.entries()) {
      await ctx.db.insert("lines", {
        ...line,
        userId,
        fileId: args.fileId,
        order: i,
      });
    }
    await ctx.db.patch(args.fileId, { updatedAt: Date.now() });
  },
});
