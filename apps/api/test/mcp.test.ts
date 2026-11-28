import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";

// MCP_ENABLED is read at module load; set it before importing the app.
process.env.MCP_ENABLED = "true";
process.env.PUBLIC_BASE_URL = "http://onda.test";
process.env.SOLANA_RPC_URL = "https://rpc.onda.test";
process.env.SOLANA_RPC_FALLBACK_URL = "https://rpc.onda.test";

const { buildApp } = await import("../src/app.js");
const { openDb, nowIso, id } = await import("../src/db.js");
const { hashToken, issueToken, listTokens, revokeToken } = await import("../src/mcp-tokens.js");
const { REGISTRY } = await import("../src/registry.js");
const { verifyAuditChain } = await import("../src/db.js");

let app: FastifyInstance;
let baseUrl = "";
const clients: Client[] = [];

async function makeUser(email: string) {
  const reg = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, password: "password123" } });
  expect(reg.statusCode).toBe(201);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "password123" } });
  const cookie = login.cookies.find((c: any) => c.name === "session")!.value;
  const csrf = login.json().csrfToken as string;
  const w = await app.inject({ method: "POST", url: "/api/v1/wallets", cookies: { session: cookie }, headers: { "x-csrf-token": csrf } });
  const walletId = w.json().id as string;
  await app.inject({ method: "POST", url: `/api/v1/wallets/${walletId}/deposit`, payload: { amountUsd: 100 }, cookies: { session: cookie }, headers: { "x-csrf-token": csrf } });
  const userId = login.json().id as string;
  const db: any = (app as any).dbRef;
  return { userId, walletId, cookie, csrf, email, db };
}
async function mcpClient(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "onda-test-client", version: "1.0.0" }, { capabilities: {} });
  clients.push(client);
  await client.connect(transport);
  return client;
}
function payload(result: any) { return result.structuredContent ?? JSON.parse(result.content[0].text); }
function seedQuote(db: any, userId: string, walletId: string, symbol = "SPYx", amountUsd = 10) {
  const token = REGISTRY.find((t: any) => t.symbol === symbol)!;
  const qid = id();
  const outAtomic = "1300000"; // 0.013 SPYx
  db.prepare("INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(qid, userId, walletId, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", token.mint, String(Math.round(amountUsd * 1e6)), outAtomic, "1280500", 50, 0.04, "req-" + qid, "dHg=", new Date(Date.now() + 30000).toISOString(), null, nowIso());
  return qid;
}

