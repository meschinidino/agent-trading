import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
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
  constructor(path: string, busyTimeoutMs: number, cause: unknown, budgetMs?: number) {
    super(`Database busy at ${path}: another connection held the write lock beyond ${budgetMs != null ? `the ${budgetMs}ms boot retry budget (busy_timeout=${busyTimeoutMs}ms per attempt)` : `busy_timeout=${busyTimeoutMs}ms`}. If a previous revision still runs, deactivate it and retry the boot.`);
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

const sleepState = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  const t = Math.max(0, Math.floor(ms));
  if (t > 0) Atomics.wait(sleepState, 0, 0, t);
}

// DIN-30: an EXISTING database (at least one table) already has a journal mode, recorded
// in byte 18/19 of its file header (2 = WAL, 1 = rollback). Forcing a switch on it at
// boot is what broke prod: against a live WAL connection (the old 0.5.0 revision, or its
// -wal/-shm sidecars on the SMB share), "PRAGMA journal_mode=DELETE" fails with errcode 5
// ("database is locked") instantly even under busy_timeout, because the switch needs an
// EXCLUSIVE lock -- while a plain read on the same connection succeeds (reproduced
// locally against both a live WAL connection and a BEGIN EXCLUSIVE holder). So:
//   - existing DB (>= 1 table): open WITHOUT forcing journal_mode; log the detected mode.
//   - new DB (no file, 0 bytes, or no tables yet): apply the configured mode
//     (SQLITE_JOURNAL_MODE, default DELETE -- see config.ts).
// busy_timeout is always set first. "Existing" is decided by the file header alone: a
// WAL database keeps its newest pages in the -wal sidecar, which only a real connection
// sees merged -- recovering that state just to classify the file would demand exactly
// the locks this function exists to avoid.
function headerJournalMode(path: string): string | null {
  try {
    const head = readFileSync(path).subarray(0, 20);
    if (head.length < 20) return null;
    return head[18] === 2 ? "wal" : head[18] === 1 ? "delete" : null;
  } catch { return null; }
}

export function openDb(path: string, opts: { busyTimeoutMs?: number; journalMode?: JournalMode; timeoutMs?: number; busyBudgetMs?: number } = {}): DB {
  const busyTimeoutMs = Math.max(0, Math.floor(opts.busyTimeoutMs ?? opts.timeoutMs ?? config.sqliteBusyTimeoutMs));
  const budgetMs = Math.max(0, Math.floor(opts.busyBudgetMs ?? (config as any).sqliteBootBudgetMs ?? 30000));
  const journalMode = normalizeJournalMode(opts.journalMode ?? config.sqliteJournalMode, "DELETE");
  const isMemory = path === ":memory:";
  if (!isMemory) {
    mkdirSync(dirname(path), { recursive: true });
    // Empty/invalid-seed recovery (AGEN-28): a pre-existing 0-byte file can never contain
    // a table, so unlinking it loses no data. NEVER unlink a non-empty file (see
    // DbCorruptError above) and never touch -wal/-shm sidecars.
    if (existsSync(path) && statSync(path).size === 0) {
      console.warn(`[db] WARNING: removing 0-byte database file at ${path} (size=0) and recreating it cleanly. No data could exist in an empty file.`);
      unlinkSync(path);
    }
  }
  const headerMode = isMemory ? null : headerJournalMode(path);
  const isExisting = headerMode !== null;

  const attempt = (): DB => {
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
      if (isExisting) {
        // Existing DB: never force a journal_mode switch (DIN-30, see note above).
        // Confirm the live mode and log it; a read-only pragma needs no exclusive lock.
        const row = db.prepare("PRAGMA journal_mode").get() as any;
        const detected = String(row?.journal_mode ?? headerMode ?? "unknown").toLowerCase();
        console.log(`[db] existing database at ${path}: respecting journal_mode=${detected} (configured SQLITE_JOURNAL_MODE=${journalMode} applies only to new databases)`);
      } else {
        db.exec(`PRAGMA journal_mode=${journalMode};`);
      }
      db.exec("PRAGMA foreign_keys=ON;");
    } catch (e) { try { db.close(); } catch {} throw e; }
    return db;
  };

  const startedAt = Date.now();
  let lastBusy: unknown = null;
  // Bounded, jittered retry around the whole open+init sequence: a stale SMB lock or a
  // dying old revision can outlive one busy_timeout window (AGEN-34: locked >3 min while
  // the new revision was ALONE on the share). DIN-25 deliberately had no in-process retry;
  // DIN-30 reverses that within a ~30s budget sized to ride out a revision transition --
  // the container has no earlier readiness signal: the process only listens after openDb
  // returns (src/index.ts), so retries inside openDb are the readiness budget.
  // init/migrations are idempotent, so re-running them after a partial attempt converges.
  for (let attemptNo = 1; ; attemptNo++) {
    try {
      const db = attempt();
      try { initSchema(db); return db; }
      catch (e) { try { db.close(); } catch {} throw e; }
    } catch (e: any) {
      if (!isMemory && isNotDb(e)) {
        const size = existsSync(path) ? statSync(path).size : 0;
        if (size === 0) {
          // Defensive: file became/was 0-byte despite the pre-check above.
          console.warn(`[db] WARNING: removing 0-byte database file at ${path} (size=0) after open failure (${e.message}) and recreating it cleanly.`);
          try { unlinkSync(path); } catch {}
          continue;
        }
        throw new DbCorruptError(path, size, e);
      }
      if (isBusy(e)) {
        lastBusy = e;
        const elapsed = Date.now() - startedAt;
        if (elapsed >= budgetMs) throw new DbBusyError(path, busyTimeoutMs, lastBusy, budgetMs);
        const cap = Math.min(250 * 2 ** (attemptNo - 1), 2000);
        const delay = cap / 2 + Math.random() * (cap / 2);
        console.warn(`[db] database busy at ${path} (attempt ${attemptNo}, elapsed ${elapsed}ms); retrying in ${Math.round(delay)}ms within the ${budgetMs}ms boot budget`);
        sleepSync(Math.min(delay, budgetMs - elapsed));
        continue;
      }
      throw e;
    }
  }
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
