// Info curada por activo (DIN-26, fase A): solo campos lentos y verificables
// (emisor, subyacente, fecha IPO/inception, sector, exchange, expense ratio).
// Cada entrada cita fuente + fecha de verificación. Los campos rápidos
// (precio, market cap, volumen) NUNCA viven acá: vienen de Jupiter en vivo
// o son null. Fechas verificadas 2026-11-27 contra las fuentes citadas.
export interface CuratedAssetInfo {
  issuer: string;
  underlyingTicker: string;
  underlyingName: string;
  assetType: "etf" | "stock";
  exchange: string;
  sector: string;
  inceptionDate: string; // IPO (acciones) o inception (ETF), ISO date
  inceptionLabel: "ipo" | "inception";
  expenseRatioPct: number | null; // solo ETF; null en acciones
  dividendYieldPct: number | null; // lento pero no estático: ver asOf; null si no verificado
  description: string;
  descriptionEn: string;
  sourceName: string;
  sourceUrl: string;
  asOf: string;
}

export const CURATED_ASSET_INFO: Record<string, CuratedAssetInfo> = {
  SPYx: {
    issuer: "Backed Finance (xStocks)",
    underlyingTicker: "SPY",
    underlyingName: "SPDR S&P 500 ETF Trust",
    assetType: "etf",
    exchange: "NYSE Arca",
    sector: "Broad market equity index (S&P 500)",
    inceptionDate: "1993-01-22",
    inceptionLabel: "inception",
    expenseRatioPct: 0.0945,
    dividendYieldPct: null,
    description: "ETF que replica el índice S&P 500 (las 500 mayores empresas listadas en EE. UU.). SPYx es el token xStocks respaldado 1:1 por SPY.",
    descriptionEn: "ETF tracking the S&P 500 index (the 500 largest US-listed companies). SPYx is the xStocks token backed 1:1 by SPY.",
    sourceName: "State Street SPDR / xStocks",
    sourceUrl: "https://www.ssga.com/us/en/intermediary/etfs/spdr-sp-500-etf-trust-spy",
    asOf: "2026-11-27",
  },
  AAPLx: {
    issuer: "Backed Finance (xStocks)",
    underlyingTicker: "AAPL",
    underlyingName: "Apple Inc.",
    assetType: "stock",
    exchange: "NASDAQ",
    sector: "Technology — Consumer electronics & services",
    inceptionDate: "1980-12-12",
    inceptionLabel: "ipo",
    expenseRatioPct: null,
    dividendYieldPct: null,
    description: "Apple diseña y vende iPhone, Mac, iPad, servicios (App Store, iCloud) y accesorios. AAPLx es el token xStocks respaldado 1:1 por AAPL.",
    descriptionEn: "Apple designs and sells iPhone, Mac, iPad, services (App Store, iCloud) and accessories. AAPLx is the xStocks token backed 1:1 by AAPL.",
    sourceName: "Nasdaq / Apple Investor Relations",
    sourceUrl: "https://www.nasdaq.com/market-activity/stocks/aapl",
    asOf: "2026-11-27",
  },
  NVDAx: {
    issuer: "Backed Finance (xStocks)",
    underlyingTicker: "NVDA",
    underlyingName: "NVIDIA Corporation",
    assetType: "stock",
    exchange: "NASDAQ",
    sector: "Technology — Semiconductors (GPU / AI accelerators)",
    inceptionDate: "1999-01-22",
    inceptionLabel: "ipo",
    expenseRatioPct: null,
    dividendYieldPct: null,
    description: "NVIDIA diseña GPUs y aceleradores de IA para data centers, gaming y automoción. NVDAx es el token xStocks respaldado 1:1 por NVDA.",
    descriptionEn: "NVIDIA designs GPUs and AI accelerators for data centers, gaming and automotive. NVDAx is the xStocks token backed 1:1 by NVDA.",
    sourceName: "Nasdaq / NVIDIA Investor Relations",
    sourceUrl: "https://www.nasdaq.com/market-activity/stocks/nvda",
    asOf: "2026-11-27",
  },
};

export const curatedFor = (symbol: string): CuratedAssetInfo | null => CURATED_ASSET_INFO[symbol] ?? null;
