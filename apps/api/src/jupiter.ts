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
export async function verifyRegistryToken(mint: string): Promise<{ verified: boolean; symbol?: string; decimals?: number }> {
  const res = await fetch(`${BASE}/tokens/v2/search?query=${mint}`);
  if (!res.ok) return { verified: false };
  const arr: any[] = await res.json();
  const t = arr.find((x) => x.id === mint);
  return t ? { verified: true, symbol: t.symbol, decimals: t.decimals } : { verified: false };
}
