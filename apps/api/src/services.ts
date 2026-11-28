import { createHash } from "node:crypto";
import { appendAudit, hashRecord, id, nowIso, type DB } from "./db.js";
import { config } from "./config.js";
import { REGISTRY, USDC, byMint, bySymbol } from "./registry.js";
import { jupiterOrder, jupiterPrices } from "./jupiter.js";
import { getSolBalance, getTokenBalances, simulate } from "./solana.js";
import { hub } from "./events.js";

export const err = (code: string, message: string, status = 400) => Object.assign(new Error(message), { code, status });

export function paperBalances(db: DB, userId: string, walletId: string) {
  const rows = db.prepare("SELECT kind,symbol,mint,amount_atomic FROM paper_ledger WHERE user_id=? AND wallet_id=?").all(userId, walletId) as any[];
  let usdcAtomic = 0n; const positions = new Map<string, { symbol: string; mint: string; amountAtomic: bigint }>();
  for (const r of rows) {
    const amt = BigInt(r.amount_atomic);
    if (r.kind === "paper_faucet" || r.kind === "paper_sell_credit") usdcAtomic += amt;
    else if (r.kind === "paper_buy_debit") usdcAtomic -= amt;
    else if (r.kind === "paper_buy_credit") { const p = positions.get(r.mint) || { symbol: r.symbol, mint: r.mint, amountAtomic: 0n }; p.amountAtomic += amt; positions.set(r.mint, p); }
    else if (r.kind === "paper_sell_debit") { const p = positions.get(r.mint) || { symbol: r.symbol, mint: r.mint, amountAtomic: 0n }; p.amountAtomic -= amt; positions.set(r.mint, p); }
  }
  return { usdcAtomic, positions: [...positions.values()].filter((p) => p.amountAtomic > 0n) };
}
export function dailyPaperSpentUsd(db: DB, userId: string) {
  const since = new Date(Date.now() - 86400000).toISOString();
  const r = db.prepare("SELECT COALESCE(SUM(amount_usd),0) s FROM paper_ledger WHERE user_id=? AND kind='paper_buy_debit' AND created_at>?").get(userId, since) as any;
  return Number(r.s);
}

export interface WalletProvider { kind: string; createWallet(db: DB, userId: string): any; }
export const PaperWalletProvider: WalletProvider = {
  kind: "paper",
  createWallet(db, userId) {
    const existing = db.prepare("SELECT * FROM wallets WHERE user_id=? AND mode='paper'").get(userId);
    if (existing) return existing;
    const w = { id: id(), user_id: userId, provider: "paper-ledger", mode: "paper", solana_address: null, created_at: nowIso() };
    db.prepare("INSERT INTO wallets VALUES(?,?,?,?,?,?)").run(w.id, w.user_id, w.provider, w.mode, w.solana_address, w.created_at);
    return w;
  },
};
// Seam de custodia (spec 01): Phantom MCP (demo, mismo host) y Phantom Connect (fase 2) implementan esta interfaz.
// MCP no se invoca en este PR: EXECUTION_ENABLED=false y no hay provider falso que pretenda firmar.
export const PhantomMcpWalletProvider: WalletProvider = {
  kind: "phantom-mcp-agent",
  createWallet() { throw err("NOT_IMPLEMENTED", "La wallet real del agente ya existe (DbjQ...pCcu) y es view-only en el MVP; ver GET /system-wallet", 501); },
};

export function getPaperWallet(db: DB, userId: string) { return db.prepare("SELECT * FROM wallets WHERE user_id=? AND mode='paper'").get(userId) as any; }

