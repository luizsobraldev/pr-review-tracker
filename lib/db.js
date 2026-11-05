// Camada de banco com uma única API para os dois motores:
// - SQLite embutido no Node (padrão local, sem dependências);
// - Postgres serverless (Neon) quando DATABASE_URL/POSTGRES_URL existe — usado na Vercel.
// As queries da aplicação usam placeholders $1, $2… e só SQL comum aos dois motores.
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const SCHEMA_VERSION = '1';

const SQLITE_DDL = [
  `CREATE TABLE IF NOT EXISTS members (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     name       TEXT NOT NULL,
     active     INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   )`,
  `CREATE TABLE IF NOT EXISTS reviews (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     day        TEXT NOT NULL,
     pr         TEXT NOT NULL,
     link       TEXT,
     status     TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
     member_id  INTEGER NOT NULL REFERENCES members(id),
     note       TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS days (
     day       TEXT PRIMARY KEY,
     pending   INTEGER,
     note      TEXT,
     closed_at TEXT,
     closed_by INTEGER REFERENCES members(id)
   )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
];

const PG_DDL = [
  `CREATE TABLE IF NOT EXISTS members (
     id         SERIAL PRIMARY KEY,
     name       TEXT NOT NULL,
     active     INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS reviews (
     id         SERIAL PRIMARY KEY,
     day        TEXT NOT NULL,
     pr         TEXT NOT NULL,
     link       TEXT,
     status     TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
     member_id  INTEGER NOT NULL REFERENCES members(id),
     note       TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS days (
     day       TEXT PRIMARY KEY,
     pending   INTEGER,
     note      TEXT,
     closed_at TEXT,
     closed_by INTEGER REFERENCES members(id)
   )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
];

const COMMON_DDL = [
  `CREATE UNIQUE INDEX IF NOT EXISTS members_name_ci ON members (lower(name))`,
  `CREATE INDEX IF NOT EXISTS reviews_day ON reviews (day)`,
  `CREATE INDEX IF NOT EXISTS reviews_pr_ci ON reviews (lower(pr))`,
  `INSERT INTO settings (key, value) VALUES ('team_name', 'Equipe QA') ON CONFLICT (key) DO NOTHING`,
];

async function migrate(db, ddl) {
  try {
    const row = await db.get(`SELECT value FROM settings WHERE key = 'schema_version'`);
    if (row?.value === SCHEMA_VERSION) return;
  } catch { /* tabela ainda não existe */ }
  for (const stmt of [...ddl, ...COMMON_DDL]) await db.run(stmt);
  await db.run(
    `INSERT INTO settings (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [SCHEMA_VERSION],
  );
}

function postgres(query, label) {
  let ready;
  const db = {
    kind: 'postgres',
    label,
    all: (sql, params = []) => query(sql, params),
    get: async (sql, params = []) => (await query(sql, params))[0],
    run: (sql, params = []) => query(sql, params),
    init: () => (ready ||= migrate(db, PG_DDL).catch((e) => { ready = null; throw e; })),
    close() {},
  };
  return db;
}

async function sqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const cache = new Map();
  const prep = (sql) => {
    const text = sql.replace(/\$(\d+)/g, '?$1');
    let stmt = cache.get(text);
    if (!stmt) { stmt = raw.prepare(text); cache.set(text, stmt); }
    return stmt;
  };
  const db = {
    kind: 'sqlite',
    label: file,
    all: async (sql, params = []) => prep(sql).all(...params),
    get: async (sql, params = []) => prep(sql).get(...params),
    run: async (sql, params = []) => prep(sql).all(...params),
    init: () => migrate(db, SQLITE_DDL),
    close: () => raw.close(),
  };
  return db;
}

/**
 * Abre o banco.
 * - `query`: função (sql, params) => rows — injeta um Postgres (usado em testes).
 * - `url`: string de conexão Postgres; padrão DATABASE_URL / POSTGRES_URL.
 * - `file`: caminho do SQLite quando não há URL.
 */
export async function openDb({ query, url = process.env.DATABASE_URL || process.env.POSTGRES_URL, file } = {}) {
  if (query) return postgres(query, 'postgres');
  if (url) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    return postgres((text, params) => sql.query(text, params), 'Postgres (Neon)');
  }
  if (!file) throw new Error('Informe DATABASE_URL (Postgres) ou um arquivo SQLite.');
  return sqlite(file);
}
