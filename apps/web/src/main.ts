import { S, LANG, IS_EN, LOCALE, setLang, orderText, localizeServerReply, localizeServerMessage } from "./i18n";
const API = import.meta.env.VITE_API_URL ?? "";
document.documentElement.lang = IS_EN ? "en" : "es";
if (IS_EN) document.title = "Onda — Your investing agent";
document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => { const k = el.dataset.i18n as keyof typeof S; if (typeof S[k] === "string") el.textContent = S[k] as string; });
document.querySelectorAll<HTMLElement>("[data-i18n-ph]").forEach((el) => { const k = el.dataset.i18nPh as keyof typeof S; if (typeof S[k] === "string") (el as HTMLInputElement).placeholder = S[k] as string; });
document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => { const k = el.dataset.i18nAria as keyof typeof S; if (typeof S[k] === "string") el.setAttribute("aria-label", S[k] as string); });
{ const lb = document.getElementById("langBtn"); if (lb) { lb.textContent = IS_EN ? "ES" : "EN"; lb.addEventListener("click", () => setLang(IS_EN ? "es" : "en")); } }
const $ = (id: string) => document.getElementById(id)!;
const on = (id: string, ev: string, fn: (e: Event) => void) => $(id).addEventListener(ev, fn);
let csrf = "";
let portfolio: any = null;
let pricesTimer: any = null;
let countdown: any = null;
let currentCard: any = null;
let currentCardText = "";
let liveSource: EventSource | null = null;
let liveRetry = 0;
let liveTimer: any = null;
let liveClosed = false;
const prevPrices: Record<string, number> = {};
const sparkPoints: number[] = [];

const NAMES: Record<string, string> = { SPYx: "S&P 500", AAPLx: "Apple", NVDAx: "Nvidia" };
const UNDERLYING: Record<string, string> = { SPYx: "SPY", AAPLx: "AAPL", NVDAx: "NVDA" };
const MARK: Record<string, [string, string]> = { SPYx: ["S", "spy"], AAPLx: ["A", "aapl"], NVDAx: ["N", "nvda"], USDC: ["$", "usdc"] };
const MINTS: Record<string, string> = {
  SPYx: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
  AAPLx: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  NVDAx: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
};

