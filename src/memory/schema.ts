import { z } from "zod";

export const MemoryActionSchema = z.enum([
  "ADD",
  "UPDATE",
  "SUPERSEDE",
  "DUPLICATE",
  "CONFLICT",
  "DELETE",
  "NONE",
]);

export const MemoryTypeSchema = z.enum([
  "decision",
  "convention",
  "preference",
  "workflow",
  "risk",
  "person_role",
  "deadline",
  "cli_command",
  "knowledge",
]);

export const MemoryScopeSchema = z.enum(["personal", "team", "org"]);
export const MemoryLayerSchema = z.enum(["behavior", "rule", "knowledge"]);
export const MemoryFormationSchema = z.enum(["explicit", "implicit", "derived"]);
export const MemoryStatusSchema = z.enum([
  "active",
  "superseded",
  "expired",
  "deleted",
  "conflict_pending",
]);
export const DecayPolicySchema = z.enum(["ebbinghaus", "linear", "step", "none"]);
export const SourceChannelSchema = z.enum(["feishu", "cli", "openclaw", "manual"]);
export const SourceTypeSchema = z.enum([
  "feishu_message",
  "feishu_doc",
  "feishu_task",
  "feishu_calendar",
  "meeting_minutes",
  "cli_history",
  "manual_text",
]);
export const ConflictRelationSchema = z.enum([
  "DIRECT_CONFLICT",
  "INDIRECT_INVALIDATION",
  "CONDITIONAL",
  "TEMPORAL_SEQUENCE",
  "COMPLEMENT",
  "INDEPENDENT",
]);

export const MemorySourceSchema = z.object({
  channel: SourceChannelSchema,
  source_type: SourceTypeSchema,
  event_id: z.string().optional(),
  message_id: z.string().optional(),
  doc_token: z.string().optional(),
  uri: z.string().optional(),
  chunk_ids: z.array(z.string()).optional(),
  excerpt: z.string().min(1),
});

export const MemoryAtomSchema = z.object({
  id: z.string().min(1),
  type: MemoryTypeSchema,
  scope: MemoryScopeSchema,
  project: z.string().optional(),
  layer: MemoryLayerSchema,
  formation: MemoryFormationSchema,
  subject: z.string().min(1),
  content: z.string().min(1),
  action: MemoryActionSchema.optional(),
  target_id: z.string().optional(),
  created_at: z.string().datetime({ offset: true }),
  observed_at: z.string().datetime({ offset: true }),
  valid_at: z.string().datetime({ offset: true }),
  invalid_at: z.string().datetime({ offset: true }).optional(),
  expired_at: z.string().datetime({ offset: true }).optional(),
  status: MemoryStatusSchema,
  confidence: z.number().min(0).max(1),
  importance: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  source: MemorySourceSchema,
  tags: z.array(z.string()),
  supersedes: z.array(z.string()).optional(),
  superseded_by: z.string().optional(),
  conflict_relation: ConflictRelationSchema.optional(),
  decay_policy: DecayPolicySchema,
  review_at: z.string().datetime({ offset: true }).optional(),
  access_count: z.number().int().min(0),
  last_accessed_at: z.string().datetime({ offset: true }).optional(),
});

export const CandidateFactSchema = z.object({
  fact: z.string().min(1),
  type: MemoryTypeSchema,
  scope: MemoryScopeSchema,
  project: z.string().optional(),
  layer: MemoryLayerSchema,
  formation: MemoryFormationSchema,
  subject: z.string().min(1),
  confidence: z.number().min(0).max(1),
  valid_at: z.string().datetime({ offset: true }).optional(),
  importance: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  reasoning: z.string(),
});

export const ReconcileDecisionSchema = z.object({
  action: z.enum(["ADD", "UPDATE", "SUPERSEDE", "DUPLICATE", "CONFLICT", "NONE"]),
  target_id: z.string().optional(),
  merged_content: z.string().optional(),
  relation: ConflictRelationSchema.optional(),
  reasoning: z.string(),
});

export type MemoryAtomInput = z.infer<typeof MemoryAtomSchema>;
export type CandidateFactInput = z.infer<typeof CandidateFactSchema>;
export type ReconcileDecisionInput = z.infer<typeof ReconcileDecisionSchema>;
