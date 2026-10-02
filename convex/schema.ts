import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,
  // Convex Auth's users table, plus an email index for the one-time backfill.
  users: defineTable({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    image: v.optional(v.string()),
    isAnonymous: v.optional(v.boolean()),
  }).index("email", ["email"]),

  // One row per dictated take: the audio is uploaded here immediately after
  // transcription, so it exists even if the line is never marked wrong.
  takes: defineTable({
    userId: v.optional(v.id("users")),
    takeId: v.string(),
    storageId: v.id("_storage"),
    latex: v.string(),
    transcript: v.string(),
    note: v.string(),
    confidence: v.number(),
    // Model's own uncertainty flag: any part of the latex guessed/inferred.
    uncertain: v.optional(v.boolean()),
    // Neutral ASR (fish-audio) witness transcript captured during the hold —
    // an independent hearing to compare against the model's transcript.
    asr: v.optional(v.string()),
    dictatedAt: v.number(),
    // Dismissed takes: the VAD/energy gate threw the clip away before it
    // could become a line. Stored so a false negative ("I spoke, it heard
    // nothing") keeps its audio evidence for a later missed-speech report.
    dismissed: v.optional(v.boolean()),
    // Why the clip was dismissed: "vad-guard" (VAD low + model unsure) or
    // "blank" (too short/quiet to even send).
    dismissReason: v.optional(v.string()),
    // VAD snapshot at dismiss time, for tuning thresholds from real misses.
    vadSpeechMs: v.optional(v.number()),
    vadMaxProb: v.optional(v.number()),
    vadMeanProb: v.optional(v.number()),
    // Exact LLM request body (JSON string) that produced this take's result —
    // model, temperature, response_format, full message array. Base64 audio
    // inside is replaced by a placeholder; the clip itself is in _storage.
    request: v.optional(v.string()),
    // JSON health of the model response that produced this take:
    // "clean" (parsed as-is), "healed" (salvaged by healJson without a
    // retry), "repaired" (first parse threw, retry parse succeeded),
    // "failed" (finalize failed; row holds the live provisional instead).
    // Absent on takes saved before this field existed.
    jsonHealth: v.optional(
      v.union(
        v.literal("clean"),
        v.literal("healed"),
        v.literal("repaired"),
        v.literal("failed"),
      ),
    ),
  })
    .index("by_takeId", ["takeId"])
    .index("by_user_takeId", ["userId", "takeId"]),

  // Workspace: one file = one ordered stack of dictated lines. Per-user,
  // written through from the client on every lines change.
  files: defineTable({
    userId: v.id("users"),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_updated", ["userId", "updatedAt"]),

  lines: defineTable({
    userId: v.id("users"),
    fileId: v.id("files"),
    // Client-generated stable id: verdicts/reasons are keyed by it, and it
    // survives undo/redo restores (re-inserting a line gets a new _id but
    // keeps its lineId, so marks keep pointing at the right line).
    lineId: v.string(),
    takeId: v.string(),
    latex: v.string(),
    transcript: v.string(),
    confidence: v.number(),
    uncertain: v.optional(v.boolean()),
    note: v.string(),
    order: v.number(),
  })
    .index("by_file_order", ["fileId", "order"])
    .index("by_lineId", ["lineId"]),

  // Verdicts. Deleting the line in the UI does NOT remove these —
  // they are a historical record. Unmarking does.
  wrongLines: defineTable({
    userId: v.optional(v.id("users")),
    lineId: v.string(),
    takeId: v.string(),
    latex: v.string(),
    transcript: v.string(),
    note: v.string(),
    confidence: v.number(),
    // Whether the line was rendered amber (uncertain) when the verdict landed.
    uncertain: v.optional(v.boolean()),
    markedAt: v.number(),
    // The student's typed correction ("what it should be"), captured right
    // after the wrong-swipe in the dialog. Optional: marks can land before
    // the correction is typed.
    reason: v.optional(v.string()),
    // Decision latency: ms from the line's dictation (the take's dictatedAt)
    // to this mark, computed server-side. Absent when the take row wasn't
    // visible yet (seeded legacy lines) or the clock ran backwards.
    latencyMs: v.optional(v.number()),
  })
    .index("by_lineId", ["lineId"])
    .index("by_takeId", ["takeId"]),

  // Correct-verdicts, same shape and lifetime as wrongLines.
  correctLines: defineTable({
    userId: v.optional(v.id("users")),
    lineId: v.string(),
    takeId: v.string(),
    latex: v.string(),
    transcript: v.string(),
    note: v.string(),
    confidence: v.number(),
    uncertain: v.optional(v.boolean()),
    markedAt: v.number(),
    latencyMs: v.optional(v.number()),
  })
    .index("by_lineId", ["lineId"])
    .index("by_takeId", ["takeId"]),

  // Missed-speech reports: the student says "I spoke, the VAD dismissed it".
  // One row per dismissed takeId; the audio evidence lives on the matching
  // takes row (dismissed=true). Deleting a line never touches these — they
  // are a historical record. Un-reporting removes the record.
  vadMisses: defineTable({
    userId: v.optional(v.id("users")),
    takeId: v.string(),
    transcript: v.string(),
    asr: v.optional(v.string()),
    vadSpeechMs: v.optional(v.number()),
    vadMaxProb: v.optional(v.number()),
    vadMeanProb: v.optional(v.number()),
    dismissReason: v.optional(v.string()),
    reportedAt: v.number(),
    latencyMs: v.optional(v.number()),
  }).index("by_takeId", ["takeId"]),

  // Correct-dismissal confirmations: "yes, that really was just noise".
  // Same shape as vadMisses, separate table — mirrors how correctLines and
  // wrongLines are kept apart for transcribed lines.
  vadHits: defineTable({
    userId: v.optional(v.id("users")),
    takeId: v.string(),
    transcript: v.string(),
    asr: v.optional(v.string()),
    vadSpeechMs: v.optional(v.number()),
    vadMaxProb: v.optional(v.number()),
    vadMeanProb: v.optional(v.number()),
    dismissReason: v.optional(v.string()),
    reportedAt: v.number(),
    latencyMs: v.optional(v.number()),
  }).index("by_takeId", ["takeId"]),
});