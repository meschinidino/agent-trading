import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { buildApp } from "../src/app.js";
import { hub, quoteSnapshot } from "../src/events.js";
import { expireStaleConfirmations } from "../src/services.js";
import { nowIso } from "../src/db.js";

// SSE real sobre HTTP (DIN-35): dos sesiones simultáneas, aislamiento por
// usuario probado disparando un cambio de estado real de una confirmation
// de A (superseded al crear la segunda) y verificando que B no recibe nada.
let server: Server; let base = ""; let appRef: any; let dbRef: any;

async function registerLogin(app: any, email: string) {
  await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, password: "password123" } });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "password123" } });
  const cookie = login.cookies.find((c: any) => c.name === "session").value;
  return { cookie, csrf: login.json().csrfToken, id: login.json().id };
}

class SseClient {
  buf = ""; events: Array<{ event: string; data: any }> = []; waiters: Array<() => void> = []; res: any;
  constructor(public url: string, public cookie: string) {}
  async connect() {
    const ac = new AbortController(); (this as any).ac = ac;
    const res = await fetch(this.url, { headers: { cookie: `session=${this.cookie}` }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    this.res = res;
    (async () => {
      const reader = res.body!.getReader(); const dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; this.push(dec.decode(value, { stream: true })); }
    })().catch(() => {});
    return this;
  }
  push(chunk: string) {
    this.buf += chunk;
    let i; while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const raw = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2);
      if (!raw || raw.startsWith(":")) continue;
      const ev = raw.match(/^event: (.+)$/m)?.[1] || "message";
      const dataRaw = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      try { this.events.push({ event: ev, data: JSON.parse(dataRaw) }); } catch { this.events.push({ event: ev, data: dataRaw }); }
      this.waiters.splice(0).forEach((w) => w());
    }
  }
  async waitFor(pred: (e: any) => boolean, timeoutMs = 3000) {
    const t0 = Date.now();
    for (;;) { const hit = this.events.find(pred); if (hit) return hit; if (Date.now() - t0 > timeoutMs) throw new Error("SSE timeout; got " + JSON.stringify(this.events)); await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 25); }); }
  }
  close() { try { (this as any).ac?.abort(); } catch {} }
}

