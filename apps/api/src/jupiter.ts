const BASE = "https://api.jup.ag";
export interface JupiterOrder { requestId: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string; priceImpactPct: string; slippageBps: number; transaction?: string; expireAt?: string; routePlan: unknown[]; raw: any; }
export async function jupiterOrder(inputMint: string, outputMint: string, amountAtomic: string, taker: string, slippageBps: number): Promise<JupiterOrder> {
  const url = `${BASE}/swap/v2/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountAtomic}&slippageBps=${slippageBps}&taker=${taker}`;
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`Jupiter /order HTTP ${res.status}`), { code: "JUPITER_UNAVAILABLE" });
  const j: any = await res.json();
  if (j.error || !j.outAmount) throw Object.assign(new Error(j.error || "Jupiter sin quote"), { code: "JUPITER_NO_ROUTE" });
  return { requestId: j.requestId, inputMint: j.inputMint, outputMint: j.outputMint, inAmount: j.inAmount, outAmount: j.outAmount, otherAmountThreshold: j.otherAmountThreshold, priceImpactPct: j.priceImpactPct, slippageBps, transaction: j.transaction, expireAt: j.expireAt, routePlan: j.routePlan || [], raw: j };
}
export async function jupiterPrices(mints: string[]): Promise<Record<string, number>> {
  const res = await fetch(`${BASE}/price/v3?ids=${mints.join(",")}`);
  if (!res.ok) throw Object.assign(new Error(`Jupiter price HTTP ${res.status}`), { code: "JUPITER_UNAVAILABLE" });
  const j: any = await res.json(); const out: Record<string, number> = {};
  for (const m of mints) if (j[m]?.usdPrice) out[m] = j[m].usdPrice;
  return out;
}
export interface JupiterPriceDetail { usdPrice: number | null; priceChange24hPct: number | null; underlyingMarketCapUsd: number | null; underlyingPriceUsd: number | null }
const priceCache = new Map<string, { at: number; detail: JupiterPriceDetail }>();
// price/v3 crudo (cache 60s): expone stockData.mcap del subyacente xStocks.
export async function jupiterPriceDetail(mint: string): Promise<JupiterPriceDetail> {
  const hit = priceCache.get(mint);
  if (hit && Date.now() - hit.at < 60000) return hit.detail;
  const empty: JupiterPriceDetail = { usdPrice: null, priceChange24hPct: null, underlyingMarketCapUsd: null, underlyingPriceUsd: null };
  let detail = empty;
  try {
    const res = await fetch(`${BASE}/price/v3?ids=${mint}`);
    if (res.ok) {
      const j: any = await res.json(); const d = j[mint];
      if (d) detail = {
        usdPrice: typeof d.usdPrice === "number" ? d.usdPrice : null,
        priceChange24hPct: typeof d.priceChange24h === "number" ? d.priceChange24h : null,
        underlyingMarketCapUsd: typeof d.stockData?.mcap === "number" ? d.stockData.mcap : null,
        underlyingPriceUsd: typeof d.stockData?.price === "number" ? d.stockData.price : null,
      };
    }
  } catch { detail = empty; }
  // No cachear el vacío: un fallo transitorio de Jupiter no debe envenenar 60s.
  if (detail.usdPrice != null) priceCache.set(mint, { at: Date.now(), detail });
  return detail;
}
export interface JupiterTokenMeta {
  name: string | null; symbol: string | null; icon: string | null; decimals: number | null;
  isVerified: boolean; tags: string[]; tokenProgram: string | null;
  holderCount: number | null; circulatingSupply: number | null; tokenMarketCapUsd: number | null;
  priceChange24hPct: number | null; volume24hUsd: number | null;
}
const metaCache = new Map<string, { at: number; meta: JupiterTokenMeta | null }>();
const META_TTL_MS = 60000;
// Metadata del token en Jupiter (tokens/v2/search por mint exacto). Cache 60s,
// fail-soft a null: la info curada y el precio siguen sin depender de esto.
export async function jupiterTokenMeta(mint: string): Promise<JupiterTokenMeta | null> {
  const hit = metaCache.get(mint);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.meta;
  let meta: JupiterTokenMeta | null = null;
  try {
    const res = await fetch(`${BASE}/tokens/v2/search?query=${mint}`);
    if (res.ok) {
      const arr: any[] = await res.json();
      const t = arr.find((x) => x.id === mint);
      if (t) {
        const s24 = t.stats24h || {};
        meta = {
          name: t.name ?? null, symbol: t.symbol ?? null, icon: t.icon ?? null,
          decimals: typeof t.decimals === "number" ? t.decimals : null,
          isVerified: !!t.isVerified, tags: Array.isArray(t.tags) ? t.tags : [],
          tokenProgram: t.tokenProgram ?? null,
          holderCount: typeof t.holderCount === "number" ? t.holderCount : null,
          circulatingSupply: typeof t.circSupply === "number" ? t.circSupply : null,
          tokenMarketCapUsd: typeof t.mcap === "number" ? t.mcap : null,
          priceChange24hPct: typeof s24.priceChange === "number" ? s24.priceChange : null,
          volume24hUsd: [s24.buyVolume, s24.sellVolume].every((v) => typeof v === "number") ? s24.buyVolume + s24.sellVolume : null,
        };
      }
    }
  } catch { meta = null; }
  if (meta) metaCache.set(mint, { at: Date.now(), meta });
  return meta;
}
export async function verifyRegistryToken(mint: string): Promise<{ verified: boolean; symbol?: string; decimals?: number }> {
  const res = await fetch(`${BASE}/tokens/v2/search?query=${mint}`);
  if (!res.ok) return { verified: false };
  const arr: any[] = await res.json();
  const t = arr.find((x) => x.id === mint);
  return t ? { verified: true, symbol: t.symbol, decimals: t.decimals } : { verified: false };
}
