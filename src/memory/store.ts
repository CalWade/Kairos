import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryAtom } from "./atom.js";
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

  upsert(atom: MemoryAtom) {
    const parsed = MemoryAtomSchema.parse(atom);
    const tags = parsed.tags.join(" ");
    const tx = this.db.transaction(() => {
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
    });
    tx();

    this.eventLog.append({
      event_id: makeMemoryId(`${parsed.id}|ADD|${new Date().toISOString()}`),
      action: parsed.action ?? "ADD",
      atom_id: parsed.id,
      at: new Date().toISOString(),
      atom: parsed,
    });

    return parsed;
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

    // FTS 对中文分词并不完美，若无结果则退化为 LIKE。
    if (rows.length === 0) {
      const likeRows = this.db.prepare(`
        SELECT atom_json FROM memories m
        WHERE (m.content LIKE @like OR m.subject LIKE @like)
        ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
        ORDER BY m.importance DESC, m.valid_at DESC
        LIMIT @limit
      `).all({ ...params, like: `%${query}%` }) as { atom_json: string }[];
      return likeRows.map((row) => MemoryAtomSchema.parse(JSON.parse(row.atom_json)));
    }

    return rows.map((row) => MemoryAtomSchema.parse(JSON.parse(row.atom_json)));
  }
}
