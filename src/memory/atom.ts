/**
 * MemoryAtom 是 MemoryOps 的核心记忆单元。
 *
 * 它不是普通文本块，而是带有业务语义、证据链、时间状态、
 * 冲突关系和遗忘策略的企业协作记忆对象。
 */

export type MemoryAction =
  | "ADD"
  | "UPDATE"
  | "SUPERSEDE"
  | "DUPLICATE"
  | "CONFLICT"
  | "DELETE"
  | "NONE";

export type MemoryType =
  | "decision"
  | "convention"
  | "preference"
  | "workflow"
  | "risk"
  | "person_role"
  | "deadline"
  | "cli_command"
  | "knowledge";

export type MemoryScope = "personal" | "team" | "org";

export type MemoryLayer = "behavior" | "rule" | "knowledge";

export type MemoryFormation = "explicit" | "implicit" | "derived";

export type MemoryStatus =
  | "active"
  | "superseded"
  | "expired"
  | "deleted"
  | "conflict_pending";

export type DecayPolicy = "ebbinghaus" | "linear" | "step" | "none";

export type SourceChannel = "feishu" | "cli" | "openclaw" | "manual";

export type SourceType =
  | "feishu_message"
  | "feishu_doc"
  | "feishu_task"
  | "feishu_calendar"
  | "meeting_minutes"
  | "cli_history"
  | "manual_text";

export type ConflictRelation =
  | "DIRECT_CONFLICT"
  | "INDIRECT_INVALIDATION"
  | "CONDITIONAL"
  | "TEMPORAL_SEQUENCE"
  | "COMPLEMENT"
  | "INDEPENDENT";

export type MemorySource = {
  channel: SourceChannel;
  source_type: SourceType;
  event_id?: string;
  message_id?: string;
  doc_token?: string;
  uri?: string;
  chunk_ids?: string[];
  excerpt: string;
};

export type MemoryAtom = {
  id: string;

  /** 业务语义分类 */
  type: MemoryType;

  /** 主体范围与项目上下文 */
  scope: MemoryScope;
  project?: string;

  /** 抽象层级：行为、规则、知识 */
  layer: MemoryLayer;

  /** 形成方式：显式声明、隐式观察、推导生成 */
  formation: MemoryFormation;

  subject: string;
  content: string;

  /** Reconcile 阶段可能输出的动作建议；通常也会写入 event log */
  action?: MemoryAction;
  target_id?: string;

  /** 多时间戳模型 */
  created_at: string;
  observed_at: string;
  valid_at: string;
  invalid_at?: string;
  expired_at?: string;

  status: MemoryStatus;

  confidence: number;
  importance: 1 | 2 | 3 | 4 | 5;

  source: MemorySource;
  tags: string[];

  supersedes?: string[];
  superseded_by?: string;
  conflict_relation?: ConflictRelation;

  decay_policy: DecayPolicy;
  review_at?: string;
  access_count: number;
  last_accessed_at?: string;
};

export type CandidateFact = {
  fact: string;
  type: MemoryType;
  scope: MemoryScope;
  project?: string;
  layer: MemoryLayer;
  formation: MemoryFormation;
  subject: string;
  confidence: number;
  valid_at?: string;
  importance: 1 | 2 | 3 | 4 | 5;
  reasoning: string;
};

export type ReconcileDecision = {
  action: Exclude<MemoryAction, "DELETE">;
  target_id?: string;
  merged_content?: string;
  relation?: ConflictRelation;
  reasoning: string;
};
