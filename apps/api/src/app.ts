import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import argon2 from "argon2";
import { randomBytes, randomUUID } from "node:crypto";
import { openDb, nowIso, id, appendAudit, type DB } from "./db.js";
import { config } from "./config.js";
import { parseIntent, fmtAtomic } from "./parser.js";
import { bySymbol, USDC } from "./registry.js";
import { verifyRegistryToken, jupiterPrices } from "./jupiter.js";
import { createConfirmation, createQuote, effectiveExpiry, err, executeConfirmation, getPaperWallet, PaperWalletProvider, portfolioFor, paperBalances } from "./services.js";
import { issueToken, listTokens, revokeToken } from "./mcp-tokens.js";
import { registerMcp, mcpRateLimit } from "./mcp.js";
import { allAssetInfo, assetInfoFor } from "./asset-info-service.js";
import { REGISTRY } from "./registry.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

declare module "fastify" { interface FastifyRequest { user?: any; session?: any; db: DB; } }

const quotesPerHour = { count: 0, reset: Date.now() + 3600000 };
export async function buildApp(dbPath = config.databasePath) {
  const db = openDb(dbPath);
  const app = Fastify({ logger: false });
  await app.register(cookie); await app.register(cors, { origin: true, credentials: true });
  app.decorateRequest("db", null as any);
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req: any, body: string, done: any) => { try { done(null, body ? JSON.parse(body) : {}); } catch (e) { done(e); } });
  app.addHook("onRequest", async (req) => { (req as any).db = db; });
  const replyErr = (reply: any, e: any) => reply.code(e.status || 500).send({ error: { code: e.code || "INTERNAL", message: e.message } });

  async function bootCheck() {
    for (const t of [USDC, ...["SPYx", "AAPLx", "NVDAx"].map((s) => bySymbol(s)!)]) {
      const v = await verifyRegistryToken(t.mint);
      if (!v.verified) throw new Error(`Registry boot check FAILED (fail closed): ${t.symbol} ${t.mint} no verificado en Jupiter`);
    }
  }
  app.get("/health", async () => ({ ok: true, version: config.serverVersion, executionEnabled: config.executionEnabled, agentMode: config.agentMode, mcpEnabled: config.mcpEnabled, mcpContractVersion: config.mcpContractVersion }));
  const checkQuoteBudget = () => { if (Date.now() > quotesPerHour.reset) { quotesPerHour.count = 0; quotesPerHour.reset = Date.now() + 3600000; } if (++quotesPerHour.count > 300) throw err("GLOBAL_QUOTE_BUDGET_EXCEEDED", "Presupuesto global de quotes agotado", 429); };

  function auth(req: any) {
    const sid = req.cookies?.session;
    if (!sid) throw err("UNAUTHORIZED", "Sin sesión", 401);
    const s = db.prepare("SELECT * FROM sessions WHERE id=?").get(sid) as any;
    if (!s || new Date(s.expires_at).getTime() < Date.now()) throw err("UNAUTHORIZED", "Sesión vencida", 401);
    req.session = s; req.user = db.prepare("SELECT id,email FROM users WHERE id=?").get(s.user_id);
    if (!req.user) throw err("UNAUTHORIZED", "Usuario no encontrado", 401);
  }
  function csrf(req: any) { const t = req.headers["x-csrf-token"]; if (!t || t !== req.session.csrf_token) throw err("CSRF_INVALID", "Token CSRF inválido", 403); }
  const rate = new Map<string, { n: number; reset: number }>();
  function rateLimit(key: string, max: number, windowMs: number) { const now = Date.now(); const r = rate.get(key); if (!r || r.reset < now) { rate.set(key, { n: 1, reset: now + windowMs }); return; } if (r.n >= max) throw err("RATE_LIMITED", "Demasiados mensajes, esperá un toque", 429); r.n++; }

  app.post("/api/v1/auth/register", async (req: any, reply) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password || String(password).length < 8) throw err("VALIDATION", "Email y contraseña (mín. 8) requeridos", 422);
      const hash = await argon2.hash(String(password));
      const u = { id: id(), email: String(email).toLowerCase(), created: nowIso() };
      try { db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(u.id, u.email, hash, u.created); } catch { throw err("EMAIL_TAKEN", "Ese email ya está registrado", 409); }
      return reply.code(201).send({ id: u.id, email: u.email });
    } catch (e) { return replyErr(reply, e); }
  });
  app.post("/api/v1/auth/login", async (req: any, reply) => {
    try {
      const { email, password } = req.body || {};
      const u = db.prepare("SELECT * FROM users WHERE email=?").get(String(email || "").toLowerCase()) as any;
      if (!u || !(await argon2.verify(u.password_hash, String(password || "")))) throw err("INVALID_CREDENTIALS", "Credenciales inválidas", 401);
      const sid = randomBytes(32).toString("hex"); const csrfToken = randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + 8 * 3600000).toISOString();
      db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sid, u.id, csrfToken, expires, nowIso());
      reply.setCookie("session", sid, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 8 * 3600 });
      return { id: u.id, email: u.email, csrfToken };
    } catch (e) { return replyErr(reply, e); }
  });
  app.post("/api/v1/auth/logout", async (req: any, reply) => { try { auth(req); csrf(req); db.prepare("DELETE FROM sessions WHERE id=?").run(req.session.id); reply.clearCookie("session", { path: "/" }); return { ok: true }; } catch (e) { return replyErr(reply, e); } });
  app.get("/api/v1/me", async (req: any, reply) => { try { auth(req); return { id: req.user.id, email: req.user.email, csrfToken: req.session.csrf_token }; } catch (e) { return replyErr(reply, e); } });

  app.get("/api/v1/settings/mcp-tokens", async (req: any, reply) => { try { auth(req); return { items: listTokens(db, req.user.id), mcpEnabled: config.mcpEnabled, mcpEndpoint: config.mcpEnabled ? `${config.publicBaseUrl}/mcp` : null, expiresInDays: config.mcpTokenTtlDays }; } catch (e) { return replyErr(reply, e); } });
  app.post("/api/v1/settings/mcp-tokens", async (req: any, reply) => { try { auth(req); csrf(req); const { token, secret } = issueToken(db, req.user.id, req.body?.name, req.body?.scopes); return reply.code(201).send({ ...token, token: secret, secret }); } catch (e) { return replyErr(reply, e); } });
  app.delete("/api/v1/settings/mcp-tokens/:id", async (req: any, reply) => { try { auth(req); csrf(req); return revokeToken(db, req.user.id, req.params.id); } catch (e) { return replyErr(reply, e); } });
  app.post("/api/v1/settings/mcp-tokens/:id/revoke", async (req: any, reply) => { try { auth(req); csrf(req); return revokeToken(db, req.user.id, req.params.id); } catch (e) { return replyErr(reply, e); } });

  app.post("/api/v1/wallets", async (req: any, reply) => {
    try { auth(req); csrf(req); const w = PaperWalletProvider.createWallet(db, req.user.id); return reply.code(201).send({ id: w.id, mode: w.mode, provider: w.provider, label: "Paper wallet (ledger demo, sin claves)" }); } catch (e) { return replyErr(reply, e); }
  });
  app.get("/api/v1/wallets", async (req: any, reply) => { try { auth(req); const rows = db.prepare("SELECT * FROM wallets WHERE user_id=?").all(req.user.id); return { items: rows, systemRealWallet: { address: config.agentWallet, provider: "phantom-mcp-agent", mode: "real", viewOnly: true } }; } catch (e) { return replyErr(reply, e); } });
  app.post("/api/v1/wallets/:id/deposit", async (req: any, reply) => {
    try { auth(req); csrf(req); const w = db.prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id) as any; if (!w || w.user_id !== req.user.id) throw err("NOT_FOUND", "Wallet no encontrada", 404);
      const amountUsd = Number(req.body?.amountUsd); if (!amountUsd || amountUsd <= 0) throw err("VALIDATION", "amountUsd inválido", 422);
      const total = db.prepare("SELECT COALESCE(SUM(amount_usd),0) s FROM paper_ledger WHERE user_id=? AND kind='paper_faucet'").get(req.user.id) as any;
      if (Number(total.s) + amountUsd > config.paperFaucetCapUsd) throw err("FAUCET_CAP", `Faucet paper capped a ${config.paperFaucetCapUsd} USD total`, 422);
      db.prepare("INSERT INTO paper_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id(), req.user.id, w.id, "paper_faucet", "USDC", USDC.mint, String(Math.round(amountUsd * 1e6)), amountUsd, null, "paper_faucet", nowIso());
      appendAudit(db, null, req.user.id, "paper_faucet", { amountUsd });
      const bal = paperBalances(db, req.user.id, w.id); return { paperUsdc: Number(bal.usdcAtomic) / 1e6, mode: "paper" }; } catch (e) { return replyErr(reply, e); }
  });

  app.post("/api/v1/quotes", async (req: any, reply) => {
    try { auth(req); csrf(req);
      if (Date.now() > quotesPerHour.reset) { quotesPerHour.count = 0; quotesPerHour.reset = Date.now() + 3600000; }
      if (++quotesPerHour.count > 300) throw err("GLOBAL_QUOTE_BUDGET_EXCEEDED", "Presupuesto global de quotes agotado", 429);
      const wallet = getPaperWallet(db, req.user.id); if (!wallet) throw err("NO_WALLET", "Creá tu paper wallet primero", 422);
      const { symbol, amountUsd, side } = req.body || {};
      const { quote, warning } = await createQuote(db, req.user.id, wallet.id, symbol, Number(amountUsd), side === "sell" ? "sell" : "buy");
      const t = bySymbol(symbol)!;
      return { quoteId: quote.id, inAmount: quote.amountInAtomic, outAmount: quote.quotedOutAtomic, minOut: quote.minOutAtomic, slippageBps: quote.slippageBps, priceImpactPct: quote.priceImpactPct, expiresAt: quote.expiresAt, warning, mode: "paper", quoteAgeMs: 0 }; } catch (e) { return replyErr(reply, e); }
  });

  app.post("/api/v1/chat/message", async (req: any, reply) => {
    try { auth(req); csrf(req); rateLimit(`chat:${req.user.id}`, 20, 60000);
      const text = String(req.body?.message || ""); if (!text.trim()) throw err("VALIDATION", "Mensaje vacío", 422);
      const wallet = getPaperWallet(db, req.user.id);
      let intent; try { intent = parseIntent(text); } catch (e: any) { return { reply: "Ese monto tiene más de 2 decimales y no lo puedo procesar sin redondear. Probá con centavos, por ejemplo 10,50 USD.", mode: "paper" }; }
      if (intent.kind === "balance" || intent.kind === "portfolio") {
        if (!wallet) return { reply: "Todavía no tenés paper wallet. Creala y cargale USDC paper para empezar.", mode: "paper" };
        const p = await portfolioFor(db, req.user.id);
        const pos = p.positions.length ? p.positions.map((x: any) => `${x.symbol}: ${x.amount.toFixed(6)} (≈ ${(x.usdValue ?? 0).toFixed(2)} USD, paper)`).join(" · ") : "sin posiciones paper";
        return { reply: `Tenés ${p.paperUsdc.toFixed(2)} USDC paper. Posiciones: ${pos}. Wallet real del agente (solo lectura): ${p.real?.sol ?? "?"} SOL.`, portfolio: p, mode: "paper" };
      }
      if (intent.kind === "out_of_registry") return { reply: `Hoy puedo operar S&P 500 (SPYx), Apple (AAPLx) y Nvidia (NVDAx). ${intent.rawAsset} no está en el registry.`, mode: "paper" };
      if (intent.kind === "clarify") {
        if (intent.needsAmount) return { reply: `¿Cuánto querés ${intent.symbol ? "invertir" : "operar"}${intent.symbol ? ` en ${bySymbol(intent.symbol!)!.human}` : ""}? Por ejemplo: 10 USD.`, mode: "paper" };
        return { reply: "¿En qué activo? Puedo operar S&P 500, Apple o Nvidia.", mode: "paper" };
      }
      if (intent.kind === "unknown") return { reply: "Puedo cotizar una compra o venta (ej: \"Invertí 10 USD en el S&P 500\"), mostrarte tu portfolio o tu saldo. No doy recomendaciones de inversión.", mode: "paper" };
      if (!wallet) return { reply: "Creá tu paper wallet primero y cargale USDC paper.", mode: "paper" };
      if (Date.now() > quotesPerHour.reset) { quotesPerHour.count = 0; quotesPerHour.reset = Date.now() + 3600000; }
      if (++quotesPerHour.count > 300) throw err("GLOBAL_QUOTE_BUDGET_EXCEEDED", "Presupuesto global agotado", 429);
      const { quote, warning } = await createQuote(db, req.user.id, wallet.id, intent.symbol!, intent.amountUsd!, intent.kind);
      const conf = createConfirmation(db, req.user.id, wallet.id, quote.id, text, intent.symbol!, intent.kind);
      const t = bySymbol(intent.symbol!)!;
      const outHuman = fmtAtomic(quote.quotedOutAtomic, intent.kind === "buy" ? t.decimals : 6);
      const verb = intent.kind === "buy" ? "comprando" : "vendiendo";
      return { reply: `${warning ? warning + ". " : ""}Estás ${verb} ${intent.amountUsd} USD de ${t.human} (${t.symbol}). Confirmá en la tarjeta para simular a quote.`, confirmation: { id: conf.id, status: conf.status, symbol: t.symbol, human: t.human, side: intent.kind, amountUsd: intent.amountUsd, quotedOut: outHuman, minOut: fmtAtomic(quote.minOutAtomic, intent.kind === "buy" ? t.decimals : 6), slippageBps: quote.slippageBps, priceImpactPct: quote.priceImpactPct, expiresAt: quote.expiresAt, mode: "paper" }, mode: "paper" };
    } catch (e) { return replyErr(reply, e); }
  });

  function ownedConfirmation(req: any) { const c = db.prepare("SELECT * FROM confirmations WHERE id=?").get(req.params.id) as any; if (!c || c.user_id !== req.user.id) throw err("NOT_FOUND", "Confirmation no encontrada", 404); return c; }
  app.post("/api/v1/confirmations/:id/present", async (req: any, reply) => {
    try { auth(req); csrf(req); let c = ownedConfirmation(req);
      if (c.status === "proposed") { db.prepare("UPDATE confirmations SET status='pending_confirmation', presented_at=? WHERE id=?").run(nowIso(), c.id); appendAudit(db, c.id, req.user.id, "presented", {}); c = db.prepare("SELECT * FROM confirmations WHERE id=?").get(c.id); }
      if (c.status !== "pending_confirmation") return { id: c.id, status: c.status, expiresAt: c.expires_at };
      const exp = effectiveExpiry(c); db.prepare("UPDATE confirmations SET expires_at=? WHERE id=?").run(exp, c.id);
      return { id: c.id, status: "pending_confirmation", expiresAt: exp }; } catch (e) { return replyErr(reply, e); }
  });
  app.post("/api/v1/confirmations/:id/confirm", async (req: any, reply) => {
    try { auth(req); csrf(req); const c = ownedConfirmation(req);
      if (["confirmed", "executing", "executed"].includes(c.status)) return { id: c.id, status: c.status, mode: c.mode };
      if (c.status === "superseded") throw err("CONFIRMATION_SUPERSEDED", "Esta propuesta ya no está vigente porque hay una más nueva. Fijate en la última tarjeta.", 409);
      if (c.status === "rejected") throw err("CONFIRMATION_REJECTED", "Esta propuesta fue rechazada", 409);
      if (c.status !== "pending_confirmation") throw err("CONFIRMATION_NOT_PENDING", `Estado ${c.status} no confirmable`, 409);
      const exp = effectiveExpiry(c); if (exp && Date.now() > new Date(exp).getTime()) { db.prepare("UPDATE confirmations SET status='expired' WHERE id=?").run(c.id); appendAudit(db, c.id, req.user.id, "expired", {}); throw err("confirmation_expired", "La cotización venció y la compra no se hizo. ¿Querés que te cotice de nuevo?", 409); }
      db.prepare("UPDATE confirmations SET status='confirmed', decided_at=?, decided_by=? WHERE id=?").run(nowIso(), req.user.id, c.id);
      appendAudit(db, c.id, req.user.id, "confirmed", { decidedBy: req.user.id });
      const done: any = await executeConfirmation(db, c.id);
      const ex = db.prepare("SELECT e.* FROM executions e JOIN orders o ON o.id=e.order_id WHERE o.confirmation_id=?").get(c.id) as any;
      const t = bySymbol(c.symbol);
      let message: string;
      if (done.status === "executed") message = `Listo. Simulado a quote: se acreditaron ≈ ${fmtAtomic(c.quoted_out_atomic, c.side === "buy" ? t!.decimals : 6)} ${c.side === "buy" ? c.symbol : "USDC"} por ${Number(c.amount_in_atomic) / (c.side === "buy" ? 1e6 : 10 ** t!.decimals)} ${c.side === "buy" ? "USD" : c.symbol} en tu saldo paper. Esto no ejecutó ninguna transacción real.`;
      else message = `La compra no se pudo ejecutar (${done.error_code}). No se debitó nada de tu wallet. Quedó registrada como #${c.id}.`;
      return { id: c.id, status: done.status, mode: "paper", execution: ex ? { simulationMode: ex.simulation_mode, actualOutAtomic: ex.actual_out_atomic } : undefined, message }; } catch (e) { return replyErr(reply, e); }
  });
  app.post("/api/v1/confirmations/:id/reject", async (req: any, reply) => {
    try { auth(req); csrf(req); const c = ownedConfirmation(req);
      if (c.status === "rejected") return { id: c.id, status: "rejected" };
      if (c.status === "superseded") throw err("CONFIRMATION_SUPERSEDED", "Esta propuesta ya no está vigente porque hay una más nueva. Fijate en la última tarjeta.", 409);
      if (!["proposed", "pending_confirmation"].includes(c.status)) throw err("CONFIRMATION_NOT_REJECTABLE", `Estado ${c.status} no rechazable`, 409);
      db.prepare("UPDATE confirmations SET status='rejected', decided_at=?, decided_by=? WHERE id=?").run(nowIso(), req.user.id, c.id);
      appendAudit(db, c.id, req.user.id, "rejected", { decidedBy: req.user.id });
      return { id: c.id, status: "rejected", message: "Compra cancelada. No se movió nada de tu wallet." }; } catch (e) { return replyErr(reply, e); }
  });
  app.get("/api/v1/confirmations/:id", async (req: any, reply) => { try { auth(req); const c = ownedConfirmation(req); const tkn = bySymbol(c.symbol); const dec = tkn?.decimals ?? 8; return { id: c.id, status: c.status, mode: c.mode, symbol: c.symbol, side: c.side, amountUsd: Number(c.amount_in_atomic) / 1e6, quotedOut: String(Number(c.quoted_out_atomic) / 10 ** dec), minOut: String(Number(c.min_out_atomic) / 10 ** dec), slippageBps: c.slippage_bps, priceImpactPct: c.price_impact_pct, expiresAt: c.expires_at, txSignature: null, proposedVia: c.proposed_via ? JSON.parse(c.proposed_via) : null }; } catch (e) { return replyErr(reply, e); } });
  app.get("/api/v1/assets", async (req: any, reply) => {
    try {
      const info = await allAssetInfo();
      return { mode: "paper", items: info };
    } catch (e) { return replyErr(reply, e); }
  });
  app.get("/api/v1/assets/:symbol", async (req: any, reply) => {
    try {
      const token = REGISTRY.find((t) => t.symbol === String(req.params.symbol));
      if (!token) throw err("ASSET_NOT_IN_REGISTRY", "Activo fuera del registry", 404);
      return await assetInfoFor(token);
    } catch (e) { return replyErr(reply, e); }
  });
  app.get("/api/v1/portfolio", async (req: any, reply) => { try { auth(req); return await portfolioFor(db, req.user.id); } catch (e) { return replyErr(reply, e); } });
  app.get("/api/v1/transactions", async (req: any, reply) => { try { auth(req); const rows = db.prepare("SELECT * FROM confirmations WHERE user_id=? ORDER BY created_at DESC LIMIT 50").all(req.user.id) as any[]; return { items: rows.map((c) => ({ id: c.id, type: c.side, symbol: c.symbol, amountUsd: c.side === "buy" ? Number(c.amount_in_atomic) / 1e6 : null, status: c.status, mode: c.mode, txSignature: null, createdAt: c.created_at })) }; } catch (e) { return replyErr(reply, e); } });

  registerMcp(app as any, db, { checkQuoteBudget, rateLimitMcp: mcpRateLimit });

  if (process.env.SERVE_WEB === "true") {
    const webDir = process.env.WEB_DIST || "/app/apps/web/dist";
    const mime: Record<string,string> = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css", ".json":"application/json", ".svg":"image/svg+xml", ".png":"image/png", ".ico":"image/x-icon", ".woff2":"font/woff2" };
    app.setNotFoundHandler(async (req: any, reply: any) => {
      if (req.url.startsWith("/api/") || req.url === "/health") return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
      const safe = req.url.split("?")[0].replace(/\.\.\//g, "");
      let fp = join(webDir, safe === "/" ? "index.html" : safe);
      if (!existsSync(fp) || !statSync(fp).isFile()) fp = join(webDir, "index.html");
      if (!existsSync(fp)) return reply.code(404).send("web not built");
      reply.type(mime[extname(fp)] || "application/octet-stream");
      return reply.send(readFileSync(fp));
    });
  }
  return { app, db, bootCheck };
}