const fmtUsd = (n: number) => n.toLocaleString(LOCALE, { style: "currency", currency: "USD" });
const fmtNum = (n: number, d = 2) => n.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
// Values from the API are es-AR-formatted strings; the active locale only
// changes how we re-render them (fmtNum), never how we parse the wire format.
const parseAmt = (v: any) => {
  const n = Number(String(v ?? "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};
const fmtAmt = (v: any) => {
  const s = String(v ?? "");
  const n = parseAmt(s);
  if (!(Number.isFinite(n) && s !== "")) return s;
  // server sends es-AR-formatted amounts; re-render in active locale
  return fmtNum(n, 6).replace(/0+$/, "").replace(/[.,]$/, "");
};
const splitUsd = (n: number) => {
  const s = fmtUsd(n).replace(/^(US\$|\$)\s?/, "");
  const parts = s.split(",");
  const sep = IS_EN ? "." : ","; return { int: parts[0], dec: parts.length > 1 ? sep + parts[1] : sep + "00" };
};

function setMsg(el: HTMLElement, text: string, ok = false) {
  el.textContent = text;
  el.classList.toggle("ok", ok);
}

async function api(method: string, path: string, body?: any) {
  const r = await fetch(API + path, {
    method,
    credentials: "include",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || r.statusText);
  return j;
}

function esc(t: string) {
  return t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function mark(sym: string, cls = "") {
  const [letter, kind] = MARK[sym] || [sym.slice(0, 1), "spy"];
  return `<span class="tlogo ${kind} ${cls}">${letter}</span>`;
}

function addMsg(kind: "me" | "bot" | "err", text: string) {
  const d = document.createElement("div");
  d.className = "msg " + kind;
  d.innerHTML = `<p>${esc(text)}</p>`;
  $("chat").appendChild(d);
  d.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return d;
}
function addTyping() {
  const d = document.createElement("div");
  d.className = "msg bot typing";
  d.innerHTML = `<p><i></i><i></i><i></i>${S.typing}</p>`;
  $("chat").appendChild(d);
  d.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return d;
}
function addPrompts(items: Array<{ label: string; ask?: string; amtSym?: [number, string] }>) {
  const wrap = document.createElement("div");
  wrap.className = "prompts";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = it.label;
    b.addEventListener("click", () => {
      if (it.amtSym) sendChat(orderText(it.amtSym[0], NAMES[it.amtSym[1]] || it.amtSym[1]));
      else if (it.ask) sendChat(it.ask);
    });
    wrap.appendChild(b);
  }
  $("chat").appendChild(wrap);
  wrap.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return wrap;
}

/* ---------- top strip: precios en vivo, sin variación inventada ---------- */
function renderTicker(prices: Record<string, number> | null) {
  $("ticker").innerHTML = Object.keys(NAMES)
    .map((s) => {
      const p = prices?.[MINTS[s]];
      if (p == null) return `<span class="tk"><span class="sym">${s}</span><span class="pr num">···</span></span>`;
      const prev = prevPrices[s];
      const flash = prev != null && p !== prev ? (p > prev ? "flash-up" : "flash-down") : "";
      prevPrices[s] = p;
      return `<span class="tk ${flash}" title="${NAMES[s]} · ${S.livePriceJupiter}"><span class="sym">${s}</span><span class="pr num">$${fmtNum(p)}</span></span>`;
    })
    .join("");
}

/* ---------- rail ---------- */
function renderSpark(total: number) {
  sparkPoints.push(total);
  if (sparkPoints.length > 40) sparkPoints.shift();
  const wrap = $("sparkWrap");
  if (sparkPoints.length < 2) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  const min = Math.min(...sparkPoints), max = Math.max(...sparkPoints);
  const range = max - min || 1;
  const pts = sparkPoints.map((v, i) => `${(i / (sparkPoints.length - 1)) * 316},${50 - ((v - min) / range) * 44}`).join(" ");
  const up = sparkPoints[sparkPoints.length - 1] >= sparkPoints[0];
  $("spark").innerHTML = `<polyline points="${pts}" fill="none" stroke="${up ? "#3fce8f" : "#f27676"}" stroke-width="1.5"/>`;
}

function renderPortfolio(p: any) {
  portfolio = p;
  renderTicker(p?.prices || null);
  const positions = p?.positions || [];
  const total = (p?.paperUsdc || 0) + positions.reduce((a: number, x: any) => a + (x.usdValue || 0), 0);
  if (p) {
    const sp = splitUsd(total);
    $("totalValue").innerHTML = `US$ ${esc(sp.int)}<span style="font-size:.52em;color:#79818b;font-weight:500">${esc(sp.dec)}</span>`;
    $("totalDetail").innerHTML = positions.length
      ? `<span class="mut">${esc(S.totalDetailPos(fmtUsd(p.paperUsdc), positions.length))}</span>`
      : `<span class="mut">${S.totalDetailAllUsdc}</span>`;
    renderSpark(total);
  } else {
    $("totalValue").textContent = "—";
    $("totalDetail").innerHTML = `<span class="mut">${S.totalDetailEmpty}</span>`;
  }

  const avail = $("availValue");
  avail.textContent = p ? fmtUsd(p.paperUsdc) : "—";
  const hasWallet = !!p?.paperWalletId;
  $("walletText").textContent = hasWallet ? S.usdcAvailable : S.noWalletYet;
  $("walletDetail").textContent = !p
    ? S.walletNoteAnon
    : hasWallet
      ? S.walletNoteHas
      : S.walletNoteCreate;
  $("mkWallet").classList.toggle("hidden", !p || hasWallet);
  $("depositBox").classList.toggle("hidden", !hasWallet);

  const box = $("positions");
  if (!p) {
    box.innerHTML = `<div class="empty-pos"><div class="big">${S.emptyPosAnonTitle}</div>${S.emptyPosAnon}</div>`;
  } else if (!positions.length) {
    box.innerHTML = `<div class="empty-pos"><div class="big">${S.emptyPosTitle}</div>${esc(S.emptyPos)}</div>`;
  } else {
    box.innerHTML = positions.map((x: any) => `
      <button type="button" class="posrow" data-pos="${x.symbol}" aria-label="${esc(S.viewAsset(x.symbol))}">${mark(x.symbol, "lg")}
        <span class="p-main"><span class="p-name">${x.symbol}</span><br><span class="p-qty num">${fmtNum(x.amount, 6)} ${x.symbol}</span></span>
        <span class="p-val"><span class="p-v num">${x.usdValue != null ? fmtUsd(x.usdValue) : "—"}</span><br><span class="p-c mut num">${x.priceUsd ? "US$ " + fmtNum(x.priceUsd) : S.noPrice}</span></span>
      </button>
      <div class="specrow">${x.symbol} · 1:1 · ${S.underlying} ${UNDERLYING[x.symbol] || x.symbol} · 24/7 · ${S.fromUsd}</div>`).join("");
    box.querySelectorAll("[data-pos]").forEach((b) => b.addEventListener("click", () => openAssetDetail(b.getAttribute("data-pos")!)));
  }

  const prices = p?.prices || {};
  $("watchlist").innerHTML = Object.keys(NAMES).map((s) => {
    const held = positions.find((x: any) => x.symbol === s);
    const price = prices[MINTS[s]];
    return `<button type="button" class="posrow" data-watch="${s}" aria-label="${esc(S.viewAsset(s))}">${mark(s, "lg")}
      <span class="p-main"><span class="p-name">${s}</span><br><span class="p-qty">${NAMES[s]} · 1:1${held ? " · " + S.held + " " + fmtNum(held.amount, 6) : ""}</span></span>
      <span class="p-val"><span class="p-v num">${price ? fmtNum(price) : "···"}</span><br><span class="p-c mut">${S.livePrice} · <span class="p-info">${S.assetInfo}</span></span></span>
    </button>`;
  }).join("");
  document.querySelectorAll("[data-watch]").forEach((b) => b.addEventListener("click", () => {
    openAssetDetail(b.getAttribute("data-watch")!);
  }));
}

/* ---------- ficha del activo (DIN-26): panel en el rail, sin modal ---------- */
const assetCache = new Map<string, any>();
async function openAssetDetail(symbol: string) {
  const box = $("assetDetail");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="asset-detail"><span class="mut">${S.loading}</span></div>`;
  try {
    if (!assetCache.has(symbol)) assetCache.set(symbol, await api("GET", `/api/v1/assets/${symbol}`));
    renderAssetDetail(assetCache.get(symbol));
  } catch (e: any) {
    box.innerHTML = `<div class="asset-detail"><span class="mut">${esc(e.message || S.noPrice)}</span></div>`;
  }
}
function fmtBig(n: number | null) {
  if (n == null) return "—";
  if (n >= 1e12) return "US$ " + fmtNum(n / 1e12) + "T";
  if (n >= 1e9) return "US$ " + fmtNum(n / 1e9) + "B";
  if (n >= 1e6) return "US$ " + fmtNum(n / 1e6) + "M";
  return fmtUsd(n);
}
function renderAssetDetail(a: any) {
  const box = $("assetDetail");
  const c = a.curated, l = a.live;
  const row = (k: string, v: string | null) => v == null || v === "" ? "" : `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
  const chg = l.priceChange24hPct == null ? null : (l.priceChange24hPct >= 0 ? "+" : "") + fmtNum(l.priceChange24hPct) + "%";
  box.innerHTML = `<div class="asset-detail">
    <div class="ad-head">${mark(a.symbol, "lg")}<span><span class="ad-name">${esc(a.symbol)}</span><br><span class="ad-sub">${esc(c?.underlyingName || a.human)} · ${esc(a.name)}</span></span>
    <button type="button" class="linklike ad-close" id="adClose">${S.backToRail}</button></div>
    <dl>
      ${row(S.fPrice, l.priceUsd != null ? fmtUsd(l.priceUsd) : "—")}
      ${row(S.fChange24h, chg)}
      ${row(S.fVolume24h, fmtBig(l.volume24hUsd))}
      ${row(S.fUnderlyingMcap, fmtBig(l.underlyingMarketCapUsd))}
      ${row(S.fIssuer, c?.issuer)}
      ${row(S.fUnderlying, c ? `${c.underlyingTicker} · ${c.underlyingName}` : null)}
      ${row(S.fType, c ? (c.assetType === "etf" ? S.fTypeEtf : S.fTypeStock) : null)}
      ${row(S.fExchange, c?.exchange)}
      ${row(S.fSector, c?.sector)}
      ${row(c?.inceptionLabel === "inception" ? S.fInception : S.fIpo, c?.inceptionDate)}
      ${row(S.fExpense, c?.expenseRatioPct != null ? fmtNum(c.expenseRatioPct, 4) + "%" : null)}
      ${row(S.fHolders, l.holderCount != null ? fmtNum(l.holderCount, 0) : null)}
      ${row(S.fStandard, a.token?.standard)}
      ${row(S.fNetwork, a.token?.network)}
      ${row(S.fMint, a.mint)}
    </dl>
    ${c?.description ? `<p class="ad-note">${esc(IS_EN && c.descriptionEn ? c.descriptionEn : c.description)}</p>` : ""}
    <p class="ad-note">${esc(IS_EN && a.token?.backingEn ? a.token.backingEn : (a.token?.backing || ""))} ${S.backingNote}</p>
    <div class="ad-src">${esc(S.liveSource(new Date(l.asOf).toLocaleDateString(LOCALE)))}</div>
    ${c ? `<div class="ad-src">${esc(S.sourceAsOf(c.sourceName, c.asOf))} · <a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">${esc(c.sourceUrl.replace("https://", ""))}</a></div>` : ""}
    <button type="button" class="btn-ghost ad-cta" id="adInvest">${esc(S.investCta(a.symbol))}</button>
  </div>`;
  $("adClose").addEventListener("click", () => { box.classList.add("hidden"); box.innerHTML = ""; });
  $("adInvest").addEventListener("click", () => sendChat(orderText(10, NAMES[a.symbol] || a.symbol)));
}

function renderHistory(items: any[]) {
  const label: Record<string, [string, string]> = {
    executed: [S.stExecuted, "st-executed"], confirmed: [S.stExecuted, "st-executed"],
    rejected: [S.stRejected, "st-rejected"],
    expired: [S.stExpired, "st-expired"], superseded: [S.stSuperseded, "st-expired"],
    pending_confirmation: [S.stPending, "st-pending"], proposed: [S.stProposed, "st-pending"],
  };
  $("history").innerHTML = items.length
    ? items.map((x) => {
        const [txt, cls] = label[x.status] || [x.status, "st-expired"];
        const when = new Date(x.createdAt).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
        return `<div class="lrow"><span class="l-act">${x.type === "sell" ? S.histSell : S.histBuy} ${S.histOf} ${NAMES[x.symbol] || x.symbol}</span>${x.amountUsd != null ? `<span class="l-amt num">${fmtUsd(x.amountUsd)}</span>` : ""}<span class="l-st ${cls}">${txt}</span><span class="l-meta num">${when}</span></div>`;
      }).join("")
    : `<div class="empty-hist">${S.emptyHist}</div>`;
}

async function refresh() {
  try {
    const [p, h] = await Promise.all([api("GET", "/api/v1/portfolio"), api("GET", "/api/v1/transactions")]);
    renderPortfolio(p);
    renderHistory(h.items || []);
  } catch { /* sesión vencida o API caída: la UI queda en estado vacío */ }
}

function startPrices() {
  if (pricesTimer) return;
  pricesTimer = setInterval(refresh, 30000);
}

/* ---------- SSE en vivo (roadmap 1.1): fallback = refresh de 30 s de arriba ---------- */
function setLiveState(state: "on" | "retry" | "off") {
  const dot = document.getElementById("liveDot");
  const label = document.getElementById("liveState");
  if (label) label.textContent = state === "on" ? S.liveConnected : state === "retry" ? S.liveReconnecting : S.liveOffline;
  if (dot) dot.style.background = state === "on" ? "var(--green)" : state === "retry" ? "#e8b93e" : "var(--red)";
}
function applyQuotes(items: any[]) {
  if (!Array.isArray(items)) return;
  const byMintPrice: Record<string, number> = {};
  for (const q of items) if (q?.mint && q.priceUsd != null) byMintPrice[q.mint] = q.priceUsd;
  if (!Object.keys(byMintPrice).length) return;
  if (portfolio) {
    portfolio.prices = { ...(portfolio.prices || {}), ...byMintPrice };
    for (const p of portfolio.positions || []) if (byMintPrice[p.mint] != null) { p.priceUsd = byMintPrice[p.mint]; p.usdValue = p.amount * p.priceUsd; }
    renderPortfolio(portfolio);
  } else renderTicker(byMintPrice);
  const sym = Object.keys(NAMES).find((s) => assetCache.has(s) && items.some((q) => q.symbol === s));
  if (sym) { const a = assetCache.get(sym); const q = items.find((x) => x.symbol === sym); if (a && q) { a.live.priceUsd = q.priceUsd; a.live.priceChange24hPct = q.priceChange24hPct; a.live.asOf = q.asOf; if (!$("assetDetail").classList.contains("hidden")) renderAssetDetail(a); } }
}
function connectLive() {
  if (liveClosed || liveSource || typeof EventSource === "undefined") return;
  try { liveSource = new EventSource(API + "/api/v1/events", { withCredentials: true }); } catch { scheduleLiveRetry(); return; }
  liveSource.addEventListener("ready", () => { liveRetry = 0; setLiveState("on"); });
  liveSource.addEventListener("quotes", (e: any) => { try { applyQuotes(JSON.parse(e.data).items); } catch {} });
  liveSource.addEventListener("portfolio", () => { refresh(); });
  liveSource.addEventListener("confirmation", (e: any) => {
    let ev: any; try { ev = JSON.parse(e.data); } catch { return; }
    refresh();
    if (!currentCard || ev.id !== currentCard.id || !$("confirmCard")) return;
    if (ev.status === "expired") showExpired(currentCard, currentCardText, true);
    else if (ev.status === "rejected" || ev.status === "superseded" || ev.status === "failed") { clearInterval(countdown); $("card").innerHTML = ""; currentCard = null; addMsg("bot", S.confirmUpdatedLive); }
    else if (ev.status === "executed") { clearInterval(countdown); showReceipt(currentCard, { status: "executed", message: "" }); currentCard = null; }
  });
  liveSource.onerror = () => { closeLiveSource(); setLiveState("retry"); scheduleLiveRetry(); };
}
function closeLiveSource() { try { liveSource?.close(); } catch {} liveSource = null; }
function scheduleLiveRetry() {
  if (liveClosed || liveTimer) return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(liveRetry++, 5));
  liveTimer = setTimeout(() => { liveTimer = null; connectLive(); }, delay);
}
function closeLive() { liveClosed = true; if (liveTimer) clearTimeout(liveTimer); liveTimer = null; closeLiveSource(); setLiveState("off"); }

/* ---------- swap object: confirmación en el hilo ---------- */
function amountHtml(value: string, sym: string) {
  const n = parseAmt(value);
  if (!Number.isFinite(n)) return `<span class="big">${esc(value)}</span><span class="unit">${sym}</span>`;
  const s = fmtAmt(value);
  const sep = IS_EN ? "." : ",";
  const [int, dec] = s.split(sep);
  return `<span class="big">${esc(int)}</span>${dec ? `<span class="dec">${sep}${esc(dec)}</span>` : ""}<span class="unit">${sym}</span>`;
}

function showCard(c: any, originalText: string) {
  currentCard = c; currentCardText = originalText;
  clearInterval(countdown);
  const human = NAMES[c.symbol] || c.human || c.symbol;
  const isSell = c.side === "sell";
  const usd = Number(c.amountUsd);
  const price = usd / Math.max(parseAmt(c.quotedOut), 1e-12);
  const quoteId = String(c.id).slice(0, 8);
  const inPanel = isSell
    ? { side: S.youSell, amt: amountHtml(c.quotedOut, c.symbol), sym: c.symbol, sub: S.perUnitLive(c.symbol, fmtNum(price)) }
    : { side: S.youInvest, amt: amountHtml(String(usd), "USDC"), sym: "USDC", sub: portfolio ? S.balanceAfter(fmtUsd(Math.max(0, (portfolio.paperUsdc || 0) - usd))) : S.paperUsdc };
  const outPanel = isSell
    ? { side: S.youReceive, amt: amountHtml(String(usd), "USDC"), sym: "USDC", sub: S.creditedOnSign }
    : { side: S.youReceive, amt: amountHtml(c.quotedOut, c.symbol), sym: c.symbol, sub: S.perUnitLive(c.symbol, fmtNum(price)) };
  const minSym = isSell ? "USDC" : c.symbol;

  const wrap = document.createElement("div");
  wrap.innerHTML = `
  <div class="swap" id="confirmCard" role="group" aria-label="${isSell ? S.confirmAriaSell : S.confirmAriaBuy}">
    <div class="countprogress" id="countProg"><i id="countBar" style="width:100%"></i></div>
    <div class="swap-head">
      <span class="ttl">${isSell ? S.confirmSell : S.confirmBuy}</span>
      <span class="sp"></span>
      <span class="count" id="countWrap"><span id="countLabel">${S.expiresIn}</span><span class="secs num" id="countText">…</span></span>
    </div>
    <div class="panels">
      <div class="panel"><div class="p-left"><div class="side">${inPanel.side}</div><div class="amount num">${inPanel.amt}</div><div class="sub">${inPanel.sub}</div></div><span class="token">${mark(inPanel.sym)}${inPanel.sym}</span></div>
      <div class="divider"><span class="circ"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v13m0 0L3.5 13.5M7 17l3.5-3.5M17 20V7m0 0l3.5 3.5M17 7l-3.5 3.5"/></svg></span></div>
      <div class="panel"><div class="p-left"><div class="side">${outPanel.side}</div><div class="amount num">${outPanel.amt}</div><div class="sub">${outPanel.sub}</div></div><span class="token">${mark(outPanel.sym)}${outPanel.sym}</span></div>
    </div>
    <div class="guarantee">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 5-3.2 8.2-7 10-3.8-1.8-7-5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>
      <span>${esc(S.guaranteedMin(fmtAmt(c.minOut), minSym))}</span>
    </div>
    <button type="button" class="details-toggle" id="detToggle" aria-expanded="false">${S.techDetails}
      <svg class="chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="details" id="detBody">
      <div class="drow"><span class="k">${S.maxSlippage}</span><span class="v num">${c.slippageBps} bps (${fmtNum(Number(c.slippageBps) / 100)}%)</span></div>
      <div class="drow"><span class="k">${S.priceImpact}</span><span class="v num">${fmtNum(Math.abs(Number(c.priceImpactPct)))}%</span></div>
      <div class="drow"><span class="k">${S.route}</span><span class="v">${isSell ? `${c.symbol} → USDC` : `USDC → ${c.symbol}`} · Jupiter</span></div>
      <div class="drow"><span class="k">${S.impliedPrice}</span><span class="v num">US$ ${fmtNum(price)} / ${c.symbol}</span></div>
      <div class="drow"><span class="k">${S.quote}</span><span class="v num">#${esc(quoteId)}</span></div>
      <div class="drow"><span class="k">${S.mode}</span><span class="v">${S.modePaper}</span></div>
    </div>
    <div id="signZone">
      <div class="slide" id="slide">
        <div class="fill" id="slideFill"></div>
        <div class="lbl" id="slideLbl">${S.slideToSign}</div>
        <div class="thumb" id="slideThumb" role="slider" aria-label="${isSell ? S.slideAriaSell : S.slideAriaBuy}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16m0 0l-6-6m6 6l-6 6"/></svg>
        </div>
      </div>
      <div class="holdrow"><button type="button" class="hold" id="holdBtn"><span class="hfill" id="holdFill"></span>${S.holdToSign}</button></div>
      <div class="sign-alt"><button type="button" id="signBtn">${S.signButton}</button></div>
    </div>
    <div class="swap-actions">
      <button type="button" class="linklike danger" id="rejectBtn">${S.reject}</button>
      <span class="sp"></span>
      <button type="button" class="linklike" id="editBtn">${S.editInChat}</button>
    </div>
  </div>`;
  const card = wrap.firstElementChild as HTMLElement;
  $("card").replaceChildren(card);
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });

  const q = (sel: string) => card.querySelector(sel) as HTMLElement;
  let signed = false;

  const doConfirm = async () => {
    if (signed) return;
    signed = true;
    clearInterval(countdown);
    q("#slide")?.classList.add("done", "signing");
    const lbl = q("#slideLbl"); if (lbl) lbl.textContent = S.signing;
    try {
      const r = await api("POST", `/api/v1/confirmations/${c.id}/confirm`);
      if (r.status === "executed") {
        showReceipt(c, r);
      } else {
        $("card").innerHTML = "";
        addMsg("bot", localizeServerMessage(r.message || "") || S.stateFallback(r.status));
      }
      await refresh();
    } catch (e: any) {
      signed = false;
      q("#slide")?.classList.remove("done", "signing");
      const l2 = q("#slideLbl"); if (l2) l2.textContent = S.slideToSign;
      resetSlide();
      addMsg("err", e.message);
    }
  };

  /* slide-to-confirm: drag >=85%, hold fallback, keyboard + button alternative */
  const slide = q("#slide"), thumb = q("#slideThumb"), fill = q("#slideFill"), lbl = q("#slideLbl");
  const maxX = () => Math.max(1, slide.clientWidth - thumb.offsetWidth - 8);
  function setProgress(pct: number) {
    const x = (pct / 100) * maxX();
    thumb.style.transform = `translateX(${x}px)`;
    fill.style.width = pct + "%";
    thumb.setAttribute("aria-valuenow", String(Math.round(pct)));
  }
  function resetSlide() { setProgress(0); }
  let dragging = false, startX = 0, curPct = 0;
  thumb.addEventListener("pointerdown", (e) => {
    dragging = true; startX = e.clientX - (curPct / 100) * maxX();
    thumb.setPointerCapture(e.pointerId);
  });
  thumb.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    curPct = Math.min(100, Math.max(0, ((e.clientX - startX) / maxX()) * 100));
    setProgress(curPct);
    if (curPct >= 85) { dragging = false; setProgress(100); doConfirm(); }
  });
  const endDrag = () => { if (dragging) { dragging = false; curPct = 0; resetSlide(); } };
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);
  thumb.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "ArrowRight" || k === "ArrowUp") { e.preventDefault(); curPct = Math.min(100, curPct + 10); setProgress(curPct); if (curPct >= 85) { setProgress(100); doConfirm(); } }
    else if (k === "ArrowLeft" || k === "ArrowDown") { e.preventDefault(); curPct = Math.max(0, curPct - 10); setProgress(curPct); }
    else if (k === "Enter" || k === " ") { e.preventDefault(); doConfirm(); }
    else if (k === "Home") { curPct = 0; resetSlide(); }
    else if (k === "End") { curPct = 100; setProgress(100); doConfirm(); }
  });

  let holdTimer: any = null, holdStart = 0;
  const holdBtn = q("#holdBtn") as HTMLButtonElement, holdFill = q("#holdFill");
  const holdTick = () => {
    const pct = Math.min(100, ((Date.now() - holdStart) / 900) * 100);
    holdFill.style.width = pct + "%";
    if (pct >= 100) { cancelHold(); doConfirm(); return; }
    holdTimer = requestAnimationFrame(holdTick);
  };
  const cancelHold = () => { if (holdTimer) cancelAnimationFrame(holdTimer); holdTimer = null; holdFill.style.width = "0%"; };
  holdBtn.addEventListener("pointerdown", () => { holdStart = Date.now(); holdTimer = requestAnimationFrame(holdTick); });
  holdBtn.addEventListener("pointerup", cancelHold);
  holdBtn.addEventListener("pointerleave", cancelHold);
  q("#signBtn").addEventListener("click", doConfirm);

  q("#detToggle").addEventListener("click", () => {
    const t = q("#detToggle");
    const open = t.getAttribute("aria-expanded") === "true";
    t.setAttribute("aria-expanded", String(!open));
    q("#detBody").classList.toggle("open", !open);
  });

  q("#rejectBtn").addEventListener("click", async () => {
    const rb = q("#rejectBtn") as HTMLButtonElement;
    rb.disabled = true; rb.textContent = S.rejecting;
    try {
      const r = await api("POST", `/api/v1/confirmations/${c.id}/reject`);
      clearInterval(countdown);
      $("card").innerHTML = "";
      const n = document.createElement("div");
      n.className = "notice";
      n.innerHTML = `<div class="nt">${S.rejectedTitle}</div><div class="mut">${esc(localizeServerMessage(r.message || "") || S.nothingExecuted)}</div>`;
      $("chat").appendChild(n);
      addPrompts([
        { label: S.tryWith(c.symbol), amtSym: [5, c.symbol] },
        { label: S.anotherQuote, ask: orderText(10, NAMES[c.symbol] || c.symbol) },
      ]);
      await refresh();
    } catch (e: any) { addMsg("err", e.message); rb.disabled = false; rb.textContent = S.reject; }
  });

  q("#editBtn").addEventListener("click", () => {
    clearInterval(countdown);
    $("card").innerHTML = "";
    const input = $("msg") as HTMLTextAreaElement;
    input.value = originalText;
    const n = document.createElement("div");
    n.className = "notice";
    n.innerHTML = `<div class="nt">${S.editTitle}</div><div class="mut">${esc(S.editBody)}</div>`;
    $("chat").appendChild(n);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  api("POST", `/api/v1/confirmations/${c.id}/present`)
    .then((p) => {
      if (p.status !== "pending_confirmation") { showExpired(c, originalText, true); return; }
      const exp = new Date(p.expiresAt).getTime();
      const span = Math.max(1, exp - Date.now());
      const tick = () => {
        const leftMs = exp - Date.now();
        const left = Math.max(0, Math.ceil(leftMs / 1000));
        const ct = q("#countText");
        if (!ct) { clearInterval(countdown); return; }
        ct.textContent = left > 0 ? `${left} s` : "0 s";
        const bar = q("#countBar");
        if (bar) bar.style.width = `${Math.max(0, (leftMs / span) * 100)}%`;
        const urgent = left <= 10 && left > 0;
        q("#countProg")?.classList.toggle("urgent", urgent);
        q("#countWrap")?.classList.toggle("urgent", urgent);
        if (left <= 0) {
          clearInterval(countdown);
          showExpired(c, originalText, false);
        }
      };
      tick();
      countdown = setInterval(tick, 250);
    })
    .catch((e: any) => addMsg("err", e.message));
}

function showExpired(c: any, originalText: string, alreadyClosed: boolean) {
  if (!$("confirmCard")) return;
  const isSell = c.side === "sell";
  const card = $("confirmCard");
  card.classList.add("expired");
  const prog = card.querySelector("#countProg"); prog?.classList.add("urgent");
  const bar = card.querySelector("#countBar") as HTMLElement | null; if (bar) bar.style.width = "0%";
  const label = card.querySelector("#countLabel"); if (label) label.textContent = S.expiredLabel;
  const secs = card.querySelector("#countText"); if (secs) secs.textContent = "0 s";
  card.querySelector("#countWrap")?.classList.add("urgent");
  const zone = card.querySelector("#signZone");
  if (zone) {
    zone.innerHTML = `
      <div class="expired-note">
        <svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></svg>
        <span>${alreadyClosed ? S.expiredClosed : S.expiredStale} ${S.expiredBody}</span>
      </div>
      <button type="button" class="newquote" id="newQuoteBtn">${S.newQuote}</button>`;
    zone.querySelector("#newQuoteBtn")!.addEventListener("click", (e) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      (e.currentTarget as HTMLButtonElement).textContent = S.quoting;
      sendChat(originalText);
    });
  }
  addMsg("bot", S.expiredBot);
  refresh();
}

function showReceipt(c: any, r: any) {
  const isSell = c.side === "sell";
  const when = new Date().toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  const price = Number(c.amountUsd) / Math.max(parseAmt(c.quotedOut), 1e-12);
  $("card").innerHTML = `
  <div class="receipt" role="status">
    <div class="rhead">
      <span class="checkic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg></span>
      <span class="ttl">${isSell ? S.receiptSell : S.receiptBuy}</span>
      <span class="when num">${esc(S.todayAt(when))}</span>
    </div>
    <div class="ramt num">${isSell ? "+" : "+"}${esc(fmtAmt(isSell ? String(c.amountUsd) : c.quotedOut))} <span class="unit">${isSell ? "USDC" : c.symbol}</span></div>
    <div class="rsub">${esc(localizeServerMessage(r.message || ""))}</div>
    <div class="details always">
      <div class="drow"><span class="k">${S.refPrice}</span><span class="v num">US$ ${fmtNum(price)} / ${c.symbol}</span></div>
      <div class="drow"><span class="k">${S.quote === "Quote" ? "Guaranteed minimum" : "Mínimo garantizado"}</span><span class="v num">${esc(S.minMet(fmtAmt(c.minOut), isSell ? "USDC" : c.symbol))}</span></div>
      <div class="drow"><span class="k">${S.route}</span><span class="v">${isSell ? `${c.symbol} → USDC` : `USDC → ${c.symbol}`} · Jupiter</span></div>
      <div class="drow"><span class="k">${S.quote}</span><span class="v num">#${esc(String(c.id).slice(0, 8))}</span></div>
      <div class="drow"><span class="k">${S.status}</span><span class="v">${S.statusPaper}</span></div>
    </div>
  </div>`;
  $("card").querySelector(".receipt")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const follow = addPrompts([
    { label: S.followValue(c.symbol), ask: S.askBalance },
    { label: S.followBuyMore(c.symbol), amtSym: [5, c.symbol] },
    { label: S.followPortfolio, ask: S.askPortfolio },
  ]);
  $("card").appendChild(follow);
}

/* ---------- chat ---------- */
async function sendChat(text: string) {
  const m = text.trim();
  if (!m) return;
  addMsg("me", m);
  const typing = addTyping();
  try {
    const r = await api("POST", "/api/v1/chat/message", { message: m });
    typing.remove();
    if (r.reply) addMsg("bot", localizeServerReply(r.reply));
    if (r.confirmation) showCard(r.confirmation, m);
    else if (r.portfolio) { renderPortfolio(r.portfolio); await refresh(); }
  } catch (e: any) {
    typing.remove();
    addMsg("err", e.message === "Failed to fetch" ? S.connError : e.message);
  }
}

function greetEmpty() {
  if (!portfolio) return;
  const hasWallet = !!portfolio.paperWalletId;
  const bal = portfolio.paperUsdc || 0;
  if (!hasWallet) {
    addMsg("bot", S.greetNoWallet);
    addPrompts([{ label: S.seeBalance, ask: S.askBalance }, { label: S.seePortfolio, ask: S.askPortfolio }]);
    return;
  }
  if (!portfolio.positions?.length && bal > 0) {
    addMsg("bot", S.greetFunded(fmtUsd(bal)));
    addPrompts([
      { label: S.promptInvest10, amtSym: [10, "SPYx"] },
      { label: S.promptBuyApple, amtSym: [5, "AAPLx"] },
      { label: S.promptBuyNvidia, amtSym: [5, "NVDAx"] },
    ]);
    const watch = document.createElement("div");
    const prices = portfolio.prices || {};
    watch.innerHTML = `<div class="rlabel" style="margin:12px 0 2px">${S.watchTitle}</div><div class="watch">${Object.keys(NAMES).map((s) => {
      const price = prices[MINTS[s]];
      return `<button type="button" class="wrow" data-greet-watch="${s}">${mark(s)}<span class="w-main"><span class="w-name">${s}</span><br><span class="w-sub">${NAMES[s]} · ${S.tokenSub}</span></span><span class="w-val"><span class="w-v num">${price ? fmtNum(price) : "···"}</span><br><span class="w-c mut">${S.livePrice}</span></span></button>`;
    }).join("")}</div>`;
    $("chat").appendChild(watch);
    watch.querySelectorAll("[data-greet-watch]").forEach((b) => b.addEventListener("click", () => sendChat(orderText(10, NAMES[b.getAttribute("data-greet-watch")!]))));
  }
}


/* ---------- Settings: agentes externos (MCP) ---------- */
function fmtDate(iso: string | null) { return iso ? new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" }) : "—"; }
async function loadMcpTokens() {
  const box = $("mcpTokens"); if (!box) return;
  try {
    const r = await api("GET", "/api/v1/settings/mcp-tokens");
    $("mcpEndpoint").innerHTML = r.mcpEnabled && r.mcpEndpoint ? `Endpoint MCP: <code>${esc(r.mcpEndpoint)}</code><br>Config en el cliente: <code>Authorization: Bearer &lt;token&gt;</code>` : "El servidor MCP está apagado en este entorno (MCP_ENABLED=false). Podés crear tokens, pero ningún agente los va a poder usar hasta prender el flag.";
    const items = r.items || [];
    box.innerHTML = items.length ? items.map((x: any) => `
      <div class="mcp-row">
        <span class="mcp-name">${esc(x.name)}</span>
        <span class="mcp-meta">Scopes: ${esc((x.scopes || []).join(", ") || "—")}<br>Creado: ${fmtDate(x.createdAt)} · Vence: ${fmtDate(x.expiresAt)} · Último uso: ${fmtDate(x.lastUsedAt)}${x.revokedAt ? `<br>Revocado: ${fmtDate(x.revokedAt)}` : ""}</span>
        ${x.revokedAt ? "" : `<button type="button" class="linklike danger mcp-revoke" data-revoke="${esc(x.id)}">Revocar</button>`}
      </div>`).join("") : `<div class="empty-hist">Todavía no creaste tokens MCP.</div>`;
    box.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
      const btn = b as HTMLButtonElement; btn.disabled = true; btn.textContent = "Revocando…";
      try { await api("DELETE", `/api/v1/settings/mcp-tokens/${btn.getAttribute("data-revoke")}`); await loadMcpTokens(); addMsg("bot", "Token MCP revocado. Las confirmations pendientes creadas bajo ese token vencieron."); }
      catch (e: any) { addMsg("err", e.message); btn.disabled = false; btn.textContent = "Revocar"; }
    }));
  } catch { box.innerHTML = `<div class="empty-hist">Entrá para gestionar tokens MCP.</div>`; }
}
on("createMcpToken", "click", busy($("createMcpToken") as HTMLButtonElement, "Creando…", async () => {
  const name = ($("mcpTokenName") as HTMLInputElement).value.trim() || "Mi agente";
  const scopes = ($("mcpPreset") as HTMLInputElement).checked ? ["read:portfolio", "quote", "propose"] : ["read:portfolio"];
  try {
    const r = await api("POST", "/api/v1/settings/mcp-tokens", { name, scopes });
    const box = $("mcpSecret"); box.classList.remove("hidden");
    box.innerHTML = `<b>Token creado. Copialo ahora: se muestra una sola vez.</b><br><code>${esc(r.secret || r.token)}</code><br><span class="mut">Vence el ${fmtDate(r.expiresAt)}. Guardalo como header <code>Authorization: Bearer …</code> en tu cliente MCP.</span>`;
    ($("mcpTokenName") as HTMLInputElement).value = "";
    await loadMcpTokens();
  } catch (e: any) { addMsg("err", e.message); }
}));

async function openDeepLinkConfirmation() {
  const m = location.pathname.match(/^\/confirm\/([^/]+)$/);
  if (!m) return;
  const cid = decodeURIComponent(m[1]);
  try {
    await api("GET", "/api/v1/me");
    const c = await api("GET", `/api/v1/confirmations/${cid}`);
    const dec = NAMES[c.symbol] ? 8 : 8;
    showCard({ id: c.id, symbol: c.symbol, side: c.side || "buy", human: NAMES[c.symbol] || c.symbol, amountUsd: c.amountUsd, quotedOut: c.quotedOut, minOut: c.minOut, slippageBps: c.slippageBps, priceImpactPct: c.priceImpactPct, expiresAt: c.expiresAt, mode: c.mode || "paper" }, `Confirmación MCP ${cid}`);
    addMsg("bot", "Te prepararon esta compra desde tu agente externo. Revisala acá: recién firma o rechaza en Onda.");
  } catch (e: any) { addMsg("err", "No pude abrir esa confirmación desde el link. Entrá y fijate tu historial: " + e.message); }
}

function showApp(email: string) {
  $("who").textContent = email;
  $("logout").classList.remove("hidden");
  $("authPanel").classList.add("hidden");
  refresh().then(() => greetEmpty());
  loadMcpTokens();
  openDeepLinkConfirmation();
  startPrices();
  connectLive();
}

function busy(btn: HTMLButtonElement, label: string, fn: () => Promise<void>) {
  return async () => {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    try { await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  };
}

on("reg", "click", busy($("reg") as HTMLButtonElement, S.creating, async () => {
  const msg = $("authMsg");
  try {
    await api("POST", "/api/v1/auth/register", { email: ($("email") as HTMLInputElement).value, password: ($("pass") as HTMLInputElement).value });
    setMsg(msg, S.accountCreated, true);
  } catch (e: any) { setMsg(msg, e.message); }
}));
on("login", "click", busy($("login") as HTMLButtonElement, S.loggingIn, async () => {
  const msg = $("authMsg");
  try {
    const j = await api("POST", "/api/v1/auth/login", { email: ($("email") as HTMLInputElement).value, password: ($("pass") as HTMLInputElement).value });
    csrf = j.csrfToken;
    setMsg(msg, "", true);
    showApp(j.email);
  } catch (e: any) { setMsg(msg, e.message); }
}));
on("logout", "click", async () => {
  closeLive();
  try { await api("POST", "/api/v1/auth/logout"); } catch {}
  location.reload();
});
on("mkWallet", "click", busy($("mkWallet") as HTMLButtonElement, S.creating, async () => {
  try { await api("POST", "/api/v1/wallets"); await refresh(); addMsg("bot", S.walletCreated); }
  catch (e: any) { addMsg("err", e.message); }
}));
on("dep", "click", busy($("dep") as HTMLButtonElement, S.loading, async () => {
  try {
    const ws = await api("GET", "/api/v1/wallets");
    const w = ws.items.find((x: any) => x.mode === "paper");
    if (!w) throw new Error(S.needWalletFirst);
    const d = await api("POST", `/api/v1/wallets/${w.id}/deposit`, { amountUsd: Number(($("depAmt") as HTMLInputElement).value) });
    addMsg("bot", S.depositDone(fmtUsd(d.paperUsdc)));
    await refresh();
  } catch (e: any) { addMsg("err", e.message); }
}));
on("send", "click", async () => {
  const input = $("msg") as HTMLTextAreaElement;
  const v = input.value;
  input.value = "";
  input.focus();
  await sendChat(v);
});
$("msg").addEventListener("keydown", (e) => {
  const ke = e as KeyboardEvent;
  if (ke.key === "Enter" && !ke.shiftKey) { ke.preventDefault(); $("send").click(); }
});
document.querySelectorAll(".quick button").forEach((b) => b.addEventListener("click", () => {
  const amt = b.getAttribute("data-amt");
  const sym = portfolio?.positions?.[0]?.symbol || "SPYx";
  const input = $("msg") as HTMLTextAreaElement;
  input.value = orderText(Number(amt), NAMES[sym]);
  input.focus();
}));

renderTicker(null);
renderPortfolio(null);
renderHistory([]);
api("GET", "/api/v1/me")
  .then((j) => { csrf = j.csrfToken; showApp(j.email); })
  .catch(() => {});
