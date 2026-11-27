// Token registry — única fuente de mints (spec 02). Sin override por env: cambiar un mint exige PR.
export interface TokenInfo { symbol: string; name: string; human: string; mint: string; decimals: number; aliases: string[]; }
export const USDC: TokenInfo = { symbol: "USDC", name: "USD Coin", human: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, aliases: ["USDC", "USD Coin"] };
export const REGISTRY: TokenInfo[] = [
  { symbol: "SPYx", name: "SP500 xStock", human: "S&P 500", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", decimals: 8, aliases: ["S&P 500", "SP500", "S&P"] },
  { symbol: "AAPLx", name: "Apple xStock", human: "Apple", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8, aliases: ["Apple", "AAPL"] },
  { symbol: "NVDAx", name: "NVIDIA xStock", human: "Nvidia", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", decimals: 8, aliases: ["NVIDIA", "NVDA"] },
];
export const byMint = (m: string) => [USDC, ...REGISTRY].find((t) => t.mint === m);
export const bySymbol = (s: string) => REGISTRY.find((t) => t.symbol === s);
