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
    dictatedAt: v.number(),
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
    markedAt: v.number(),
    // The student's spoken explanation of what is wrong, captured right
    // after the wrong-swipe. Optional: marks can land before speech does.
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
    markedAt: v.number(),
  })
    .index("by_lineId", ["lineId"])
    .index("by_takeId", ["takeId"]),
});