export async function createQuote(db: DB, userId: string, walletId: string, symbol: string, amountUsd: number, side: "buy" | "sell") {
  const token = bySymbol(symbol); if (!token) throw err("ASSET_NOT_IN_REGISTRY", "Activo fuera del registry");
  if (amountUsd > config.paperPerProposalCapUsd) throw err("CAP_PER_PROPOSAL", `El tope por propuesta paper es ${config.paperPerProposalCapUsd} USD`, 422);
  if (dailyPaperSpentUsd(db, userId) + (side === "buy" ? amountUsd : 0) > config.paperDailyCapUsd) throw err("CAP_DAILY", `El tope diario paper es ${config.paperDailyCapUsd} USD`, 422);
  const bal = paperBalances(db, userId, walletId);
  if (side === "buy" && bal.usdcAtomic < BigInt(Math.round(amountUsd * 1e6))) throw err("INSUFFICIENT_PAPER_BALANCE", `No te alcanza el saldo paper: tenés ${(Number(bal.usdcAtomic) / 1e6).toFixed(2)} USDC paper`, 422);
  if (side === "sell") {
    const priceMap = await jupiterPrices([token.mint]);
    const price = priceMap[token.mint]; if (!price) throw err("JUPITER_UNAVAILABLE", "Jupiter no devolvió precio en vivo", 502);
    const held = bal.positions.find((p) => p.mint === token.mint);
    const heldUsd = held ? (Number(held.amountAtomic) / 10 ** token.decimals) * price : 0;
    if (!held || heldUsd < amountUsd - 1e-9) throw err("INSUFFICIENT_POSITION", `No tenés ${symbol} paper suficiente (tenés ≈ ${heldUsd.toFixed(2)} USD)`, 422);
  }
  const inMint = side === "buy" ? USDC.mint : token.mint;
  const outMint = side === "buy" ? token.mint : USDC.mint;
  let amountAtomic: string;
  if (side === "buy") amountAtomic = String(Math.round(amountUsd * 1e6));
  else {
    const priceMap = await jupiterPrices([token.mint]); const price = priceMap[token.mint];
    amountAtomic = String(Math.floor((amountUsd / price) * 10 ** token.decimals));
  }
  // Quote REAL de Jupiter en cada pedido (sin mocks, sin fallback). taker = agent wallet.
  const order = await jupiterOrder(inMint, outMint, amountAtomic, config.agentWallet, config.slippageBps);
  const impact = Math.abs(Number(order.priceImpactPct));
  if (impact > 3) throw err("PRICE_IMPACT_TOO_HIGH", `El impacto en el precio es ${impact.toFixed(2)}% (>3%): la propuesta se rechaza antes del gate`, 422);
  const expiresAt = new Date(Date.now() + 30000).toISOString();
  const q = { id: id(), userId, walletId, inputMint: inMint, outputMint: outMint, amountInAtomic: order.inAmount, quotedOutAtomic: order.outAmount, minOutAtomic: order.otherAmountThreshold, slippageBps: config.slippageBps, priceImpactPct: Number(order.priceImpactPct), requestId: order.requestId, transaction: order.transaction || null, expiresAt, createdAt: nowIso() };
  db.prepare("INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(q.id, userId, walletId, q.inputMint, q.outputMint, q.amountInAtomic, q.quotedOutAtomic, q.minOutAtomic, q.slippageBps, q.priceImpactPct, q.requestId, q.transaction, q.expiresAt, null, q.createdAt);
  return { quote: q, order, warning: impact > 1 ? `Ojo: el impacto en el precio es ${impact.toFixed(2)}%` : null };
}

export function supersedePending(db: DB, userId: string, exceptId?: string) {
  const rows = db.prepare("SELECT id FROM confirmations WHERE user_id=? AND status IN ('proposed','pending_confirmation')").all(userId) as any[];
  for (const r of rows) { if (r.id === exceptId) continue; db.prepare("UPDATE confirmations SET status='superseded' WHERE id=?").run(r.id); appendAudit(db, r.id, userId, "superseded", {}); hub.confirmation(userId, db.prepare("SELECT * FROM confirmations WHERE id=?").get(r.id)); }
}

export function createConfirmation(db: DB, userId: string, walletId: string, quoteId: string, rawIntent: string, symbol: string, side: "buy" | "sell", proposedVia?: { channel: string; tokenId?: string; clientName?: string; clientVersion?: string } | null) {
  const existing = db.prepare("SELECT * FROM confirmations WHERE quote_id=?").get(quoteId) as any;
  if (existing) { if (existing.user_id !== userId) throw err("QUOTE_NOT_OWNED", "Quote ajena", 404); return existing; }
  const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(quoteId) as any;
  if (!q || q.user_id !== userId) throw err("QUOTE_NOT_FOUND", "Quote no encontrada", 404);
  if (q.consumed_at) throw err("QUOTE_CONSUMED", "La quote ya fue consumida", 409);
  if (new Date(q.expires_at).getTime() < Date.now()) throw err("QUOTE_EXPIRED", "La quote venció", 409);
  supersedePending(db, userId);
  const cId = id(); const created = nowIso();
  const last = db.prepare("SELECT record_hash FROM confirmations ORDER BY rowid DESC LIMIT 1").get() as any;
  const prev = last?.record_hash || "GENESIS";
  const rec = hashRecord(prev, JSON.stringify({ cId, userId, quoteId, created }));
  db.prepare("INSERT INTO confirmations(id,user_id,wallet_id,quote_id,mode,status,raw_intent,llm_summary,input_mint,output_mint,symbol,side,amount_in_atomic,quoted_out_atomic,min_out_atomic,slippage_bps,price_impact_pct,error_code,prev_hash,record_hash,lease_expires_at,created_at,presented_at,decided_at,decided_by,executed_at,expires_at,proposed_via) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(cId, userId, walletId, quoteId, "paper", "proposed", rawIntent, `${side === "buy" ? "Comprar" : "Vender"} ${symbol}`, q.input_mint, q.output_mint, symbol, side, q.amount_in_atomic, q.quoted_out_atomic, q.min_out_atomic, q.slippage_bps, q.price_impact_pct, null, prev, rec, null, created, null, null, null, null, null, proposedVia ? JSON.stringify(proposedVia) : null);
  db.prepare("UPDATE quotes SET consumed_at=? WHERE id=?").run(created, quoteId);
  appendAudit(db, cId, userId, "created", { quoteId, symbol, side, ...(proposedVia ? { proposedVia } : {}) });
  const row = db.prepare("SELECT * FROM confirmations WHERE id=?").get(cId) as any;
  hub.confirmation(userId, row);
  return row;
}

export function expireStaleConfirmations(db: DB, now = Date.now()) {
  const rows = db.prepare("SELECT * FROM confirmations WHERE status='pending_confirmation' AND expires_at IS NOT NULL AND expires_at<?").all(new Date(now).toISOString()) as any[];
  for (const c of rows) {
    db.prepare("UPDATE confirmations SET status='expired' WHERE id=? AND status='pending_confirmation'").run(c.id);
    appendAudit(db, c.id, c.user_id, "expired", {});
    hub.confirmation(c.user_id, { ...c, status: "expired" });
  }
  return rows.length;
}

export function effectiveExpiry(c: any) {
  if (!c.presented_at) return null;
  const gate = new Date(c.presented_at).getTime() + config.gateTtlMs;
  // quote expiry: la quote ya venció al crear; usamos ventana de quote de 30s desde presentedAt como techo visible único (min TTL, quote)
  const quoteExp = new Date(c.presented_at).getTime() + 30000;
  return new Date(Math.min(gate, quoteExp)).toISOString();
}

export async function executeConfirmation(db: DB, confirmationId: string) {
  // Lease atómico: solo un worker pasa confirmed -> executing
  const claim = db.prepare("UPDATE confirmations SET status='executing', lease_expires_at=? WHERE id=? AND status='confirmed'").run(new Date(Date.now() + 60000).toISOString(), confirmationId) as any;
  if (claim.changes === 0) return db.prepare("SELECT * FROM confirmations WHERE id=?").get(confirmationId);
  const c = db.prepare("SELECT * FROM confirmations WHERE id=?").get(confirmationId) as any;
  appendAudit(db, c.id, c.user_id, "executing", {});
  const orderRowId = id();
  const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(c.quote_id) as any;
  db.prepare("INSERT INTO orders VALUES(?,?,?,?,?,?,?,?)").run(orderRowId, c.id, "jupiter", q?.request_id || null, null, q ? JSON.stringify({ requestId: q.request_id }) : null, "pending", nowIso());
  const fail = (code: string, detail: string, simJson?: string, simMode?: string) => {
    db.prepare("INSERT INTO executions VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id(), orderRowId, "paper", null, null, null, null, detail, simJson || null, simMode || null, nowIso());
    db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(orderRowId);
    db.prepare("UPDATE confirmations SET status='failed', error_code=?, executed_at=? WHERE id=?").run(code, nowIso(), c.id);
    appendAudit(db, c.id, c.user_id, "failed", { code, detail });
    const failed = db.prepare("SELECT * FROM confirmations WHERE id=?").get(c.id) as any;
    hub.confirmation(c.user_id, failed);
    return failed;
  };
  if (config.executionEnabled) return fail("EXECUTION_NOT_IMPLEMENTED_IN_MVP", "EXECUTION_ENABLED=true pero el path real (Jupiter tx + firma MCP + reconciliación) no se habilita en v0.1.0");
  if (!q?.transaction_b64) return fail("NO_TRANSACTION", "La quote no trajo transacción de Jupiter para simular");
  // 1) Simulación fiel con taker = agent wallet (sin fondeo): se registra tal cual devuelve el RPC.
  let agentSim; try { agentSim = await simulate(q.transaction_b64); } catch (e: any) { return fail("SIMULATION_RPC_ERROR", `La simulación RPC falló: ${e.message}`, undefined, "agent-wallet"); }
  appendAudit(db, c.id, c.user_id, "simulation_agent_wallet", { err: agentSim.err, slot: agentSim.slot, mode: "agent-wallet" });
  let creditedSim = agentSim; let simMode = "agent-wallet";
  if (agentSim.err) {
    // Spec 01 §4-5: sustitución documentada. El RPC público no soporta accounts-replacement de saldos SPL,
    // por lo que se prueba la misma ruta Jupiter con un taker fondeado (proof taker): valida ruta/instrucciones,
    // NO valida fondos del agente. Queda registrado como paper-substituted. Si esto también falla, no se acredita.
    try {
      const proofOrder = await jupiterOrder(c.input_mint, c.output_mint, c.amount_in_atomic, config.simulationProofTaker, config.slippageBps);
      if (!proofOrder.transaction) return fail("SIMULATION_FAILED", "Ni la wallet del agente ni la prueba de ruta devolvieron transacción simulable", JSON.stringify({ agentSim }), "paper-substituted");
      const proofSim = await simulate(proofOrder.transaction);
      appendAudit(db, c.id, c.user_id, "simulation_paper_substituted", { err: proofSim.err, slot: proofSim.slot, proofRequestId: proofOrder.requestId, mode: "paper-substituted" });
      if (proofSim.err) return fail("SIMULATION_FAILED", `La ruta no simuló limpia: ${JSON.stringify(proofSim.err)}`, JSON.stringify({ agentSim, proofSim }), "paper-substituted");
      creditedSim = proofSim; simMode = "paper-substituted";
    } catch (e: any) { return fail("SIMULATION_FAILED", `Sustitución paper falló: ${e.message}`, JSON.stringify({ agentSim }), "paper-substituted"); }
  }
  // 2) Acreditar SOLO tras simulación OK. Monto = outAmount de la quote persistida, "simulado a quote".
  const tokenOut = byMint(c.output_mint)!; const tokenIn = byMint(c.input_mint)!;
  const ts = nowIso();
  if (c.side === "sell") {
    db.prepare("INSERT INTO paper_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id(), c.user_id, c.wallet_id, "paper_sell_debit", c.symbol, c.input_mint, "-" + c.amount_in_atomic, null, c.id + ":debit", q.request_id, ts);
    // reusa confirmation_id unique: debit usa sufijo, credit usa el id real
    db.prepare("INSERT INTO paper_ledger(id,user_id,wallet_id,kind,symbol,mint,amount_atomic,amount_usd,confirmation_id,simulation_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id(), c.user_id, c.wallet_id, "paper_sell_credit", "USDC", USDC.mint, c.quoted_out_atomic, Number(c.quoted_out_atomic) / 1e6, c.id, q.request_id, ts);
  } else {
    db.prepare("INSERT INTO paper_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id(), c.user_id, c.wallet_id, "paper_buy_debit", "USDC", USDC.mint, c.amount_in_atomic, Number(c.amount_in_atomic) / 1e6, c.id + ":debit", q.request_id, ts);
    db.prepare("INSERT INTO paper_ledger(id,user_id,wallet_id,kind,symbol,mint,amount_atomic,amount_usd,confirmation_id,simulation_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id(), c.user_id, c.wallet_id, "paper_buy_credit", c.symbol, c.output_mint, c.quoted_out_atomic, null, c.id, q.request_id, ts);
  }
  db.prepare("INSERT INTO executions VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id(), orderRowId, "paper", null, creditedSim.slot || null, null, c.quoted_out_atomic, null, JSON.stringify({ err: creditedSim.err, logsTail: creditedSim.logs.slice(-6), agentWalletErr: agentSim.err }), simMode, ts);
  db.prepare("UPDATE orders SET status='confirmed' WHERE id=?").run(orderRowId);
  db.prepare("UPDATE confirmations SET status='executed', executed_at=? WHERE id=?").run(ts, c.id);
  appendAudit(db, c.id, c.user_id, "executed", { simulationMode: simMode, creditedAtomic: c.quoted_out_atomic });
  const executed = db.prepare("SELECT * FROM confirmations WHERE id=?").get(c.id) as any;
  hub.confirmation(c.user_id, executed);
  return executed;
}

export async function portfolioFor(db: DB, userId: string) {
  const wallet = getPaperWallet(db, userId);
  const bal = wallet ? paperBalances(db, userId, wallet.id) : { usdcAtomic: 0n, positions: [] as any[] };
  const mints = [USDC.mint, ...bal.positions.map((p: any) => p.mint)];
  const prices = await jupiterPrices(mints);
  const positions = bal.positions.map((p: any) => { const t = byMint(p.mint)!; const amount = Number(p.amountAtomic) / 10 ** t.decimals; return { symbol: p.symbol, mint: p.mint, amount, amountAtomic: p.amountAtomic.toString(), usdValue: prices[p.mint] ? amount * prices[p.mint] : null, priceUsd: prices[p.mint] || null, mode: "paper" as const }; });
  // Balances reales on-chain de la agent wallet (live RPC)
  let real: any = null;
  try {
    const solLamports = await getSolBalance(config.agentWallet);
    const tokens = await getTokenBalances(config.agentWallet);
    real = { walletAddress: config.agentWallet, sol: solLamports / 1e9, tokens: tokens.map((t) => ({ ...t, symbol: byMint(t.mint)?.symbol || t.mint })), mode: "real" };
  } catch (e: any) { real = { walletAddress: config.agentWallet, error: e.message, mode: "real" }; }
  return { mode: "paper" as const, paperWalletId: wallet?.id || null, paperUsdc: Number(bal.usdcAtomic) / 1e6, paperUsdcAtomic: bal.usdcAtomic.toString(), positions, prices, real, label: "Modo demo paper — precios reales, ejecución simulada" };
}
