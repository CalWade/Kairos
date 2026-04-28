import type { NormalizedMessage } from "./types.js";

export type CandidateSegment = {
  id: string;
  messages: NormalizedMessage[];
  topic_hint: string;
  start_time: number;
  end_time: number;
  boundary_reasons: string[];
  source: NormalizedMessage["source"];
};

export type SegmentOptions = {
  maxGapMs?: number;
  minTokenOverlap?: number;
};

const DEFAULT_MAX_GAP_MS = 15 * 60 * 1000;
const DEFAULT_MIN_TOKEN_OVERLAP = 0.12;

/**
 * 将标准化消息切成 topic-coherent segments。
 *
 * MVP 规则：
 * - thread_id 相同优先连续；
 * - 时间间隔超过 maxGapMs 切段；
 * - 标题/分隔线是边界；
 * - 与当前段关键词重合过低时切段；
 * - 每个 segment 保留 boundary_reasons，方便解释。
 */
export function segmentMessages(messages: NormalizedMessage[], options: SegmentOptions = {}): CandidateSegment[] {
  const maxGapMs = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const minTokenOverlap = options.minTokenOverlap ?? DEFAULT_MIN_TOKEN_OVERLAP;
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);

  const segments: CandidateSegment[] = [];
  let current: NormalizedMessage[] = [];
  let reasonsForCurrent: string[] = ["start"];

  const flush = () => {
    if (current.length === 0) return;
    segments.push(buildSegment(current, reasonsForCurrent));
    current = [];
    reasonsForCurrent = [];
  };

  for (const message of sorted) {
    if (isIgnorableMessage(message)) continue;

    if (current.length === 0) {
      current.push(message);
      if (reasonsForCurrent.length === 0) reasonsForCurrent.push("start");
      continue;
    }

    const last = current[current.length - 1];
    const boundary = shouldStartNewSegment(current, last, message, { maxGapMs, minTokenOverlap });
    if (boundary.startNew) {
      flush();
      reasonsForCurrent = boundary.reasons;
      current.push(message);
    } else {
      current.push(message);
    }
  }
  flush();

  return mergeTinyHeadingSegments(segments);
}

function shouldStartNewSegment(
  current: NormalizedMessage[],
  last: NormalizedMessage,
  next: NormalizedMessage,
  options: Required<SegmentOptions>,
): { startNew: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (isHeading(next)) reasons.push("heading_boundary");
  if (isSeparator(next)) reasons.push("separator_boundary");

  const gap = next.timestamp - last.timestamp;
  if (gap > options.maxGapMs) reasons.push("time_gap");

  if (last.thread_id && next.thread_id && last.thread_id === next.thread_id) {
    return { startNew: false, reasons: [] };
  }

  const overlap = tokenOverlap(segmentText(current), next.text);
  if (overlap < options.minTokenOverlap && current.length >= 2 && hasEnoughTopicTokens(next.text)) {
    reasons.push("topic_shift");
  }

  return { startNew: reasons.length > 0, reasons };
}

function buildSegment(messages: NormalizedMessage[], boundary_reasons: string[]): CandidateSegment {
  const text = segmentText(messages);
  return {
    id: `seg_${messages[0].id.replace(/^msg_/, "")}_${messages.length}`,
    messages,
    topic_hint: inferTopicHint(text),
    start_time: messages[0].timestamp,
    end_time: messages[messages.length - 1].timestamp,
    boundary_reasons,
    source: messages[0].source,
  };
}

function mergeTinyHeadingSegments(segments: CandidateSegment[]): CandidateSegment[] {
  const merged: CandidateSegment[] = [];
  for (const segment of segments) {
    const onlyHeading = segment.messages.length === 1 && isHeading(segment.messages[0]);
    if (onlyHeading) {
      const nextIndex = segments.indexOf(segment) + 1;
      const next = segments[nextIndex];
      if (next) {
        next.messages.unshift(segment.messages[0]);
        next.start_time = segment.start_time;
        next.boundary_reasons = [...new Set([...segment.boundary_reasons, ...next.boundary_reasons, "heading_attached"])] ;
        continue;
      }
    }
    merged.push(segment);
  }
  return merged;
}

function segmentText(messages: NormalizedMessage[]): string {
  return messages.map((message) => message.text).join("\n");
}

function isHeading(message: NormalizedMessage): boolean {
  return /^#{1,6}\s+/.test(message.text.trim());
}

function isSeparator(message: NormalizedMessage): boolean {
  return /^---+$/.test(message.text.trim());
}

function isIgnorableMessage(message: NormalizedMessage): boolean {
  const text = message.text.trim();
  return text === "" || /^---+$/.test(text);
}

function inferTopicHint(text: string): string {
  if (/PostgreSQL|MongoDB|SQLite|数据库|JSONL/.test(text)) return "database_or_storage";
  if (/周报|Alice|Bob|接收人/.test(text)) return "weekly_report_rule";
  if (/API Key|密钥|生产环境|前端直连/.test(text)) return "api_key_risk";
  if (/预览|pdf|中文乱码|独立ip|测试平台/.test(text)) return "preview_test_issue";
  if (/Candidate Segment|候选片段|Conversation Segmentation|Salience/.test(text)) return "candidate_segment_pipeline";
  return topTokens(text).slice(0, 3).join("_") || "general";
}

function tokenOverlap(a: string, b: string): number {
  const aTokens = new Set(topTokens(a));
  const bTokens = new Set(topTokens(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let hit = 0;
  for (const token of bTokens) if (aTokens.has(token)) hit++;
  return hit / Math.min(aTokens.size, bTokens.size);
}

function hasEnoughTopicTokens(text: string): boolean {
  return topTokens(text).length >= 2;
}

function topTokens(text: string): string[] {
  const latin = text.match(/[A-Za-z0-9_+#.-]{2,}/g) ?? [];
  const cjk = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const cjkPieces = cjk.flatMap((part) => {
    if (part.length <= 4) return [part];
    const pieces: string[] = [];
    for (let i = 0; i < part.length - 1; i++) pieces.push(part.slice(i, i + 2));
    return pieces;
  });
  const stop = new Set(["这个", "那个", "现在", "就是", "可以", "还是", "一下", "确认", "我们", "你们", "项目"]);
  return [...new Set([...latin, ...cjkPieces].map((item) => item.toLowerCase()).filter((item) => !stop.has(item)))];
}