describe("Onda MCP fase 1.2 — cliente MCP real contra Fastify", () => {
  let alice: any, bob: any, db: any;
  let aliceToken: string, aliceTokenId: string;
  beforeAll(async () => {
    const built: any = await buildApp(":memory:");
    app = built.app; db = built.db;
    (app as any).dbRef = db;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr: any = app.server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    alice = await makeUser("alice-mcp@test.dev");
    bob = await makeUser("bob-mcp@test.dev");
    const created = await app.inject({ method: "POST", url: "/api/v1/settings/mcp-tokens", payload: { name: "Cursor laptop", scopes: ["read:portfolio", "quote", "propose"] }, cookies: { session: alice.cookie }, headers: { "x-csrf-token": alice.csrf } });
    expect(created.statusCode).toBe(201);
    aliceToken = created.json().secret;
    aliceTokenId = created.json().id;
    expect(aliceToken.startsWith("onda_mcp_")).toBe(true);
  });
  afterAll(async () => { for (const c of clients) await c.close().catch(() => {}); await app.close(); });

  it("token lifecycle: hash-only, scopes cerrados, NO execute", async () => {
    const row = db.prepare("SELECT * FROM mcp_tokens WHERE id=?").get(aliceTokenId);
    expect(row.token_hash).toBe(hashToken(aliceToken));
    expect(row.token_hash).not.toContain(aliceToken);
    expect(JSON.parse(row.scopes)).toEqual(["read:portfolio", "quote", "propose"]);
    const bad = await app.inject({ method: "POST", url: "/api/v1/settings/mcp-tokens", payload: { name: "x", scopes: ["execute"] }, cookies: { session: alice.cookie }, headers: { "x-csrf-token": alice.csrf } });
    expect(bad.statusCode).toBe(422);
    const list = listTokens(db, alice.userId);
    expect(list[0].expiresAt).toBeTruthy();
    expect(new Date(list[0].expiresAt).getTime() - Date.now()).toBeGreaterThan(89 * 86400000);
  });

  it("initialize + tools/list: 7 tools, sin tool de ejecución/confirmación", async () => {
    const client = await mcpClient(aliceToken);
    const tools = await client.listTools();
    const names = tools.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["onda_get_asset_info", "onda_get_confirmation", "onda_get_limits", "onda_get_portfolio", "onda_list_assets", "onda_propose_trade", "onda_quote_swap"]);
    expect(names.some((n: string) => /execute|onda_confirm_trade|onda_reject|onda_sign/.test(n))).toBe(false);
    const propose: any = tools.tools.find((t: any) => t.name === "onda_propose_trade");
    expect(propose.annotations).toMatchObject({ destructiveHint: false, readOnlyHint: false });
    const assets: any = payload(await client.callTool({ name: "onda_list_assets", arguments: {} }));
    expect(assets.mode).toBe("paper");
    expect(assets.assets.map((a: any) => a.symbol)).toEqual(["SPYx", "AAPLx", "NVDAx"]);
    const limits: any = payload(await client.callTool({ name: "onda_get_limits", arguments: {} }));
    expect(limits).toMatchObject({ mode: "paper", executionEnabled: false, maxPriceImpactPct: 3, slippageBps: 50, mcpContractVersion: "1.0.0" });
    const portfolio: any = payload(await client.callTool({ name: "onda_get_portfolio", arguments: {} }));
    expect(portfolio.mode).toBe("paper");
    expect(portfolio.usdc.amount).toBe(100);
    expect(portfolio.real).toMatchObject({ mode: "real", sol: 1.5, tokens: [] });
  });

  it("onda_get_asset_info: ficha mergeada con fuente/asOf, scope read, sin inventos", async () => {
    const client = await mcpClient(aliceToken);
    const info: any = payload(await client.callTool({ name: "onda_get_asset_info", arguments: { symbol: "AAPLx" } }));
    expect(info.mode).toBe("paper");
    expect(info.symbol).toBe("AAPLx");
    expect(info.curated.underlyingTicker).toBe("AAPL");
    expect(info.curated.inceptionDate).toBe("1980-12-12");
    expect(info.curated.inceptionLabel).toBe("ipo");
    expect(info.curated.sourceUrl).toMatch(/^https:/);
    expect(info.curated.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(info.live.source).toBe("jupiter");
    expect(info.live).toMatchObject({ priceUsd: 101.25, priceChange24hPct: 2.5, volume24hUsd: 50 });
    expect(info).not.toHaveProperty("dividendYieldPct");
    const bad: any = await client.callTool({ name: "onda_get_asset_info", arguments: { symbol: "TSLAx" } });
    expect(bad.isError).toBe(true);
  });

  it("quote→propose→poll en paper (quote persistida local; Jupiter live va por e2e-live)", async () => {
    const client = await mcpClient(aliceToken);
    const quoteId = seedQuote(db, alice.userId, alice.walletId);
    const proposed: any = payload(await client.callTool({ name: "onda_propose_trade", arguments: { quoteId } }));
    expect(proposed.mode).toBe("paper");
    expect(proposed.status).toBe("proposed");
    expect(proposed.signingUrl).toBe(`http://onda.test/confirm/${proposed.confirmationId}`);
    expect(proposed.txSignature).toBeUndefined();
    // propose NUNCA confirma ni ejecuta
    const row = db.prepare("SELECT * FROM confirmations WHERE id=?").get(proposed.confirmationId);
    expect(row.status).toBe("proposed");
    expect(JSON.parse(row.proposed_via)).toMatchObject({ channel: "mcp", tokenId: aliceTokenId, clientName: "onda-test-client" });
    const polled: any = payload(await client.callTool({ name: "onda_get_confirmation", arguments: { confirmationId: proposed.confirmationId } }));
    expect(polled.status).toBe("pending");
    // idempotencia: repetir propose con la misma quote devuelve la misma confirmation
    const again: any = payload(await client.callTool({ name: "onda_propose_trade", arguments: { quoteId } }));
    expect(again.confirmationId).toBe(proposed.confirmationId);
    // supersede: una segunda propuesta reemplaza a la primera
    const q2 = seedQuote(db, alice.userId, alice.walletId);
    const second: any = payload(await client.callTool({ name: "onda_propose_trade", arguments: { quoteId: q2 } }));
    const old: any = payload(await client.callTool({ name: "onda_get_confirmation", arguments: { confirmationId: proposed.confirmationId } }));
    expect(old.status).toBe("superseded");
    expect(second.status).toBe("proposed");
    expect(verifyAuditChain(db)).toBe(true);
  });

  it("seguridad: token de A no toca lo de B; scopes; vencido; revocado expira pendientes", async () => {
    // token read-only de Alice
    const roDb: any = db;
    const ro = issueToken(roDb, alice.userId, "solo lectura", ["read:portfolio"]);
    const roClient = await mcpClient(ro.secret);
    const denied: any = await roClient.callTool({ name: "onda_propose_trade", arguments: { quoteId: seedQuote(db, alice.userId, alice.walletId) } });
    expect(denied.isError).toBe(true);
    expect(payload(denied).error.code).toBe("FORBIDDEN_SCOPE");

    // Bob no ve la confirmation de Alice
    const bobTok = issueToken(db, bob.userId, "bob", ["read:portfolio", "quote", "propose"]);
    const bobClient = await mcpClient(bobTok.secret);
    const pending = db.prepare("SELECT id FROM confirmations WHERE user_id=? AND status IN ('proposed','pending_confirmation')").get(alice.userId) as any;
    const foreign: any = await bobClient.callTool({ name: "onda_get_confirmation", arguments: { confirmationId: pending.id } });
    expect(foreign.isError).toBe(true);
    expect(payload(foreign).error.code).toBe("NOT_FOUND");
    // Bob tampoco propone con quote de Alice
    const bobPropose: any = await bobClient.callTool({ name: "onda_propose_trade", arguments: { quoteId: seedQuote(db, alice.userId, alice.walletId) } });
    expect(payload(bobPropose).error.code).toBe("NOT_FOUND");

    // vencido -> 401 UNAUTHORIZED
    const exp = issueToken(db, alice.userId, "vencido", ["read:portfolio"]);
    db.prepare("UPDATE mcp_tokens SET expires_at=? WHERE token_hash=?").run(new Date(Date.now() - 1000).toISOString(), hashToken(exp.secret));
    const expClientTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${exp.secret}` } } });
    const expClient = new Client({ name: "exp", version: "1" }, { capabilities: {} });
    await expect(expClient.connect(expClientTransport)).rejects.toThrow();

    // revocado -> 401 y expira pendientes de ese token
    const aliceClient = await mcpClient(aliceToken);
    const q = seedQuote(db, alice.userId, alice.walletId);
    const prop: any = payload(await aliceClient.callTool({ name: "onda_propose_trade", arguments: { quoteId: q } }));
    revokeToken(db, alice.userId, aliceTokenId);
    expect(db.prepare("SELECT status FROM confirmations WHERE id=?").get(prop.confirmationId).status).toBe("expired");
    const revokedTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${aliceToken}` } } });
    const revokedClient = new Client({ name: "rev", version: "1" }, { capabilities: {} });
    await expect(revokedClient.connect(revokedTransport)).rejects.toThrow();
  });

  it("sin token -> 401; rate limit por token dispara RATE_LIMITED vía HTTP", async () => {
    const noAuth = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    expect(noAuth.status).toBe(401);
    const u = await makeUser("rl-mcp@test.dev");
    const tok = issueToken(db, u.userId, "rl", ["read:portfolio"]);
    let limited = false;
    for (let i = 0; i < 65; i++) {
      const r = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.secret}` }, body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "onda_get_limits", arguments: {} } }) });
      if (r.status === 429) { const j: any = await r.json(); expect(j.error.message).toContain("RATE_LIMITED"); limited = true; break; }
    }
    expect(limited).toBe(true);
  });
});
