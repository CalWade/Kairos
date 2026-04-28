import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ConflictRelation, MemoryAtom } from "./atom.js";
import { MemoryAtomSchema } from "./schema.js";
import { EventLog } from "./eventLog.js";
import { makeMemoryId } from "./id.js";

export type SearchOptions = {
  project?: string;
  type?: string;
  scope?: string;
  includeHistory?: boolean;
  limit?: number;
};

export type ReminderOptions = {
  project?: string;
  type?: string;
  now?: string;
  limit?: number;
};

export class MemoryStore {
  private readonly db: Database.Database;
  private readonly eventLog: EventLog;

  constructor(dbPath = "data/memory.db", eventLogPath = "data/memory_events.jsonl") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.eventLog = new EventLog(eventLogPath);
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        project TEXT,
        layer TEXT NOT NULL,
        formation TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        valid_at TEXT NOT NULL,
        invalid_at TEXT,
        expired_at TEXT,
        decay_policy TEXT NOT NULL,
        review_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        atom_json TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        subject,
        content,
        tags,
        tokenize = 'unicode61'
      );
    `);
  }

  private writeAtom(atom: MemoryAtom) {
    const parsed = MemoryAtomSchema.parse(atom);
    const tags = parsed.tags.join(" ");
    this.db.prepare(`
      INSERT INTO memories (
        id, type, scope, project, layer, formation, subject, content, status,
        confidence, importance, created_at, observed_at, valid_at, invalid_at,
        expired_at, decay_policy, review_at, access_count, last_accessed_at, atom_json
      ) VALUES (
        @id, @type, @scope, @project, @layer, @formation, @subject, @content, @status,
        @confidence, @importance, @created_at, @observed_at, @valid_at, @invalid_at,
        @expired_at, @decay_policy, @review_at, @access_count, @last_accessed_at, @atom_json
      )
      ON CONFLICT(id) DO UPDATE SET
        type=excluded.type,
        scope=excluded.scope,
        project=excluded.project,
        layer=excluded.layer,
        formation=excluded.formation,
        subject=excluded.subject,
        content=excluded.content,
        status=excluded.status,
        confidence=excluded.confidence,
        importance=excluded.importance,
        created_at=excluded.created_at,
        observed_at=excluded.observed_at,
        valid_at=excluded.valid_at,
        invalid_at=excluded.invalid_at,
        expired_at=excluded.expired_at,
        decay_policy=excluded.decay_policy,
        review_at=excluded.review_at,
        access_count=excluded.access_count,
        last_accessed_at=excluded.last_accessed_at,
        atom_json=excluded.atom_json
    `).run({
      ...parsed,
      project: parsed.project ?? null,
      invalid_at: parsed.invalid_at ?? null,
      expired_at: parsed.expired_at ?? null,
      review_at: parsed.review_at ?? null,
      last_accessed_at: parsed.last_accessed_at ?? null,
      atom_json: JSON.stringify(parsed),
    });

    this.db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(parsed.id);
    this.db.prepare(`INSERT INTO memories_fts(id, subject, content, tags) VALUES (?, ?, ?, ?)`)
      .run(parsed.id, parsed.subject, parsed.content, tags);
    return parsed;
  }

  upsert(atom: MemoryAtom) {
    const parsed = this.db.transaction(() => this.writeAtom(atom))();
    this.eventLog.append({
      event_id: makeMemoryId(`${parsed.id}|ADD|${new Date().toISOString()}`),
      action: parsed.action ?? "ADD",
      atom_id: parsed.id,
      at: new Date().toISOString(),
      atom: parsed,
    });
    return parsed;
  }

  supersede(oldId: string, newAtom: MemoryAtom, relation: ConflictRelation = "DIRECT_CONFLICT") {
    const oldAtom = this.get(oldId);
    if (!oldAtom) throw new Error(`旧记忆不存在：${oldId}`);
    const now = new Date().toISOString();
    const validAt = newAtom.valid_at ?? now;
    const updatedOld: MemoryAtom = {
      ...oldAtom,
      status: "superseded",
      invalid_at: oldAtom.invalid_at ?? validAt,
      expired_at: now,
      superseded_by: newAtom.id,
      conflict_relation: relation,
    };
    const updatedNew: MemoryAtom = {
      ...newAtom,
      status: "active",
      action: "SUPERSEDE",
      supersedes: [...new Set([...(newAtom.supersedes ?? []), oldId])],
      conflict_relation: relation,
    };
    const result = this.db.transaction(() => {
      const oldSaved = this.writeAtom(updatedOld);
      const newSaved = this.writeAtom(updatedNew);
      return { old: oldSaved, current: newSaved };
    })();
    this.eventLog.append({
      event_id: makeMemoryId(`${oldId}|SUPERSEDE|${updatedNew.id}|${now}`),
      action: "SUPERSEDE",
      atom_id: updatedNew.id,
      target_id: oldId,
      at: now,
      atom: updatedNew,
      reason: relation,
    });
    return result;
  }

  findConflictCandidates(atom: MemoryAtom, limit = 5): MemoryAtom[] {
    const candidates = this.search(atom.subject || atom.content, {
      project: atom.project,
      type: atom.type,
      scope: atom.scope,
      limit: Math.max(limit, 10),
    }).filter((item) => item.id !== atom.id && item.status === "active");

    if (candidates.length > 0) return candidates.slice(0, limit);

    return this.list({
      project: atom.project,
      type: atom.type,
      scope: atom.scope,
      limit: 100,
    })
      .filter((item) => item.id !== atom.id && item.status === "active")
      .map((item) => ({ item, score: overlapScore(atom, item) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ item }) => item);
  }

  get(id: string): MemoryAtom | undefined {
    const row = this.db.prepare(`SELECT atom_json FROM memories WHERE id = ?`).get(id) as { atom_json: string } | undefined;
    if (!row) return undefined;
    return MemoryAtomSchema.parse(JSON.parse(row.atom_json));
  }

  list(options: SearchOptions = {}): MemoryAtom[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (!options.includeHistory) where.push(`status = 'active'`);
    if (options.project) { where.push(`project = @project`); params.project = options.project; }
    if (options.type) { where.push(`type = @type`); params.type = options.type; }
    if (options.scope) { where.push(`scope = @scope`); params.scope = options.scope; }
    const sql = `SELECT atom_json FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY importance DESC, valid_at DESC LIMIT @limit`;
    const rows = this.db.prepare(sql).all({ ...params, limit: options.limit ?? 20 }) as { atom_json: string }[];
    return rows.map((row) => MemoryAtomSchema.parse(JSON.parse(row.atom_json)));
  }

  ackReminder(id: string, options: { now?: string } = {}): MemoryAtom {
    const atom = this.get(id);
    if (!atom) throw new Error(`记忆不存在：${id}`);
    const now = options.now ?? new Date().toISOString();
    const updated: MemoryAtom = {
      ...atom,
      review_at: undefined,
      metadata: {
        ...(atom.metadata ?? {}),
        reminder_state: "acked",
        reminder_acked_at: now,
      },
    };
    const saved = this.db.transaction(() => this.writeAtom(updated))();
    this.eventLog.append({
      event_id: makeMemoryId(`${id}|REMINDER_ACK|${now}`),
      action: "UPDATE",
      atom_id: id,
      at: now,
      atom: saved,
      reason: "REMINDER_ACK",
    });
    return saved;
  }

  snoozeReminder(id: string, until: string, options: { now?: string } = {}): MemoryAtom {
    const atom = this.get(id);
    if (!atom) throw new Error(`记忆不存在：${id}`);
    const now = options.now ?? new Date().toISOString();
    const updated: MemoryAtom = {
      ...atom,
      review_at: until,
      metadata: {
        ...(atom.metadata ?? {}),
        reminder_state: "snoozed",
        reminder_snoozed_at: now,
        reminder_snoozed_until: until,
      },
    };
    const saved = this.db.transaction(() => this.writeAtom(updated))();
    this.eventLog.append({
      event_id: makeMemoryId(`${id}|REMINDER_SNOOZE|${until}|${now}`),
      action: "UPDATE",
      atom_id: id,
      at: now,
      atom: saved,
      reason: `REMINDER_SNOOZE:${until}`,
    });
    return saved;
  }

  dueReminders(options: ReminderOptions = {}): MemoryAtom[] {
    const filters = [`status = 'active'`, `review_at IS NOT NULL`, `review_at <= @now`];
    const params: Record<string, unknown> = {
      now: options.now ?? new Date().toISOString(),
      limit: options.limit ?? 20,
    };
    if (options.project) { filters.push(`project = @project`); params.project = options.project; }
    if (options.type) { filters.push(`type = @type`); params.type = options.type; }
    const rows = this.db.prepare(`
      SELECT atom_json FROM memories
      WHERE ${filters.join(" AND ")}
      ORDER BY review_at ASC, importance DESC, valid_at DESC
      LIMIT @limit
    `).all(params) as { atom_json: string }[];
    return rows.map((row) => MemoryAtomSchema.parse(JSON.parse(row.atom_json)));
  }

  search(query: string, options: SearchOptions = {}): MemoryAtom[] {
    const limit = options.limit ?? 10;
    const filters: string[] = [];
    const params: Record<string, unknown> = { query, limit };
    if (!options.includeHistory) filters.push(`m.status = 'active'`);
    if (options.project) { filters.push(`m.project = @project`); params.project = options.project; }
    if (options.type) { filters.push(`m.type = @type`); params.type = options.type; }
    if (options.scope) { filters.push(`m.scope = @scope`); params.scope = options.scope; }

    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT m.atom_json
      FROM memories_fts f
      JOIN memories m ON m.id = f.id
      WHERE memories_fts MATCH @query
      ${where}
      ORDER BY bm25(memories_fts), m.importance DESC, m.valid_at DESC
      LIMIT @limit
    `).all(params) as { atom_json: string }[];

    // FTS 对中文分词并不完美，若无结果则退化为 LIKE + token scoring。
    if (rows.length === 0) {
      const likeRows = this.db.prepare(`
        SELECT atom_json FROM memories m
        WHERE (m.content LIKE @like OR m.subject LIKE @like)
        ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
        ORDER BY m.importance DESC, m.valid_at DESC
        LIMIT @limit
      `).all({ ...params, like: `%${query}%` }) as { atom_json: string }[];
      if (likeRows.length > 0) {
        return likeRows.map((row) => MemoryAtomSchema.parse(JSON.parse(row.atom_json)));
      }

      // 最后一层兜底：从问句中抽取英文/数字 token 和中文片段，做轻量包含匹配。
      // 例如“我们为什么不用 MongoDB？”应能通过 MongoDB 命中“决定不使用 MongoDB”。
      const candidateRows = this.db.prepare(`
        SELECT atom_json FROM memories m
        WHERE 1 = 1
        ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
        LIMIT 200
      `).all(params) as { atom_json: string }[];
      const tokens = extractQueryTokens(query);
      return candidateRows
        .map((row) => MemoryAtomSchema.parse(JSON.parse(row.atom_json)))
        .map((atom) => ({ atom, score: scoreByTokens(atom, tokens) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.atom.importance - a.atom.importance)
        .slice(0, limit)
        .map((item) => item.atom);
    }

    return rows.map((row) => MemoryAtomSchema.parse(JSON.parse(row.atom_json)));
  }
}

function extractQueryTokens(query: string): string[] {
  const latin = query.match(/[A-Za-z0-9_+#.-]{2,}/g) ?? [];
  const cjk = query.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const cjkPieces = cjk.flatMap((part) => {
    if (part.length <= 4) return [part];
    const pieces: string[] = [];
    for (let i = 0; i < part.length - 1; i++) pieces.push(part.slice(i, i + 2));
    return pieces;
  });
  return [...new Set([...latin, ...cjkPieces].map((item) => item.toLowerCase()))];
}

function scoreByTokens(atom: MemoryAtom, tokens: string[]): number {
  const haystack = `${atom.subject} ${atom.content} ${atom.tags.join(" ")}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length >= 4 ? 2 : 1;
  }
  return score + atom.confidence + atom.importance / 10;
}

function overlapScore(a: MemoryAtom, b: MemoryAtom): number {
  const aTokens = new Set(extractQueryTokens(`${a.subject} ${a.content}`));
  const bText = `${b.subject} ${b.content}`.toLowerCase();
  let score = 0;
  for (const token of aTokens) {
    if (bText.includes(token)) score += token.length >= 4 ? 2 : 1;
  }
  return score;
}
