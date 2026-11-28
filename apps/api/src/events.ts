import type { DB } from "./db.js";
import { REGISTRY } from "./registry.js";
import { jupiterPriceDetail } from "./jupiter.js";

// Roadmap 1.1 (DIN-35): Server-Sent Events. Un único stream autenticado por
// la sesión web (cookie). Los eventos por-usuario salen SOLO de este hub y
// se rutean por userId: un cliente jamás recibe eventos de otro usuario.
export interface QuoteTick { symbol: string; mint: string; priceUsd: number | null; priceChange24hPct: number | null; asOf: string }
export interface ConfirmationEvent { id: string; status: string; symbol: string; side: string; mode: string }
type Client = { userId: string; send: (event: string, data: unknown) => void };

export class EventHub {
  private clients = new Set<Client>();
  add(userId: string, send: Client["send"]): () => void {
    const c: Client = { userId, send };
    this.clients.add(c);
    return () => { this.clients.delete(c); };
  }
  get size() { return this.clients.size; }
  emitToUser(userId: string, event: string, data: unknown) {
    for (const c of this.clients) if (c.userId === userId) { try { c.send(event, data); } catch { this.clients.delete(c); } }
  }
  emitAll(event: string, data: unknown) {
    for (const c of this.clients) { try { c.send(event, data); } catch { this.clients.delete(c); } }
  }
  confirmation(userId: string, c: any) {
    if (!c) return;
    const payload: ConfirmationEvent = { id: c.id, status: c.status, symbol: c.symbol, side: c.side, mode: c.mode };
    this.emitToUser(userId, "confirmation", payload);
    // Tras una ejecución el portfolio cambió: señal liviana, la UI refetchea
    // /portfolio + /transactions (snapshot autoritativo, sin duplicar lógica).
    if (c.status === "executed" || c.status === "failed") this.emitToUser(userId, "portfolio", { reason: "confirmation", confirmationId: c.id, status: c.status });
  }
}

export const hub = new EventHub();

// Snapshot de precios desde el MISMO path de Jupiter (price/v3 con cache de
// 60s en jupiterPriceDetail): no hay una segunda fuente ni llamadas nuevas
// por cliente. Los mints salen del registry cerrado.
export async function quoteSnapshot(now = Date.now()): Promise<QuoteTick[]> {
  const asOf = new Date(now).toISOString();
  return Promise.all(REGISTRY.map(async (t) => {
    const d = await jupiterPriceDetail(t.mint).catch(() => null);
    return { symbol: t.symbol, mint: t.mint, priceUsd: d?.usdPrice ?? null, priceChange24hPct: d?.priceChange24hPct ?? null, asOf };
  }));
}

export function confirmationPayload(db: DB, id: string) {
  return db.prepare("SELECT id,status,symbol,side,mode,user_id FROM confirmations WHERE id=?").get(id) as any;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
// Tick de precios: 12s entre snapshots, solo si hay clientes conectados.
// jupiterPriceDetail cachea 60s por mint, así que Jupiter ve como máximo
// 1 request por mint/minuto sin importar cuántos clientes haya.
export function startPriceTicker(intervalMs = 12000, snapshot: () => Promise<QuoteTick[]> = () => quoteSnapshot()) {
  if (tickTimer) return () => stopPriceTicker();
  tickTimer = setInterval(async () => {
    if (hub.size === 0) return;
    try { hub.emitAll("quotes", { items: await snapshot() }); } catch { /* Jupiter fail-soft: el próximo tick reintenta */ }
  }, intervalMs);
  if (typeof (tickTimer as any).unref === "function") (tickTimer as any).unref();
  return () => stopPriceTicker();
}
export function stopPriceTicker() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

