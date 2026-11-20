/// <reference types="node" />
// Test-only: a D1Database over node:sqlite, so tests run the real SQL
// (recursive queries, ALTER TABLE, RETURNING) instead of a string-matching mock.
import { DatabaseSync } from 'node:sqlite';

export function sqliteD1(setupSql = ''): any {
  const db = new DatabaseSync(':memory:');
  if (setupSql) db.exec(setupSql);
  const plain = (r: any) => (r == null ? r : { ...r });
  const stmt = (sql: string, args: any[] = []): any => ({
    bind: (...a: any[]) => stmt(sql, a),
    first: async (col?: string) => {
      const r = plain(db.prepare(sql).get(...args));
      if (r === undefined) return null;
      return col ? r[col] : r;
    },
    all: async () => ({ results: db.prepare(sql).all(...args).map(plain), success: true }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: any[]) => {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    // For assertions.
    rows: (sql: string, ...args: any[]) => db.prepare(sql).all(...args).map(plain),
  };
}

/** The `files` table as it was before release W1 (no Trash or thumbnail columns). */
export const PRE_W1_FILES_SQL = `CREATE TABLE files (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, parentId TEXT NOT NULL DEFAULT 'root',
  type TEXT NOT NULL DEFAULT 'file', fileName TEXT NOT NULL, fileSize INTEGER DEFAULT 0,
  fileType TEXT, messages TEXT, encrypted INTEGER DEFAULT 0,
  encryptionMode TEXT DEFAULT 'off', uploadedAt TEXT NOT NULL, updatedAt TEXT
);
CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);`;
