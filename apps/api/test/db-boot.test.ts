import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
// @ts-ignore TS types may not cover this export under all configs; runtime export exists.
import { openDb, DbBusyError, DbCorruptError, nowIso, id } from "../src/db.js";

const dirs: string[] = [];
function tmpDb(name = "app.sqlite") {
  const dir = mkdtempSync(join(tmpdir(), "onda-db-boot-"));
  dirs.push(dir);
  return join(dir, name);
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("openDb boot robustness (DIN-30)", () => {
  it("opens an existing WAL DB with live -wal/-shm sidecars: reads rows, keeps WAL, does not crash (refs DIN-30)", async () => {
    const path = tmpDb();
    // Seed a WAL database the 0.5.0 way and hold a second "old revision" connection
    // open with an un-checkpointed write, so -wal/-shm stay live at the new boot.
    const seed = openDb(path, { journalMode: "WAL" });
    const uid = id();
    seed.prepare("INSERT INTO users VALUES(?,?,?,?)").run(uid, "wal@ex.com", "hash", nowIso());
    seed.close();
    const { spawn } = await import("node:child_process");
    const { writeFileSync: wf } = await import("node:fs");
    const script = join(path, "..", "holder-wal.cjs");
    wf(script, `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[2]); db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"); db.prepare("INSERT INTO users VALUES(?,?,?,?)").run("holder-old","oldrev@ex.com","h",new Date().toISOString()); console.log("ready"); setTimeout(()=>{ db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); db.close(); process.exit(0); }, 4000);`);
    const child = spawn(process.execPath, [script, path], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error("holder did not become ready")), 5000); child.stdout.on("data", (d) => { if (String(d).includes("ready")) { clearTimeout(t); resolve(); } }); });
    expect(existsSync(path + "-wal")).toBe(true);
    expect(existsSync(path + "-shm")).toBe(true);
    // The 0.5.2 boot (default DELETE) must open this DB WITHOUT forcing a mode switch,
    // even while the old revision's connection is live with un-checkpointed pages.
    const started = Date.now();
    const db = openDb(path, { journalMode: "DELETE", busyTimeoutMs: 500 });
    try {
      expect(Date.now() - started).toBeLessThan(3000); // no waiting on an exclusive lock
      expect(String((db.prepare("PRAGMA journal_mode").get() as any).journal_mode).toLowerCase()).toBe("wal");
      expect((db.prepare("SELECT email FROM users WHERE id=?").get(uid) as any)?.email).toBe("wal@ex.com");
      expect((db.prepare("SELECT email FROM users WHERE id='holder-old'").get() as any)?.email).toBe("oldrev@ex.com");
      // Rows written by the new boot land in the -wal too, not in a forced rollback journal.
      db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(id(), "newboot@ex.com", "hash", nowIso());
    } finally { db.close(); }
    await new Promise((r) => child.on("exit", r));
    // A later boot still sees everything (nothing was truncated or switched away).
    const again = openDb(path, { journalMode: "DELETE", busyTimeoutMs: 500 });
    try {
      expect((again.prepare("SELECT count(*) c FROM users").get() as any).c).toBe(3);
      expect(String((again.prepare("PRAGMA journal_mode").get() as any).journal_mode).toLowerCase()).toBe("wal");
    } finally { again.close(); }
  });

  it("brand-new DB is created with the configured journal mode (SQLITE_JOURNAL_MODE path)", () => {
    const p1 = tmpDb();
    const a = openDb(p1, { journalMode: "DELETE" });
    try { expect(String((a.prepare("PRAGMA journal_mode").get() as any).journal_mode).toLowerCase()).toBe("delete"); } finally { a.close(); }
    const p2 = tmpDb();
    const b = openDb(p2, { journalMode: "WAL" });
    try { expect(String((b.prepare("PRAGMA journal_mode").get() as any).journal_mode).toLowerCase()).toBe("wal"); } finally { b.close(); }
  });

  it("boot survives a lock held beyond one busy_timeout window but within the boot budget", async () => {
    const path = tmpDb();
    // Seeded WITHOUT openDb (no complete schema): the schema write in init is the
    // contention point, same shape as the DIN-25 overlap test.
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA journal_mode=WAL;");
    raw.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);");
    raw.close();
    const { spawn } = await import("node:child_process");
    const { writeFileSync: wf } = await import("node:fs");
    const script = join(path, "..", "holder-slow.cjs");
    // Holder keeps BEGIN EXCLUSIVE for ~2200ms: longer than one busy_timeout=500 window,
    // well within the 8000ms boot budget.
    wf(script, `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[2]); db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN EXCLUSIVE;"); db.prepare("INSERT INTO users VALUES(?,?,?,?)").run("slow-1","slow@ex.com","h",new Date().toISOString()); console.log("ready"); setTimeout(()=>{ db.exec("COMMIT"); db.close(); process.exit(0); }, 2200);`);
    const child = spawn(process.execPath, [script, path], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error("holder did not become ready")), 5000); child.stdout.on("data", (d) => { if (String(d).includes("ready")) { clearTimeout(t); resolve(); } }); });
    const started = Date.now();
    const db = openDb(path, { journalMode: "WAL", busyTimeoutMs: 500, busyBudgetMs: 8000 });
    const elapsed = Date.now() - started;
    try {
      // It outlived at least one full busy_timeout window: the retry loop carried it.
      expect(elapsed).toBeGreaterThanOrEqual(500);
      expect(elapsed).toBeLessThan(8000);
      expect((db.prepare("SELECT email FROM users WHERE id='slow-1'").get() as any)?.email).toBe("slow@ex.com");
      // Schema init completed after the lock released (idempotent under retries).
      expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as any)?.name).toBe("sessions");
    } finally { db.close(); }
    await new Promise((r) => child.on("exit", r));
  });
});

