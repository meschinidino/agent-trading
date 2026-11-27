import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";

export type DB = DatabaseSync;

export type JournalMode = "WAL" | "DELETE" | "TRUNCATE" | "PERSIST" | "MEMORY" | "OFF";
const JOURNAL_MODES: JournalMode[] = ["WAL", "DELETE", "TRUNCATE", "PERSIST", "MEMORY", "OFF"];

export function normalizeJournalMode(raw: string | undefined, fallback: JournalMode = "WAL"): JournalMode {
  const v = String(raw ?? "").trim().toUpperCase();
  return (JOURNAL_MODES as string[]).includes(v) ? (v as JournalMode) : fallback;
}

export class DbBusyError extends Error {
  readonly code = "DB_BUSY";
  constructor(path: string, busyTimeoutMs: number, cause: unknown) {
    super(`Database busy at ${path}: another connection held the write lock beyond busy_timeout=${busyTimeoutMs}ms. If a previous revision still runs, deactivate it and retry the boot.`);
    this.name = "DbBusyError";
    (this as any).cause = cause;
  }
}

export class DbCorruptError extends Error {
  readonly code = "DB_CORRUPT";
  constructor(path: string, size: number, cause: unknown) {
    // Data safety beats liveness: a non-empty file that fails to open is NEVER deleted here.
    // Crash with the original error so an operator decides; only 0-byte files are auto-recovered.
    super(`Database file at ${path} (${size} bytes) failed to open and was left untouched: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DbCorruptError";
    (this as any).cause = cause;
  }
}

function isBusy(e: any): boolean {
  const msg = String(e?.message ?? "");
  return e?.errcode === 5 || e?.errcode === 6 || /database is locked|database table is locked|locking protocol/i.test(msg);
}
function isNotDb(e: any): boolean {
  const msg = String(e?.message ?? "");
  return e?.errcode === 26 || /not a database|file is encrypted|malformed|corrupt/i.test(msg);
}

// DIN-25: on Azure Files (SMB) a second revision asking for WAL while the first still
// holds the WAL write lock fails with "locking protocol" (errcode 15/5). busy_timeout must
// be set BEFORE journal_mode so the overlap waits instead of crash-looping.
export function openDb(path: string, opts: { busyTimeoutMs?: number; journalMode?: JournalMode; timeoutMs?: number } = {}): DB {
  const busyTimeoutMs = Math.max(0, Math.floor(opts.busyTimeoutMs ?? opts.timeoutMs ?? config.sqliteBusyTimeoutMs));
  const journalMode = normalizeJournalMode(opts.journalMode ?? config.sqliteJournalMode);
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
    // Empty/invalid-seed recovery (AGEN-28): a pre-existing 0-byte file on SMB can make
    // node:sqlite fail at journal_mode=WAL and every failed boot recreates it empty.
    // A 0-byte file can never contain a table, so unlinking it loses no data.
    // NEVER unlink a non-empty file (see DbCorruptError above).
    if (existsSync(path) && statSync(path).size === 0) {
      console.warn(`[db] WARNING: removing 0-byte database file at ${path} (size=0) and recreating it cleanly. No data could exist in an empty file.`);
      unlinkSync(path);
    }
  }
  const attempt = (): DB => {
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
      db.exec(`PRAGMA journal_mode=${journalMode};`);
      db.exec(`PRAGMA foreign_keys=ON;`);
    } catch (e) {
      try { db.close(); } catch {}
      throw e;
    }
    return db;
  };
  let db: DB;
  try {
    db = attempt();
  } catch (e: any) {
    if (path !== ":memory:" && isNotDb(e)) {
      const size = existsSync(path) ? statSync(path).size : 0;
      if (size === 0) {
        // Defensive: file became/was 0-byte despite the pre-check above.
        console.warn(`[db] WARNING: removing 0-byte database file at ${path} (size=0) after open failure (${e.message}) and recreating it cleanly.`);
        try { unlinkSync(path); } catch {}
        db = attempt();
      } else {
        throw new DbCorruptError(path, size, e);
      }
    } else if (isBusy(e)) {
      // busy_timeout already waited inside SQLite; a still-busy DB is a typed, diagnosable
      // failure for the caller/process supervisor, not a silent retry loop in-process.
      throw new DbBusyError(path, busyTimeoutMs, e);
    } else throw e;
  }
  try {
    initSchema(db);
  } catch (e: any) {
    // journal_mode=WAL is a no-op when already in WAL, so lock contention from an
    // overlapping revision first surfaces here, at the schema write — busy_timeout has
    // already waited inside SQLite. Convert to the typed error instead of leaking a
    // raw "database is locked" (AGEN-31 crash-loop shape).
    try { db.close(); } catch {}
    if (isBusy(e)) throw new DbBusyError(path, busyTimeoutMs, e);
    throw e;
  }
  return db;
}

function initSchema(db: DB): void {
  // Fast path: CREATE TABLE IF NOT EXISTS on an existing table takes no write lock, so
  // when the schema is already complete (the overlapping-revision case) boot needs no
  // write lock at all and cannot collide with the old revision's WAL lock. Only a boot
  // that actually has to create/alter something takes the write path — and there
  // busy_timeout is what waits for the other revision to release.
  const existing = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as any[]).map((r) => r.name));
  const required = ["users","sessions","wallets","quotes","confirmations","orders","executions","paper_ledger","one_pending_per_user","audit_log","mcp_tokens"];
  const confCols = db.prepare("PRAGMA table_info(confirmations)").all() as any[];
  if (required.every((n) => existing.has(n)) && confCols.some((c) => c.name === "proposed_via")) return;
  // Idempotent by construction (IF NOT EXISTS everywhere + column-presence check), so a
  // retried boot after a partial/crashed init converges instead of compounding damage.
  db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,csrf_token TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wallets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,mode TEXT NOT NULL,solana_address TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,wallet_id TEXT NOT NULL,input_mint TEXT NOT NULL,output_mint TEXT NOT NULL,amount_in_atomic TEXT NOT NULL,quoted_out_atomic TEXT NOT NULL,min_out_atomic TEXT NOT NULL,slippage_bps INTEGER NOT NULL,price_impact_pct REAL NOT NULL,request_id TEXT,transaction_b64 TEXT,expires_at TEXT NOT NULL,consumed_at TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS confirmations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,wallet_id TEXT NOT NULL,quote_id TEXT UNIQUE NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,raw_intent TEXT NOT NULL,llm_summary TEXT,input_mint TEXT NOT NULL,output_mint TEXT NOT NULL,symbol TEXT NOT NULL,side TEXT NOT NULL DEFAULT 'buy',amount_in_atomic TEXT NOT NULL,quoted_out_atomic TEXT NOT NULL,min_out_atomic TEXT NOT NULL,slippage_bps INTEGER NOT NULL,price_impact_pct REAL NOT NULL,error_code TEXT,prev_hash TEXT,record_hash TEXT,lease_expires_at TEXT,created_at TEXT NOT NULL,presented_at TEXT,decided_at TEXT,decided_by TEXT,executed_at TEXT,expires_at TEXT);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,confirmation_id TEXT UNIQUE NOT NULL,provider TEXT NOT NULL,provider_request_id TEXT,signature_intent TEXT,route_snapshot TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,mode TEXT NOT NULL,tx_signature TEXT,slot INTEGER,fee_lamports INTEGER,actual_out_atomic TEXT,error_detail TEXT,simulation_json TEXT,simulation_mode TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS paper_ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,wallet_id TEXT NOT NULL,kind TEXT NOT NULL,symbol TEXT,mint TEXT,amount_atomic TEXT NOT NULL,amount_usd REAL,confirmation_id TEXT UNIQUE,simulation_ref TEXT,created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_per_user ON confirmations(user_id) WHERE status IN ('proposed','pending_confirmation');
CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY,confirmation_id TEXT,user_id TEXT,event TEXT NOT NULL,payload TEXT,prev_hash TEXT NOT NULL,record_hash TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,scopes TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,last_used_at TEXT,revoked_at TEXT);
`);
  const cols2 = db.prepare("PRAGMA table_info(confirmations)").all() as any[];
  if (!cols2.some((c) => c.name === "proposed_via")) db.exec("ALTER TABLE confirmations ADD COLUMN proposed_via TEXT");
}
export const nowIso = () => new Date().toISOString();
export const id = () => randomUUID();
export function hashRecord(prev: string, data: string) { return createHash("sha256").update(prev + "|" + data).digest("hex"); }
export function appendAudit(db: DB, confirmationId: string | null, userId: string | null, event: string, payload: unknown) {
  const last = db.prepare("SELECT record_hash FROM audit_log ORDER BY rowid DESC LIMIT 1").get() as any;
  const prev = last?.record_hash || "GENESIS";
  const created = nowIso(); const body = JSON.stringify({ confirmationId, userId, event, payload, created });
  const rec = hashRecord(prev, body);
  db.prepare("INSERT INTO audit_log(id,confirmation_id,user_id,event,payload,prev_hash,record_hash,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id(), confirmationId, userId, event, JSON.stringify(payload ?? {}), prev, rec, created);
  return rec;
}
export function verifyAuditChain(db: DB): boolean {
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY rowid ASC").all() as any[];
  let prev = "GENESIS";
  for (const r of rows) { if (r.prev_hash !== prev) return false; const body = JSON.stringify({ confirmationId: r.confirmation_id, userId: r.user_id, event: r.event, payload: JSON.parse(r.payload), created: r.created_at }); if (hashRecord(prev, body) !== r.record_hash) return false; prev = r.record_hash; }
  return true;
}
