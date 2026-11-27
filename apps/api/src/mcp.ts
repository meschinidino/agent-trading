import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { appendAudit, type DB } from "./db.js";
import { config } from "./config.js";
import { fmtAtomic } from "./parser.js";
import { REGISTRY, byMint, bySymbol } from "./registry.js";
import { createConfirmation, createQuote, err, getPaperWallet, portfolioFor } from "./services.js";
import { authenticateToken, requireScope, type TokenAuth } from "./mcp-tokens.js";

const mcpBuckets = new Map<string, { n: number; reset: number }>();
const mcpClientsByToken = new Map<string, { name?: string; version?: string }>();
function bucket(key: string, max: number) {
  const now = Date.now(); const r = mcpBuckets.get(key);
  if (!r || r.reset < now) { mcpBuckets.set(key, { n: 1, reset: now + 60000 }); return; }
  if (r.n >= max) throw err("RATE_LIMITED", "Límite por token alcanzado (spec 07 §3.3). Esperá un minuto.", 429);
  r.n++;
}
export function mcpRateLimit(auth: TokenAuth, tool?: string) {
  bucket(`mcp:${auth.tokenId}`, 60);
  if (tool === "onda_quote_swap") bucket(`mcp-quote:${auth.tokenId}`, 10);
  if (tool === "onda_propose_trade") bucket(`mcp-propose:${auth.tokenId}`, 5);
}

declare module "fastify" { interface FastifyRequest { mcpAuth?: TokenAuth; mcpClient?: { name?: string; version?: string }; } }

const MCP_ERROR_STATUS: Record<string, number> = { UNAUTHORIZED: 401, FORBIDDEN_SCOPE: 403, NOT_FOUND: 404, QUOTE_NOT_FOUND: 404, QUOTE_NOT_OWNED: 404, RATE_LIMITED: 429, QUOTE_BUDGET_EXCEEDED: 429, GLOBAL_QUOTE_BUDGET_EXCEEDED: 429 };
const CODE_MAP: Record<string, string> = { ASSET_NOT_IN_REGISTRY: "VALIDATION", INSUFFICIENT_PAPER_BALANCE: "INSUFFICIENT_BALANCE", QUOTE_NOT_FOUND: "NOT_FOUND", QUOTE_NOT_OWNED: "NOT_FOUND", CAP_PER_PROPOSAL: "VALIDATION", CAP_DAILY: "VALIDATION" };

export function mapMcpError(e: any) {
  const raw = e?.code || "INTERNAL";
  const code = CODE_MAP[raw] || raw;
  return { code, message: e?.message || "Error interno", status: MCP_ERROR_STATUS[code] || e?.status || 400 };
}
function toolError(e: any) {
  const m = mapMcpError(e);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: m.code, message: m.message }, mode: "paper" }) }], structuredContent: { error: { code: m.code, message: m.message }, mode: "paper" } };
}
function toolOk(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}
function summaryFor(symbol: string, amountUsd: number, quotedOutAtomic: string, minOutAtomic: string, decimals: number, priceImpactPct: number) {
  return `Comprar ${amountUsd} USD de ${symbol}: recibís ≈ ${fmtAtomic(quotedOutAtomic, decimals)} ${symbol} (mínimo garantizado ${fmtAtomic(minOutAtomic, decimals)} ${symbol}), slippage 50 bps, impacto ${Math.abs(priceImpactPct).toFixed(2)}%. La firma es siempre en Onda.`;
}

