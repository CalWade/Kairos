export type ExtractionKind = "decision" | "convention" | "risk" | "workflow" | "none";

export type BaseExtraction = {
  kind: ExtractionKind;
  confidence: number;
  evidence_message_ids: string[];
  aliases: string[];
  negative_keys: string[];
  reasoning: string;
  should_remember?: boolean;
  reject_reason?: string;
  extractor_metadata?: Record<string, unknown>;
};

export type DecisionCandidate = BaseExtraction & {
  kind: "decision";
  topic: string;
  decision: string;
  options_considered: string[];
  reasons: string[];
  rejected_options: { option: string; reason: string }[];
  opposition: { speaker?: string; content: string }[];
  conclusion: string;
  stage?: string;
  valid_at?: string;
};

export type ConventionCandidate = BaseExtraction & {
  kind: "convention";
  topic: string;
  rule: string;
  owner?: string;
  target?: string;
  scope: "personal" | "team" | "org";
  valid_at?: string;
};

export type RiskCandidate = BaseExtraction & {
  kind: "risk";
  topic: string;
  risk: string;
  impact?: string;
  mitigation?: string;
  severity: "low" | "medium" | "high";
  review_after_days?: number;
};

export type WorkflowCandidate = BaseExtraction & {
  kind: "workflow";
  topic: string;
  trigger?: string;
  steps: string[];
  commands: string[];
  expected_result?: string;
};

export type NoneCandidate = BaseExtraction & {
  kind: "none";
};

export type ExtractionResult =
  | DecisionCandidate
  | ConventionCandidate
  | RiskCandidate
  | WorkflowCandidate
  | NoneCandidate;
