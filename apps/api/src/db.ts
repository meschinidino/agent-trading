import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type DB = DatabaseSync;
export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
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
`);
  return db;
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