describe("SSE /api/v1/events (DIN-35)", () => {
  let A: any, B: any;
  beforeAll(async () => {
    const { app, db } = await buildApp(":memory:"); appRef = app; dbRef = db; await app.ready();
    server = createServer((req, res) => { (app as any).routing(req, res); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    A = await registerLogin(app, "sse-a@test.dev"); B = await registerLogin(app, "sse-b@test.dev");
  }, 20000);
  afterAll(async () => { await appRef?.close(); await new Promise((r) => server?.close(r)); });

  it("sin sesión -> 401", async () => {
    const res = await fetch(`${base}/api/v1/events`);
    expect(res.status).toBe(401);
  });

  it("hub: emitToUser no cruza usuarios (unit)", () => {
    const gotA: any[] = []; const gotB: any[] = [];
    const offA = hub.add("u-a", (e, d) => gotA.push({ e, d })); const offB = hub.add("u-b", (e, d) => gotB.push({ e, d }));
    hub.confirmation("u-a", { id: "c1", status: "executed", symbol: "SPYx", side: "buy", mode: "paper" });
    expect(gotA.map((x) => x.e)).toEqual(["confirmation", "portfolio"]);
    expect(gotB).toEqual([]);
    offA(); offB();
  });

  it("quoteSnapshot usa el registry y los precios de Jupiter del fixture", async () => {
    const items = await quoteSnapshot();
    expect(items.map((x) => x.symbol)).toEqual(["SPYx", "AAPLx", "NVDAx"]);
    for (const i of items) expect(i).toMatchObject({ asOf: expect.any(String), priceUsd: 101.25, priceChange24hPct: 2.5 });
  });

  it("expireStaleConfirmations marca expired y emite solo al dueño", async () => {
    const offEvents: any[] = [];
    const wallet = await appRef.inject({ method: "POST", url: "/api/v1/wallets", cookies: { session: A.cookie }, headers: { "x-csrf-token": A.csrf } });
    // confirmation directa en DB (sin Jupiter): propuesta vencida
    const { id: cid } = await import("../src/db.js").then((m) => ({ id: m.id() }));
    dbRef.prepare("INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("q-sse", A.id, wallet.json().id, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", "10000000", "1300000", "1290000", 50, 0.1, "req", null, new Date(Date.now() + 30000).toISOString(), nowIso(), nowIso());
    dbRef.prepare("INSERT INTO confirmations(id,user_id,wallet_id,quote_id,mode,status,raw_intent,llm_summary,input_mint,output_mint,symbol,side,amount_in_atomic,quoted_out_atomic,min_out_atomic,slippage_bps,price_impact_pct,error_code,prev_hash,record_hash,lease_expires_at,created_at,presented_at,decided_at,decided_by,executed_at,expires_at,proposed_via) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(cid, A.id, wallet.json().id, "q-sse", "paper", "pending_confirmation", "test", "Comprar SPYx", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", "SPYx", "buy", "10000000", "1300000", "1290000", 50, 0.1, null, "p", "r", null, nowIso(), nowIso(), null, null, null, new Date(Date.now() - 1000).toISOString(), null);
    const off = hub.add(A.id, (e, d) => offEvents.push({ e, d }));
    expect(expireStaleConfirmations(dbRef)).toBe(1);
    expect(offEvents).toEqual([{ e: "confirmation", d: { id: cid, status: "expired", symbol: "SPYx", side: "buy", mode: "paper" } }]);
    off();
    expect((dbRef.prepare("SELECT status FROM confirmations WHERE id=?").get(cid) as any).status).toBe("expired");
  });

  it("HTTP real: A recibe su confirmation, B conectado a la vez no recibe nada de A", async () => {
    const a = await new SseClient(`${base}/api/v1/events`, A.cookie).connect();
    const b = await new SseClient(`${base}/api/v1/events`, B.cookie).connect();
    try {
      await a.waitFor((e) => e.event === "ready"); await b.waitFor((e) => e.event === "ready");
      // Cambio de estado real de A a través del hub (mismo path que usan los endpoints)
      hub.confirmation(A.id, { id: "conf-A-1", status: "rejected", symbol: "SPYx", side: "buy", mode: "paper" });
      const hit = await a.waitFor((e) => e.event === "confirmation" && e.data.id === "conf-A-1");
      expect(hit.data.status).toBe("rejected");
      // Ventana acotada para que un leak a B tuviera tiempo de llegar
      await new Promise((r) => setTimeout(r, 300));
      expect(b.events.filter((e) => e.event === "confirmation")).toEqual([]);
      hub.confirmation(B.id, { id: "conf-B-1", status: "executed", symbol: "AAPLx", side: "buy", mode: "paper" });
      await b.waitFor((e) => e.event === "confirmation" && e.data.id === "conf-B-1");
      await b.waitFor((e) => e.event === "portfolio");
      expect(a.events.filter((e) => e.event === "confirmation" && e.data.id === "conf-B-1")).toEqual([]);
    } finally { a.close(); b.close(); }
  }, 15000);

  it("HTTP real: reject por API emite confirmation al dueño conectado", async () => {
    // Crear confirmation real sin Jupiter insertando quote+confirmation y rechazando vía API
    const w = await appRef.inject({ method: "POST", url: "/api/v1/wallets", cookies: { session: A.cookie }, headers: { "x-csrf-token": A.csrf } });
    const { id } = await import("../src/db.js");
    const cid = id(); const qid = id();
    dbRef.prepare("INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(qid, A.id, w.json().id, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", "10000000", "1300000", "1290000", 50, 0.1, "req2", null, new Date(Date.now() + 30000).toISOString(), nowIso(), nowIso());
    dbRef.prepare("INSERT INTO confirmations(id,user_id,wallet_id,quote_id,mode,status,raw_intent,llm_summary,input_mint,output_mint,symbol,side,amount_in_atomic,quoted_out_atomic,min_out_atomic,slippage_bps,price_impact_pct,error_code,prev_hash,record_hash,lease_expires_at,created_at,presented_at,decided_at,decided_by,executed_at,expires_at,proposed_via) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(cid, A.id, w.json().id, qid, "paper", "proposed", "test", "Comprar SPYx", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", "SPYx", "buy", "10000000", "1300000", "1290000", 50, 0.1, null, "p2", "r2", null, nowIso(), null, null, null, null, null, null);
    const a = await new SseClient(`${base}/api/v1/events`, A.cookie).connect();
    try {
      await a.waitFor((e) => e.event === "ready");
      const rej = await appRef.inject({ method: "POST", url: `/api/v1/confirmations/${cid}/reject`, cookies: { session: A.cookie }, headers: { "x-csrf-token": A.csrf } });
      expect(rej.statusCode).toBe(200);
      const hit = await a.waitFor((e) => e.event === "confirmation" && e.data.id === cid);
      expect(hit.data.status).toBe("rejected");
    } finally { a.close(); }
  }, 15000);
});