describe("openDb boot robustness (DIN-25)", () => {
  it("boots with a pre-existing 0-byte DB file, creates schema, and logs a warning", () => {
    const path = tmpDb();
    writeFileSync(path, "");
    expect(statSync(path).size).toBe(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = openDb(path, { journalMode: "DELETE", busyTimeoutMs: 500 });
    try {
      const mode = db.prepare("PRAGMA journal_mode").get() as any;
      expect(String(mode.journal_mode).toLowerCase()).toBe("delete");
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
      expect(tables.map((t) => t.name)).toContain("users");
      expect(statSync(path).size).toBeGreaterThan(0);
      expect(warn.mock.calls.flat().join(" ")).toMatch(/0-byte.*app\.sqlite|WARNING.*0-byte/);
      expect(warn.mock.calls.flat().join(" ")).toContain("size=0");
    } finally { db.close(); }
  });

  it("reopens a valid existing DB with rows untouched (no unlink/recreate)", () => {
    const path = tmpDb();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const uid = id();
    let db = openDb(path, { journalMode: "DELETE" });
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(uid, "boot@ex.com", "hash", nowIso());
    const sizeBefore = statSync(path).size;
    expect(sizeBefore).toBeGreaterThan(0);
    db.close();
    // Exercise the journal_mode pragma on a closed connection first, so the check
    // below runs against a checkpointed file (early-returning test).
    const jc = new DatabaseSync(path);
    expect(String((jc.prepare("PRAGMA journal_mode").get() as any).journal_mode).toLowerCase()).toBe("delete");
    jc.close();
    db = openDb(path, { journalMode: "DELETE" });
    try {
      expect(String((db.prepare("PRAGMA journal_mode").get() as any).journal_mode).toLowerCase()).toBe("delete");
      const row = db.prepare("SELECT id,email FROM users WHERE id=?").get(uid) as any;
      expect(row?.email).toBe("boot@ex.com");
      expect(warn).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("never deletes a non-empty corrupt file: crashes with DbCorruptError and leaves bytes intact", () => {
    const path = tmpDb();
    const garbage = Buffer.from("this is definitely not a sqlite database file, garbage garbage garbage");
    writeFileSync(path, garbage);
    let err: any;
    try { openDb(path); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DbCorruptError);
    expect(err.code).toBe("DB_CORRUPT");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).equals(garbage)).toBe(true);
  });

  it("waits within busy_timeout while another connection holds a write lock, then succeeds after release", async () => {
    const path = tmpDb();
    // Seed ONLY the users table (raw, no openDb) so the booting connection still has
    // schema writes to do — that write is what busy_timeout waits on under the lock.
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);");
    raw.close();
    // Real overlap: a separate PROCESS holds an EXCLUSIVE write transaction for ~600ms,
    // mirroring the old Azure revision holding the WAL lock while the new one boots (AGEN-31).
    // openDb is synchronous, so the holder must live outside this process for busy_timeout
    // to actually absorb the wait.
    const { spawn } = await import("node:child_process");
    const { writeFileSync: wf } = await import("node:fs");
    const script = join(path, "..", "holder.cjs");
    wf(script, `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[2]); db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"); db.exec("BEGIN EXCLUSIVE"); db.prepare("INSERT INTO users VALUES(?,?,?,?)").run("holder-1","holder@ex.com","h",new Date().toISOString()); setTimeout(()=>{ db.exec("COMMIT"); db.close(); }, 600);`);
    const child = spawn(process.execPath, [script, path], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200)); // holder has taken the lock
    const started = Date.now();
    const db = openDb(path, { journalMode: "WAL", busyTimeoutMs: 5000 });
    const waited = Date.now() - started;
    try {
      expect(waited).toBeGreaterThanOrEqual(150); // it waited for the release, not instant-fail
      expect(waited).toBeLessThan(5000);
      const row = db.prepare("SELECT email FROM users WHERE id='holder-1'").get() as any;
      expect(row?.email).toBe("holder@ex.com");
    } finally { db.close(); }
    await new Promise((r) => child.on("exit", r));
  });

  it("fails with a typed DbBusyError after busy_timeout when the lock is not released", () => {
    const path = tmpDb();
    // Same partial-schema seed: without it, a complete schema boots read-only and never
    // contends (by design — see the no-write-lock fast path in initSchema).
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);");
    raw.close();
    const a = new DatabaseSync(path);
    a.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;");
    a.exec("BEGIN EXCLUSIVE");
    a.prepare("INSERT INTO users VALUES(?,?,?,?)").run(id(), "holder@ex.com", "h", nowIso());
    const started = Date.now();
    let busyErr: any;
    // busyBudgetMs: 0 opts out of the DIN-30 retry loop: this test asserts the single-window
    // busy_timeout behavior; the retry budget has its own test below.
    try { openDb(path, { journalMode: "WAL", busyTimeoutMs: 150, busyBudgetMs: 0 }); } catch (e) { busyErr = e; }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(busyErr).toBeInstanceOf(DbBusyError);
    expect(busyErr.code).toBe("DB_BUSY");
    a.exec("COMMIT");
    a.close();
    // After release, a normal boot succeeds, completes the schema, and sees the row:
    const b = openDb(path, { journalMode: "WAL", busyTimeoutMs: 5000 });
    try {
      expect((b.prepare("SELECT count(*) c FROM users").get() as any).c).toBe(1);
      expect((b.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as any)?.name).toBe("sessions");
    } finally { b.close(); }
  });


});
