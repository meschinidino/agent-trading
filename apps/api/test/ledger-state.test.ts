import { describe, it, expect, beforeEach } from "vitest";
import { openDb, nowIso, id, verifyAuditChain } from "../src/db.js";
import { paperBalances, createConfirmation, supersedePending } from "../src/services.js";
describe("ledger math + state machine (fixtures locales)", () => {
  let db: any, u = "u1", w = "w1";
  beforeEach(() => { db = openDb(":memory:"); db.prepare("INSERT INTO paper_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id(), u, w, "paper_faucet", "USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "100000000", 100, null, "paper_faucet", nowIso()); });
  it("saldo paper tras faucet", () => { expect(Number(paperBalances(db, u, w).usdcAtomic) / 1e6).toBe(100); });
  it("single-pending: crear segunda supersede la primera + dedupe por quote", () => {
    const mk = () => { const qid = id(); db.prepare("INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(qid, u, w, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", "10000000", "1300000", "1290000", 50, 0.04, "req-" + qid, "dHg=", new Date(Date.now() + 30000).toISOString(), null, nowIso()); return qid; };
    const c1: any = createConfirmation(db, u, w, mk(), "Invertí 10 USD en el S&P 500", "SPYx", "buy");
    expect(createConfirmation(db, u, w, c1.quote_id, "x", "SPYx", "buy").id).toBe(c1.id); // dedupe
    const c2: any = createConfirmation(db, u, w, mk(), "Invertí 10 USD en el S&P 500", "SPYx", "buy");
    expect(db.prepare("SELECT status FROM confirmations WHERE id=?").get(c1.id).status).toBe("superseded");
    expect(c2.status).toBe("proposed");
    expect(verifyAuditChain(db)).toBe(true);
  });
});
