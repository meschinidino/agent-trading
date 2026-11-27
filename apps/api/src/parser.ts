// Parser determinístico (spec 03): backend es la autoridad. Alias map cerrado, números es-AR.
export interface ParsedIntent { kind: "buy" | "sell" | "portfolio" | "balance" | "clarify" | "unknown" | "out_of_registry"; symbol?: string; amountUsd?: number; needsAmount?: boolean; needsAsset?: boolean; rawAsset?: string; }
const ALIASES: [RegExp, string][] = [
  [/\bs\s*&\s*p\s*500\b|\bsp500\b|\bspy\b|el [ií]ndice/i, "SPYx"],
  [/\bapple\b|\baapl\b|la manzana/i, "AAPLx"],
  [/\bnvidia\b|\bnvda\b/i, "NVDAx"],
];
export function parseAmountEsAr(text: string): number | null {
  // Rechaza >2 decimales
  const m = text.replace(/\$/g, " ").match(/(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)/);
  if (!m) {
    if (/\bcien\b/i.test(text)) return 100;
    if (/\bmil\b/i.test(text)) return 1000;
    return null;
  }
  const raw = m[1];
  const decPart = raw.includes(",") ? raw.split(",")[1] : "";
  if (decPart.length > 2) throw Object.assign(new Error("Monto con más de 2 decimales"), { code: "AMOUNT_TOO_PRECISE" });
  const normalized = raw.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
export function parseIntent(raw: string): ParsedIntent {
  const text = raw.trim();
  if (/cu[aá]nto tengo|saldo|cuanto tengo/i.test(text)) return { kind: "balance" };
  if (/portfolio|portafolio|posiciones|mis inversiones/i.test(text)) return { kind: "portfolio" };
  let symbol: string | undefined;
  for (const [re, sym] of ALIASES) if (re.test(text)) { symbol = sym; break; }
  const isSell = /\bvende|\bvender|\bvend[eé]\b/i.test(text);
  const isBuy = /\binvert[ií]|\bcompr|\bmetele|\bpone|\bponé/i.test(text);
  // Activo fuera del registry: palabra capitalizada desconocida tras preposición (heurística conservadora)
  if (!symbol && (isBuy || isSell)) {
    const known = /tesla|bitcoin|btc|ethereum|solana/i.test(text);
    if (known) return { kind: "out_of_registry", rawAsset: text.match(/tesla|bitcoin|btc|ethereum|solana/i)![0] };
  }
  if (isSell || isBuy) {
    let amount: number | null = null;
    try { amount = parseAmountEsAr(text); } catch (e) { throw e; }
    if (!symbol) return { kind: "clarify", needsAsset: true };
    if (amount == null) return { kind: "clarify", needsAmount: true, symbol };
    return { kind: isSell ? "sell" : "buy", symbol, amountUsd: amount };
  }
  if (symbol) return { kind: "clarify", needsAmount: true, symbol };
  return { kind: "unknown" };
}
export const fmtAtomic = (atomic: string, decimals: number) => { const n = Number(atomic) / 10 ** decimals; return n.toLocaleString("es-AR", { maximumFractionDigits: 6 }); };
export const toAtomicUsd = (usd: number) => String(Math.round(usd * 1e6));