export function createMcpServer(db: DB, auth: TokenAuth, client: { name?: string; version?: string }, checkQuoteBudget: () => void) {
  const server = new McpServer(
    { name: "onda", title: "Onda — Tu agente inversor", version: config.mcpContractVersion },
    { instructions: "Onda opera solo SPYx, AAPLx y NVDAx desde USDC. Toda operación requiere firma del usuario en la web de Onda (slide-to-sign); un sí en este chat no firma nada. Hoy mode es \"paper\": precios reales de Jupiter, acreditación simulada, sin transacciones on-chain. Usá onda_list_assets para resolver el activo, onda_get_portfolio para saldos y onda_quote_swap + onda_propose_trade para preparar una compra que el usuario firma en Onda." }
  );
  const wrap = (fn: (args: any) => Promise<Record<string, unknown>>) => async (args: any) => { try { return toolOk(await fn(args || {})); } catch (e) { return toolError(e); } };

  server.registerTool("onda_list_assets", {
    title: "Listar activos operables en Onda",
    description: "Lista los activos que Onda puede operar hoy (S&P 500, Apple, NVIDIA como xStocks en Solana) con su símbolo, nombre y mint. Usala para resolver qué activo quiere el usuario antes de cotizar; si el activo pedido no está en esta lista, Onda no lo opera.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(async () => ({ mode: "paper", assets: REGISTRY.map((t) => ({ symbol: t.symbol, name: `${t.human} (${t.name})`, aliases: t.aliases, mint: t.mint, decimals: t.decimals, eligible: true })) })));

  server.registerTool("onda_get_portfolio", {
    title: "Ver portfolio del usuario en Onda",
    description: "Devuelve el portfolio del usuario en Onda: saldo USDC y posiciones, separando saldo real on-chain de posiciones paper (campo `mode` por fila). Usala para responder cuánto tiene el usuario o si le alcanza antes de proponer una compra. Nunca inventes saldos: si no llamaste esta tool, no conocés el portfolio.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(async () => {
    requireScope(auth, "read:portfolio");
    const p: any = await portfolioFor(db, auth.userId);
    const positions = p.positions.map((x: any) => ({ symbol: x.symbol, amount: x.amount, amountAtomic: x.amountAtomic, usdValue: x.usdValue, priceUsd: x.priceUsd, mode: x.mode }));
    const totalPositionsUsd = positions.reduce((a: number, x: any) => a + (x.usdValue || 0), 0);
    return { mode: "paper", walletAddress: p.real?.walletAddress || config.agentWallet, paperWalletId: p.paperWalletId, usdc: { amount: p.paperUsdc, amountAtomic: p.paperUsdcAtomic, mode: "paper" }, positions, totalUsd: (p.paperUsdc || 0) + totalPositionsUsd, real: p.real, label: p.label };
  }));

  server.registerTool("onda_get_limits", {
    title: "Ver límites operativos de Onda",
    description: "Devuelve los límites operativos vigentes de Onda para este usuario: topes por propuesta y por día, slippage aplicado por el backend, impacto máximo permitido, y si la ejecución es paper o real (`mode`). Consultala si el usuario pregunta límites o antes de proponer montos grandes.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(async () => {
    requireScope(auth, "read:portfolio");
    return { mode: "paper", executionEnabled: config.executionEnabled, serverVersion: config.serverVersion, mcpContractVersion: config.mcpContractVersion, perProposalCapUsd: config.paperPerProposalCapUsd, dailyCapUsd: config.paperDailyCapUsd, slippageBps: config.slippageBps, maxPriceImpactPct: 3, confirmationTtlSeconds: Math.round(config.gateTtlMs / 1000), quoteTtlSeconds: 30, scopes: auth.scopes };
  }));

  server.registerTool("onda_quote_swap", {
    title: "Cotizar una compra de xStock en Onda",
    description: "Cotiza en vivo (Jupiter) una compra de un xStock con USDC y persiste la cotización en Onda. Devuelve el `quoteId` y el resumen exacto que el usuario vería al firmar. Cotizar no compra nada ni crea una propuesta: para proponer usá `onda_propose_trade` con este `quoteId`. El slippage y el minimum-out los fija Onda; no podés cambiarlos.",
    inputSchema: { symbol: z.enum(["SPYx", "AAPLx", "NVDAx"]).describe("Símbolo canónico de onda_list_assets"), amountUsd: z.number().positive().describe("Monto en USD humanos, mayor a 0") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, wrap(async ({ symbol, amountUsd }) => {
    requireScope(auth, "quote");
    const wallet = getPaperWallet(db, auth.userId);
    if (!wallet) throw err("VALIDATION", "El usuario todavía no tiene paper wallet en Onda. Tiene que crearla en la web de Onda antes de cotizar.", 422);
    checkQuoteBudget();
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) throw err("VALIDATION", "amountUsd debe ser un número mayor a 0 con hasta 2 decimales", 422);
    const { quote, warning } = await createQuote(db, auth.userId, wallet.id, symbol, amount, "buy");
    const token = bySymbol(symbol)!;
    const quotedOut = Number(quote.quotedOutAtomic) / 10 ** token.decimals;
    const minOut = Number(quote.minOutAtomic) / 10 ** token.decimals;
    return { mode: "paper", quoteId: quote.id, symbol, name: `${token.human} (${token.name})`, amountInUsd: amount, quotedOut, quotedOutAtomic: quote.quotedOutAtomic, minOut, minOutAtomic: quote.minOutAtomic, slippageBps: quote.slippageBps, priceImpactPct: quote.priceImpactPct, priceImpactWarning: Math.abs(Number(quote.priceImpactPct)) > 1, expiresAt: quote.expiresAt, summary: summaryFor(symbol, amount, quote.quotedOutAtomic, quote.minOutAtomic, token.decimals, Number(quote.priceImpactPct)), ...(warning ? { warning } : {}) };
  }));

  server.registerTool("onda_propose_trade", {
    title: "Proponer una compra para firmar en Onda",
    description: "Crea en Onda una propuesta de compra (confirmation en estado pendiente) a partir de un `quoteId` vigente de `onda_quote_swap`, y devuelve el link para que el usuario la firme EN ONDA. Esta tool NUNCA ejecuta ni confirma: sin la firma del usuario en Onda, no se mueve nada. Después de proponer, mostrá el `signingUrl` y esperá; consultá el resultado con `onda_get_confirmation`. Si ya hay una propuesta pendiente del usuario, esta la reemplaza (la anterior queda superseded).",
    inputSchema: { quoteId: z.string().min(1).describe("quoteId vigente devuelto por onda_quote_swap") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(async ({ quoteId }) => {
    requireScope(auth, "propose");
    const wallet = getPaperWallet(db, auth.userId);
    if (!wallet) throw err("VALIDATION", "El usuario todavía no tiene paper wallet en Onda.", 422);
    const proposedVia = { channel: "mcp", tokenId: auth.tokenId, clientName: client.name, clientVersion: client.version };
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(String(quoteId)) as any;
    if (!q || q.user_id !== auth.userId) throw err("NOT_FOUND", "Quote no encontrada", 404);
    const tokenForQuote = byMint(q.output_mint); const symbolForQuote = tokenForQuote?.symbol || "SPYx";
    const sideForQuote = q.output_mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ? "sell" : "buy";
    const conf: any = createConfirmation(db, auth.userId, wallet.id, String(quoteId), `MCP propose vía ${client.name || "cliente MCP"}`, symbolForQuote, sideForQuote as "buy" | "sell", proposedVia);
    const actual: any = db.prepare("SELECT * FROM confirmations WHERE id=?").get(conf.id);
    const token = bySymbol(actual.symbol)!;
    const presentedExpiry = new Date(Date.now() + Math.min(config.gateTtlMs, 30000)).toISOString();
    return { mode: "paper", confirmationId: actual.id, status: "proposed", symbol: actual.symbol, amountInUsd: Number(actual.amount_in_atomic) / 1e6, quotedOut: Number(actual.quoted_out_atomic) / 10 ** token.decimals, quotedOutAtomic: actual.quoted_out_atomic, minOut: Number(actual.min_out_atomic) / 10 ** token.decimals, minOutAtomic: actual.min_out_atomic, slippageBps: actual.slippage_bps, priceImpactPct: actual.price_impact_pct, expiresAt: presentedExpiry, signingUrl: `${config.publicBaseUrl}/confirm/${actual.id}`, summary: summaryFor(actual.symbol, Number(actual.amount_in_atomic) / 1e6, actual.quoted_out_atomic, actual.min_out_atomic, token.decimals, Number(actual.price_impact_pct)) };
  }));

  server.registerTool("onda_get_confirmation", {
    title: "Consultar el estado de una propuesta de Onda",
    description: "Devuelve el estado de una propuesta de Onda por `confirmationId`: `pending` (esperando firma en Onda), `executed`, `rejected`, `expired`, `superseded` o `failed`, con el resultado real cuando ejecutó. Usala para contarle al usuario qué pasó después de que firmó (o no) en Onda. Un estado `pending` no es un éxito ni un fracaso: no afirmes que se compró hasta ver `executed`.",
    inputSchema: { confirmationId: z.string().min(1).describe("confirmationId devuelto por onda_propose_trade") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(async ({ confirmationId }) => {
    requireScope(auth, "read:portfolio");
    const c = db.prepare("SELECT * FROM confirmations WHERE id=?").get(String(confirmationId)) as any;
    if (!c || c.user_id !== auth.userId) throw err("NOT_FOUND", "Confirmation no encontrada", 404);
    const outToken = byMint(c.output_mint) || bySymbol(c.symbol)!;
    const status = ["proposed", "pending_confirmation", "confirmed", "executing"].includes(c.status) ? "pending" : c.status;
    const ex = c.status === "executed" ? db.prepare("SELECT e.actual_out_atomic FROM executions e JOIN orders o ON o.id=e.order_id WHERE o.confirmation_id=?").get(c.id) as any : null;
    const actualAtomic = ex?.actual_out_atomic || (c.status === "executed" ? c.quoted_out_atomic : null);
    return { mode: "paper", confirmationId: c.id, status, ...(c.status === "executing" ? { statusDetail: "executing" } : {}), symbol: c.symbol, amountInUsd: Number(c.amount_in_atomic) / 1e6, quotedOut: Number(c.quoted_out_atomic) / 10 ** outToken.decimals, quotedOutAtomic: c.quoted_out_atomic, minOut: Number(c.min_out_atomic) / 10 ** outToken.decimals, minOutAtomic: c.min_out_atomic, slippageBps: c.slippage_bps, priceImpactPct: c.price_impact_pct, createdAt: c.created_at, expiresAt: c.expires_at, decidedAt: c.decided_at || undefined, executedAt: c.executed_at || undefined, ...(actualAtomic ? { actualOut: Number(actualAtomic) / 10 ** outToken.decimals, actualOutAtomic: actualAtomic } : {}), ...(c.error_code ? { errorCode: c.error_code } : {}) };
  }));

  return server;
}

export function registerMcp(app: FastifyInstance, db: DB, deps: { checkQuoteBudget: () => void; rateLimitMcp: (auth: TokenAuth, tool?: string) => void }) {
  const handler = async (req: any, reply: any) => {
    if (!config.mcpEnabled) return reply.code(404).send({ jsonrpc: "2.0", error: { code: -32004, message: "MCP_DISABLED: Onda MCP está apagado (MCP_ENABLED=false)" }, id: req.body?.id ?? null });
    let auth: TokenAuth;
    try { auth = authenticateToken(db, req.headers.authorization); } catch (e: any) { const m = mapMcpError(e); return reply.code(401).send({ jsonrpc: "2.0", error: { code: -32001, message: `${m.code}: ${m.message}` }, id: req.body?.id ?? null }); }
    const method = req.body?.method;
    const toolName = method === "tools/call" ? req.body?.params?.name : undefined;
    try { deps.rateLimitMcp(auth, toolName); } catch (e: any) { const m = mapMcpError(e); return reply.code(429).send({ jsonrpc: "2.0", error: { code: -32029, message: `${m.code}: ${m.message}` }, id: req.body?.id ?? null }); }
    if (method === "initialize") { req.mcpClient = { name: req.body?.params?.clientInfo?.name, version: req.body?.params?.clientInfo?.version }; mcpClientsByToken.set(auth.tokenId, req.mcpClient); appendAudit(db, null, auth.userId, "mcp_initialize", { tokenId: auth.tokenId, clientName: req.mcpClient.name, clientVersion: req.mcpClient.version, decidedBy: auth.userId }); }
    const client = req.mcpClient || mcpClientsByToken.get(auth.tokenId) || { name: "onda-mcp-client", version: undefined };
    const server = createMcpServer(db, auth, client, deps.checkQuoteBudget);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    try { await server.connect(transport); await transport.handleRequest(req.raw, reply.raw, req.body); }
    finally { await server.close().catch(() => {}); }
  };
  app.post("/mcp", handler);
  app.get("/mcp", async (_req: any, reply: any) => config.mcpEnabled ? reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: servidor stateless, usá POST" }, id: null }) : reply.code(404).send({ jsonrpc: "2.0", error: { code: -32004, message: "MCP_DISABLED" }, id: null }));
  app.delete("/mcp", async (_req: any, reply: any) => reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: servidor stateless" }, id: null }));
}
