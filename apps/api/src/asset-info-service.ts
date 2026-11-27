import { REGISTRY, type TokenInfo } from "./registry.js";
import { jupiterPriceDetail, jupiterTokenMeta } from "./jupiter.js";
import { curatedFor } from "./asset-info.js";

// Vista mergeada por activo (DIN-26): registry + curado (con fuente/asOf) +
// vivo de Jupiter (precio, cambio 24h, volumen, mcap del subyacente vía
// price/v3 stockData). Todo campo vivo es fail-soft a null; nada se inventa.
export interface AssetInfoView {
  symbol: string; name: string; human: string; mint: string; decimals: number;
  mode: "paper"; eligible: true;
  live: {
    priceUsd: number | null; priceChange24hPct: number | null; volume24hUsd: number | null;
    underlyingMarketCapUsd: number | null; tokenMarketCapUsd: number | null;
    holderCount: number | null; circulatingSupply: number | null;
    icon: string | null; isVerified: boolean | null; tags: string[];
    source: "jupiter"; asOf: string;
  };
  curated: ReturnType<typeof curatedFor>;
  token: { standard: string | null; program: string | null; network: "Solana mainnet"; backing: string; backingEn: string };
}

const priceCache = new Map<string, { at: number; view: AssetInfoView }>();
const PRICE_TTL_MS = 60000;

export async function assetInfoFor(token: TokenInfo, now = Date.now()): Promise<AssetInfoView> {
  const hit = priceCache.get(token.symbol);
  if (hit && now - hit.at < PRICE_TTL_MS) return hit.view;
  const curated = curatedFor(token.symbol);
  const detail = await jupiterPriceDetail(token.mint).catch(() => null);
  const meta = await jupiterTokenMeta(token.mint).catch(() => null);
  const view: AssetInfoView = {
    symbol: token.symbol, name: token.name, human: token.human, mint: token.mint, decimals: token.decimals,
    mode: "paper", eligible: true,
    live: {
      priceUsd: detail?.usdPrice ?? null,
      priceChange24hPct: detail?.priceChange24hPct ?? meta?.priceChange24hPct ?? null,
      volume24hUsd: meta?.volume24hUsd ?? null,
      underlyingMarketCapUsd: detail?.underlyingMarketCapUsd ?? null,
      tokenMarketCapUsd: meta?.tokenMarketCapUsd ?? null,
      holderCount: meta?.holderCount ?? null,
      circulatingSupply: meta?.circulatingSupply ?? null,
      icon: meta?.icon ?? null, isVerified: meta?.isVerified ?? null, tags: meta?.tags ?? [],
      source: "jupiter", asOf: new Date(now).toISOString(),
    },
    curated,
    token: {
      standard: meta?.tags?.includes("token-2022") ? "Token-2022" : null,
      program: meta?.tokenProgram ?? null,
      network: "Solana mainnet",
      backing: "xStocks: cada token está respaldado 1:1 por el subyacente, custodiado por Backed Finance.",
      backingEn: "xStocks: each token is backed 1:1 by the underlying, custodied by Backed Finance.",
    },
  };
  // Solo cachear vistas completas (precio + metadata): si Jupiter falló en
  // alguna pata, el próximo pedido reintenta en vez de servir nulls por 60s.
  if (view.live.priceUsd != null && meta != null) priceCache.set(token.symbol, { at: now, view });
  return view;
}

export async function allAssetInfo(): Promise<AssetInfoView[]> {
  return Promise.all(REGISTRY.map((t) => assetInfoFor(t)));
}
