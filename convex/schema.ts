import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per dictated take: the audio is uploaded here immediately after
  // transcription, so it exists even if the line is never marked wrong.
  takes: defineTable({
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
    // Exact LLM request body (JSON string) that produced this take's result —
    // model, temperature, response_format, full message array. Base64 audio
    // inside is replaced by a placeholder; the clip itself is in _storage.
    request: v.optional(v.string()),
  }).index("by_takeId", ["takeId"]),

  // Verdicts. Deleting the line in the UI does NOT remove these —
  // they are a historical record. Unmarking does.
  wrongLines: defineTable({
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
  })
    .index("by_lineId", ["lineId"])
    .index("by_takeId", ["takeId"]),

  // Correct-verdicts, same shape and lifetime as wrongLines.
  correctLines: defineTable({
    lineId: v.string(),
    takeId: v.string(),
    latex: v.string(),
    transcript: v.string(),
    note: v.string(),
    confidence: v.number(),
    uncertain: v.optional(v.boolean()),
    markedAt: v.number(),
  })
    .index("by_lineId", ["lineId"])
    .index("by_takeId", ["takeId"]),
});
