// Onda display-language seed (v0.3.2): UI chrome only.
// Parser/chat understanding stays es-AR (see parser.ts / apps/api) — `en`
// translates display strings and number formatting, it does NOT make the
// agent understand English orders. Precedence: ?lang= (persisted) >
// localStorage onda-app-lang > browser language > es-AR default.
// The live product defaults to Spanish today; English is opt-in via the
// switcher, ?lang=en, or an English browser locale.
export type Lang = "es" | "en";
const KEY = "onda-app-lang";
function detect(): Lang {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q === "en" || q === "es") { localStorage.setItem(KEY, q); return q; }
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "es") return saved;
  } catch { /* storage unavailable */ }
  return (navigator.language || "es").toLowerCase().startsWith("en") ? "en" : "es";
}
export const LANG: Lang = detect();
export const IS_EN = LANG === "en";
export const LOCALE = IS_EN ? "en-US" : "es-AR";
export function setLang(l: Lang) {
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  const u = new URL(location.href); u.searchParams.set("lang", l);
  location.href = u.toString();
}
// Chat orders are always composed in es-AR: the parser only understands
// Rioplatense phrasing today. Display labels may be English; sent text is not.
export const orderText = (usd: number, name: string) => `Invertí ${usd} USD en ${name}`;
const ES = {
  // header / static chrome (mirrors index.html data-i18n)
  tagline: "· Tu agente inversor", livePrices: "Precios en vivo · Jupiter", paperBadge: "Paper · sin plata real", logout: "Salir",
  authTitle: "Entrá para empezar", authBody: "Creá tu cuenta demo. No hay fondos reales ni claves: es un ledger paper con precios de verdad, de Jupiter en vivo.",
  email: "Email", password: "Contraseña", passPh: "Mínimo 8 caracteres", login: "Entrar", register: "Crear cuenta",
  composerPh: "Pedile algo a tu agente…", composerHint: "El agente propone y vos firmás. Nada se ejecuta sin tu gesto. Tope paper: US$ 25 por propuesta · US$ 50 por día.",
  totalLabel: "Valor total · paper", sparkCap: "Valor en esta sesión · precios en vivo",
  positions: "Posiciones", watch: "Para mirar", history: "Historial", quickAmounts: "Montos rápidos", tickerAria: "Precios en vivo de Jupiter",
  // dynamic chrome
  typing: "El agente está cotizando…", livePriceJupiter: "precio en vivo de Jupiter", livePrice: "precio en vivo", noPrice: "sin precio",
  held: "tenés", underlying: "subyacente", fromUsd: "desde US$ 1",
  totalDetailEmpty: "Entrá para ver tu portfolio paper", totalDetailAllUsdc: "Todo en USDC, listo para tu primera compra",
  totalDetailPos: (usdc: string, n: number) => `${usdc} en USDC · ${n} ${n === 1 ? "posición valuada" : "posiciones valuadas"} en vivo`,
  usdcAvailable: "USDC disponible", noWalletYet: "Todavía no tenés wallet paper",
  walletNoteAnon: "Tu wallet paper es un ledger demo, sin claves ni fondos reales. Los precios vienen de Jupiter en vivo.",
  walletNoteHas: "Ledger demo, sin claves ni fondos reales. Cargale USDC paper para operar.",
  walletNoteCreate: "Creala para cargar USDC paper y pedir tu primera cotización.",
  createWallet: "Crear wallet paper", deposit: "Cargar USDC paper", depAmtAria: "Monto a cargar en USD",
  emptyPosAnonTitle: "Entrá para ver tus posiciones", emptyPosAnon: "Cuando tengas wallet y posiciones, aparecen acá valuadas en vivo.",
  emptyPosTitle: "Todavía no tenés posiciones", emptyPos: "Cuando compres, cada activo aparece acá: cantidad, valor y precio en vivo. Pedile al agente “Invertí 10 USD en el S&P 500”.",
  emptyHist: "Sin movimientos todavía. Cada propuesta del agente — firmada, rechazada o vencida — queda registrada acá.",
  histBuy: "Compra", histSell: "Venta", histOf: "de",
  stExecuted: "ejecutada", stRejected: "rechazada", stExpired: "vencida", stSuperseded: "reemplazada", stPending: "por firmar", stProposed: "propuesta",
  // confirmation card
  confirmBuy: "Confirmá tu compra", confirmSell: "Confirmá tu venta", confirmAriaBuy: "Confirmación de compra", confirmAriaSell: "Confirmación de venta",
  expiresIn: "Vence en", expiredLabel: "Cotización vencida",
  youSell: "Vendés", youInvest: "Invertís", youReceive: "Recibís",
  balanceAfter: (v: string) => `Saldo después: ${v}`, paperUsdc: "USDC paper", creditedOnSign: "USDC paper, acreditado al firmar",
  perUnitLive: (sym: string, price: string) => `1 ${sym} = US$ ${price} · precio en vivo de Jupiter`,
  guaranteedMin: (amt: string, sym: string) => `Mínimo garantizado: ${amt} ${sym} — si no se cumple, no se ejecuta.`,
  techDetails: "Detalle técnico", maxSlippage: "Slippage máximo", priceImpact: "Impacto de precio", route: "Ruta",
  impliedPrice: "Precio implícito de la cotización", quote: "Cotización", mode: "Modalidad", modePaper: "Paper · sin plata real",
  slideToSign: "Deslizá para firmar", slideAriaBuy: "Deslizá para firmar la compra", slideAriaSell: "Deslizá para firmar la venta",
  holdToSign: "o mantené presionado para firmar", signButton: "Firmar con botón (alternativa accesible)",
  signing: "Firmando…", rejecting: "Rechazando…", reject: "Rechazar", editInChat: "Editar en el chat",
  rejectedTitle: "Propuesta rechazada", nothingExecuted: "No se ejecutó nada.",
  tryWith: (sym: string) => `Probar con US$ 5 en ${sym}`, anotherQuote: "Armar otra cotización",
  editTitle: "Volvé a escribirla como quieras", editBody: "Dejé tu pedido en el input. Cambiá el monto o el activo y te armo una cotización nueva. Esta propuesta sigue en tu historial.",
  expiredClosed: "Esta propuesta ya no está vigente.", expiredStale: "Este precio ya no está garantizado.",
  expiredBody: "Pedí una cotización nueva y volvé a revisar antes de firmar.", newQuote: "Pedir cotización nueva", quoting: "Cotizando…",
  expiredBot: "La cotización venció antes de que firmaras, así que no se ejecutó nada. Es deliberado: un precio viejo no se firma.",
  // receipt
  receiptBuy: "Compra ejecutada · paper", receiptSell: "Venta ejecutada · paper", todayAt: (t: string) => `hoy, ${t}`,
  refPrice: "Precio implícito de la cotización", minMet: (amt: string, sym: string) => `${amt} ${sym} · cumplido`,
  status: "Estado", statusPaper: "Ejecutada en paper · simulada a quote",
  followValue: (sym: string) => `¿Cuánto vale hoy mi ${sym}?`, followBuyMore: (sym: string) => `Comprar US$ 5 más de ${sym}`, followPortfolio: "Ver mi portfolio",
  askBalance: "¿Cuánto tengo?", askPortfolio: "Mostrame mi portfolio",
  // chat / prompts / auth feedback
  greetNoWallet: "Hola. Soy tu agente paper: cotizo en vivo con Jupiter y nada se ejecuta sin que lo firmes vos. Primero creá tu wallet paper desde el panel de la derecha.",
  greetFunded: (bal: string) => `Tenés ${bal} en USDC para practicar, sin plata real. Cuando quieras, te armo una primera compra y la firmás vos antes de que se ejecute. ¿Por dónde empezamos?`,
  seeBalance: "Ver mi saldo", seePortfolio: "Ver mi portfolio",
  promptInvest10: "Quiero invertir US$ 10 en SPYx", promptBuyApple: "Comprar US$ 5 de Apple", promptBuyNvidia: "Comprar US$ 5 de Nvidia",
  watchTitle: "Activos para mirar", tokenSub: "token xStocks 1:1",
  walletCreated: "Wallet paper creada. Cargale USDC paper y pedime una cotización.",
  depositDone: (bal: string) => `Listo: tu saldo paper ahora es ${bal} USDC.`,
  needWalletFirst: "Creá tu wallet paper primero.",
  accountCreated: "Cuenta creada. Ahora entrá con tu contraseña.",
  creating: "Creando…", loggingIn: "Entrando…", loading: "Cargando…",
  connError: "No pude conectar con la API (¿está corriendo en :3001?).",
  stateFallback: (s: string) => `La operación quedó en estado ${s}. No se acreditó ningún activo.`,
  langSwitch: "ES",
  liveConnected: "En vivo · SSE", liveReconnecting: "Reconectando en vivo…", liveOffline: "Sin conexión en vivo · actualización manual",
  confirmUpdatedLive: "La propuesta se actualizó en vivo.",
  // asset detail (DIN-26)
  assetDetail: "Ficha del activo", assetInfo: "Info", backToRail: "Volver",
  fIssuer: "Emisor", fUnderlying: "Subyacente", fExchange: "Bolsa", fSector: "Sector",
  fIpo: "IPO", fInception: "Inception del ETF", fExpense: "Expense ratio", fType: "Tipo",
  fTypeEtf: "ETF", fTypeStock: "Acción",
  fPrice: "Precio en vivo", fChange24h: "Cambio 24 h", fVolume24h: "Volumen 24 h (token)",
  fUnderlyingMcap: "Market cap del subyacente", fHolders: "Holders del token",
  fMint: "Mint", fStandard: "Estándar", fNetwork: "Red",
  backingNote: "Onda opera en paper: precios reales, sin ejecución on-chain.",
  sourceAsOf: (name: string, date: string) => `Fuente: ${name} · al ${date}`,
  liveSource: (date: string) => `En vivo de Jupiter · ${date}`,
  investCta: (sym: string) => `Invertir US$ 10 en ${sym}`,
  viewAsset: (sym: string) => `Ver ficha de ${sym}`,
} as const;
export type Dict = typeof ES;
const EN: Dict = {
  tagline: "· Your investing agent", livePrices: "Live prices · Jupiter", paperBadge: "Paper · no real money", logout: "Log out",
  authTitle: "Log in to start", authBody: "Create your demo account. No real funds, no keys: a paper ledger with real, live Jupiter prices.",
  email: "Email", password: "Password", passPh: "At least 8 characters", login: "Log in", register: "Create account",
  composerPh: "Ask your agent for something…", composerHint: "The agent proposes, you sign. Nothing executes without your gesture. Paper cap: US$25 per proposal · US$50 per day. Chat understands Spanish orders today (es-AR).",
  totalLabel: "Total value · paper", sparkCap: "Value this session · live prices",
  positions: "Positions", watch: "Watchlist", history: "History", quickAmounts: "Quick amounts", tickerAria: "Live Jupiter prices",
  typing: "The agent is quoting…", livePriceJupiter: "live Jupiter price", livePrice: "live price", noPrice: "no price",
  held: "you hold", underlying: "underlying", fromUsd: "from US$1",
  totalDetailEmpty: "Log in to see your paper portfolio", totalDetailAllUsdc: "All in USDC, ready for your first buy",
  totalDetailPos: (usdc: string, n: number) => `${usdc} in USDC · ${n} live-valued position${n === 1 ? "" : "s"}`,
  usdcAvailable: "Available USDC", noWalletYet: "No paper wallet yet",
  walletNoteAnon: "Your paper wallet is a demo ledger — no keys, no real funds. Prices come live from Jupiter.",
  walletNoteHas: "Demo ledger — no keys, no real funds. Load paper USDC to trade.",
  walletNoteCreate: "Create it to load paper USDC and request your first quote.",
  createWallet: "Create paper wallet", deposit: "Load paper USDC", depAmtAria: "Amount to load in USD",
  emptyPosAnonTitle: "Log in to see your positions", emptyPosAnon: "Once you have a wallet and positions, they appear here, valued live.",
  emptyPosTitle: "No positions yet", emptyPos: "When you buy, each asset appears here: amount, value and live price. Orders are phrased in Spanish today — try “Invertí 10 USD en el S&P 500”.",
  emptyHist: "No activity yet. Every agent proposal — signed, rejected or expired — is recorded here.",
  histBuy: "Buy", histSell: "Sell", histOf: "of",
  stExecuted: "executed", stRejected: "rejected", stExpired: "expired", stSuperseded: "superseded", stPending: "awaiting signature", stProposed: "proposed",
  confirmBuy: "Confirm your buy", confirmSell: "Confirm your sell", confirmAriaBuy: "Buy confirmation", confirmAriaSell: "Sell confirmation",
  expiresIn: "Expires in", expiredLabel: "Quote expired",
  youSell: "You sell", youInvest: "You invest", youReceive: "You receive",
  balanceAfter: (v: string) => `Balance after: ${v}`, paperUsdc: "Paper USDC", creditedOnSign: "Paper USDC, credited when you sign",
  perUnitLive: (sym: string, price: string) => `1 ${sym} = US$ ${price} · live Jupiter price`,
  guaranteedMin: (amt: string, sym: string) => `Guaranteed minimum: ${amt} ${sym} — if it is not met, nothing executes.`,
  techDetails: "Technical details", maxSlippage: "Max slippage", priceImpact: "Price impact", route: "Route",
  impliedPrice: "Implied quote price", quote: "Quote", mode: "Mode", modePaper: "Paper · no real money",
  slideToSign: "Slide to sign", slideAriaBuy: "Slide to sign the buy", slideAriaSell: "Slide to sign the sell",
  holdToSign: "or press and hold to sign", signButton: "Sign with button (accessible alternative)",
  signing: "Signing…", rejecting: "Rejecting…", reject: "Reject", editInChat: "Edit in chat",
  rejectedTitle: "Proposal rejected", nothingExecuted: "Nothing was executed.",
  tryWith: (sym: string) => `Try US$5 in ${sym}`, anotherQuote: "Build another quote",
  editTitle: "Rewrite it however you like", editBody: "Your request is back in the input. Change the amount or asset and I will build a new quote. This proposal stays in your history. Orders are understood in Spanish (es-AR) today.",
  expiredClosed: "This proposal is no longer active.", expiredStale: "This price is no longer guaranteed.",
  expiredBody: "Request a new quote and review again before signing.", newQuote: "Request a new quote", quoting: "Quoting…",
  expiredBot: "The quote expired before you signed, so nothing executed. By design: a stale price is never signed.",
  receiptBuy: "Buy executed · paper", receiptSell: "Sell executed · paper", todayAt: (t: string) => `today, ${t}`,
  refPrice: "Implied quote price", minMet: (amt: string, sym: string) => `${amt} ${sym} · met`,
  status: "Status", statusPaper: "Executed in paper · simulated at quote",
  followValue: (sym: string) => `What is my ${sym} worth today?`, followBuyMore: (sym: string) => `Buy US$5 more of ${sym}`, followPortfolio: "See my portfolio",
  askBalance: "¿Cuánto tengo?", askPortfolio: "Mostrame mi portfolio",
  greetNoWallet: "Hi. I am your paper agent: I quote live with Jupiter and nothing executes unless you sign it. First create your paper wallet from the panel on the right.",
  greetFunded: (bal: string) => `You have ${bal} in USDC to practice with — no real money. When you are ready, I will build a first buy and you sign it before anything executes. Where do we start?`,
  seeBalance: "See my balance", seePortfolio: "See my portfolio",
  promptInvest10: "Invest US$10 in SPYx", promptBuyApple: "Buy US$5 of Apple", promptBuyNvidia: "Buy US$5 of Nvidia",
  watchTitle: "Assets to watch", tokenSub: "xStocks token 1:1",
  walletCreated: "Paper wallet created. Load paper USDC and ask me for a quote (Spanish phrasing today).",
  depositDone: (bal: string) => `Done: your paper balance is now ${bal} USDC.`,
  needWalletFirst: "Create your paper wallet first.",
  accountCreated: "Account created. Now log in with your password.",
  creating: "Creating…", loggingIn: "Logging in…", loading: "Loading…",
  connError: "Could not reach the API (is it running on :3001?).",
  stateFallback: (s: string) => `The operation ended in state ${s}. No asset was credited.`,
  langSwitch: "EN",
  liveConnected: "Live · SSE", liveReconnecting: "Reconnecting live…", liveOffline: "Live connection down · manual refresh",
  confirmUpdatedLive: "The proposal was updated live.",
  assetDetail: "Asset details", assetInfo: "Info", backToRail: "Back",
  fIssuer: "Issuer", fUnderlying: "Underlying", fExchange: "Exchange", fSector: "Sector",
  fIpo: "IPO", fInception: "ETF inception", fExpense: "Expense ratio", fType: "Type",
  fTypeEtf: "ETF", fTypeStock: "Stock",
  fPrice: "Live price", fChange24h: "24h change", fVolume24h: "24h volume (token)",
  fUnderlyingMcap: "Underlying market cap", fHolders: "Token holders",
  fMint: "Mint", fStandard: "Standard", fNetwork: "Network",
  backingNote: "Onda runs in paper mode: real prices, no on-chain execution.",
  sourceAsOf: (name: string, date: string) => `Source: ${name} · as of ${date}`,
  liveSource: (date: string) => `Live from Jupiter · ${date}`,
  investCta: (sym: string) => `Invest US$10 in ${sym}`,
  viewAsset: (sym: string) => `View ${sym} details`,
};
export const S: Dict = IS_EN ? EN : ES;
// Server (apps/api) replies stay es-AR today — translating them client-side
// would fake agent output, so EN display leaves agent prose in Spanish and
// the screenshots disclose it. Only the patterns below are safe to localize:
// they are deterministic status lines, not agent reasoning.
export function localizeServerReply(text: string): string {
  if (!IS_EN || !text) return text;
  const m = text.match(/^Estás (comprando|vendiendo) ([\d.,]+) USD de (.+?) \(([A-Zx]+)\)\. Confirmá en la tarjeta para simular a quote\.$/);
  if (m) return `You are ${m[1] === "comprando" ? "buying" : "selling"} ${m[2].replace(".", "").replace(",", ".")} USD of ${m[3]} (${m[4]}). Confirm on the card to simulate at quote.`;
  return localizeAmounts(text);
}
// Server amounts arrive es-AR-formatted ("0,01355"); re-render every bare
// amount token in the active locale so EN never shows comma decimals.
export function localizeAmounts(text: string): string {
  if (!IS_EN || !text) return text;
  return text.replace(/\d{1,3}(?:\.\d{3})*,\d+|\d+,\d+/g, (tok) => {
    const n = Number(tok.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 6 }) : tok;
  });
}
export function localizeServerMessage(text: string): string {
  if (!IS_EN || !text) return text;
  if (text === "Compra cancelada. No se movió nada de tu wallet.") return "Buy cancelled. Nothing moved in your wallet.";
  const m = text.match(/^Listo\. Simulado a quote: se acreditaron ≈ ([\d.,]+) ([A-Zx]+) por ([\d.,]+) ([A-Zx]+) en tu saldo paper\. Esto no ejecutó ninguna transacción real\.$/);
  if (m) return `Done. Simulated at quote: ≈ ${m[1].replace(",", ".")} ${m[2]} credited for ${m[3]} ${m[4]} in your paper balance. No real transaction executed.`;
  return localizeAmounts(text);
}
