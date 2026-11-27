const API = "http://localhost:3001";
const $ = (id: string) => document.getElementById(id)!;
const on = (id: string, ev: string, fn: (e: Event) => void) => $(id).addEventListener(ev, fn);
let csrf = "";
let portfolio: any = null;
let pricesTimer: any = null;
const prevPrices: Record<string, number> = {};

const NAMES: Record<string, string> = { SPYx: "S&P 500", AAPLx: "Apple", NVDAx: "Nvidia" };
const MINTS: Record<string, string> = {
  SPYx: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
  AAPLx: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  NVDAx: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
};

const fmtUsd = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "USD" });
const fmtNum = (n: number, d = 2) => n.toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d });
const parseAmt = (v: any) => {
  const n = Number(String(v ?? "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};
const fmtAmt = (v: any) => {
  const s = String(v ?? "");
  const n = parseAmt(s);
  return Number.isFinite(n) && s !== "" ? fmtNum(n, 6).replace(/0+$/, "").replace(/,$/, "") : s;
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

function addMsg(kind: "me" | "bot" | "err", text: string) {
  const d = document.createElement("div");
  d.className = "msg " + kind;
  d.textContent = text;
  $("chat").appendChild(d);
  d.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return d;
}
function addTyping() {
  const d = document.createElement("div");
  d.className = "msg bot typing";
  d.innerHTML = "<i></i><i></i><i></i> El agente está cotizando…";
  $("chat").appendChild(d);
  d.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return d;
}

function renderTicker(prices: Record<string, number> | null) {
  $("ticker").innerHTML = Object.keys(NAMES)
    .map((s) => {
      const p = prices?.[MINTS[s]];
      if (p == null) return `<span class="tick skel" title="${NAMES[s]}"><span class="sym">${s}</span><b class="num">$000,00</b></span>`;
      const prev = prevPrices[s];
      const flash = prev != null && p !== prev ? (p > prev ? "flash-up" : "flash-down") : "";
      prevPrices[s] = p;
      return `<span class="tick ${flash}" title="${NAMES[s]} · precio de Jupiter en vivo"><span class="sym">${s}</span><b class="num">$${fmtNum(p)}</b></span>`;
    })
    .join("");
}

function renderPortfolio(p: any) {
  portfolio = p;
  renderTicker(p?.prices || null);
  const positions = p?.positions || [];
  const total = (p?.paperUsdc || 0) + positions.reduce((a: number, x: any) => a + (x.usdValue || 0), 0);
  $("totalValue").textContent = p ? fmtUsd(total) : "—";
  $("totalDetail").innerHTML = p
    ? `<b>${fmtUsd(p.paperUsdc)}</b> en USDC paper listos para invertir · ${positions.length ? positions.length + (positions.length === 1 ? " posición" : " posiciones") + " valuada" + (positions.length === 1 ? "" : "s") + " en vivo" : "sin posiciones todavía"}`
    : "Valor total de tu portfolio paper";
  const box = $("positions");
  if (!p) {
    box.innerHTML = `<div class="empty"><h3>Entrá para ver tu portfolio</h3><p>Cuando tengas wallet y posiciones, aparecen acá valuadas en vivo.</p></div>`;
    return;
  }
  if (!positions.length) {
    box.innerHTML = `<div class="empty"><h3>Todavía no tenés posiciones</h3><p>Pedile al agente <b>“Invertí 10 USD en el S&P 500”</b>: cotiza en vivo y, si confirmás, tu posición aparece acá al instante.</p></div>`;
  } else {
    box.innerHTML = positions.map((x: any) => `<div class="position"><div><span class="pos-name">${NAMES[x.symbol] || x.symbol}<span class="sym">${x.symbol}</span></span><p class="num">${fmtNum(x.amount, 6)} ${x.symbol} · precio ${x.priceUsd ? "$" + fmtNum(x.priceUsd) : "—"}</p></div><div class="val"><b class="num">${x.usdValue != null ? fmtUsd(x.usdValue) : "—"}</b><p>valor en vivo</p></div></div>`).join("");
  }
  const hasWallet = !!p.paperWalletId;
  $("walletText").textContent = hasWallet ? "Wallet paper activa" : "Todavía no tenés wallet paper.";
  $("walletDetail").textContent = hasWallet ? `Saldo disponible: ${fmtUsd(p.paperUsdc)} USDC paper.` : "Creala para cargar USDC paper y pedir tu primera cotización.";
  $("mkWallet").classList.toggle("hidden", hasWallet);
  $("depositBox").classList.toggle("hidden", !hasWallet);
}

function renderHistory(items: any[]) {
  const pill: Record<string, [string, string]> = {
    executed: ["Ejecutada", "pill-executed"], confirmed: ["Ejecutada", "pill-executed"],
    rejected: ["Rechazada", "pill-rejected"],
    expired: ["Expirada", "pill-expired"], superseded: ["Reemplazada", "pill-expired"],
    pending_confirmation: ["Esperando tu firma", "pill-pending"], proposed: ["Propuesta", "pill-pending"],
  };
  $("history").innerHTML = items.length
    ? items.map((x) => {
        const [label, cls] = pill[x.status] || [x.status, "pill-expired"];
        const when = new Date(x.createdAt).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        return `<div class="led-row"><div class="led-main"><span class="what">${x.type === "sell" ? "Venta" : "Compra"} de ${NAMES[x.symbol] || x.symbol}</span><span class="when">${when} · paper</span></div><div class="led-right">${x.amountUsd != null ? `<span class="led-amt num">${fmtUsd(x.amountUsd)}</span>` : ""}<span class="pill ${cls}">${label}</span></div></div>`;
      }).join("")
    : `<div class="empty"><h3>Sin movimientos todavía</h3><p>Tu historial es el registro de cada propuesta: qué pediste, qué cotizó Jupiter y si firmaste, rechazaste o dejaste vencer la cotización.</p></div>`;
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

let countdown: any = null;
function showCard(c: any) {
  clearInterval(countdown);
  const human = NAMES[c.symbol] || c.human || c.symbol;
  const isSell = c.side === "sell";
  const rows: Array<[string, string, boolean?]> = isSell
    ? [["Vendés", `${fmtAmt(c.quotedOut)} ${c.symbol}`], ["Recibís aproximadamente", fmtUsd(Number(c.amountUsd))], ["Mínimo que recibís", `${fmtAmt(c.minOut)} USDC`], ["Slippage máximo", `${c.slippageBps} bps (0,50%)`], ["Impacto de precio", `${fmtNum(Math.abs(Number(c.priceImpactPct)))}%`]]
    : [["Invertís", fmtUsd(Number(c.amountUsd)), true], ["Recibís aproximadamente", `${fmtAmt(c.quotedOut)} ${c.symbol}`], ["Mínimo garantizado", `${fmtAmt(c.minOut)} ${c.symbol}`], ["Precio de referencia", `$${fmtNum(Number(c.amountUsd) / Math.max(parseAmt(c.quotedOut), 1e-12))} por ${c.symbol}`], ["Slippage máximo", `${c.slippageBps} bps (0,50%)`], ["Impacto de precio", `${fmtNum(Math.abs(Number(c.priceImpactPct)))}%`]];
  $("card").innerHTML = `
  <div class="confirm" id="confirmCard" role="group" aria-label="Tarjeta de confirmación">
    <div class="confirm-head">
      <span class="doc-tag">Documento de confirmación · paper</span>
      <h3>${isSell ? "Confirmá tu venta" : "Confirmá tu compra"} de ${esc(human)}</h3>
      <p class="sub">Cotización de Jupiter en vivo, válida por 60 segundos. Si firmás, la operación se simula a este precio contra tu saldo paper. Si no, no se mueve nada.</p>
    </div>
    <div class="kv">${rows.map((r, i) => `<div class="row${r[2] ? " hero-row" : ""}"><span class="n">${String(i + 1).padStart(2, "0")}</span><span class="k">${r[0]}</span><span class="v mono">${esc(r[1])}</span></div>`).join("")}</div>
    <div class="count-zone">
      <div class="countbar"><i id="countBar" style="width:100%"></i></div>
      <div class="count-row" id="countRow"><span>La cotización vence en</span><b class="num" id="countText">…</b></div>
    </div>
    <div class="cta"><button class="ok" id="confirmBtn">Firmar ${isSell ? "venta" : "compra"}</button><button class="no" id="rejectBtn">Rechazar</button></div>
    <p class="safe">Modo paper: no se firma ni se envía ninguna transacción real. El precio y el mínimo salen de la cotización de Jupiter de este momento.</p>
  </div>`;

  api("POST", `/api/v1/confirmations/${c.id}/present`)
    .then((p) => {
      const exp = new Date(p.expiresAt).getTime();
      const span = Math.max(1, exp - Date.now());
      const tick = () => {
        const leftMs = exp - Date.now();
        const left = Math.max(0, Math.ceil(leftMs / 1000));
        const ct = $("countText");
        if (!ct) { clearInterval(countdown); return; }
        ct.textContent = left > 0 ? `0:${String(left).padStart(2, "0")}` : "vencida";
        const bar = $("countBar");
        if (bar) bar.style.width = `${Math.max(0, (leftMs / span) * 100)}%`;
        const card = $("confirmCard");
        card?.classList.toggle("urgent", left <= 10 && left > 0);
        if (left <= 0) {
          clearInterval(countdown);
          card?.classList.add("expired");
          card?.classList.remove("urgent");
          const b = $("confirmBtn") as HTMLButtonElement | null;
          if (b) { b.disabled = true; b.textContent = "Cotización vencida"; }
          const row = $("countRow");
          if (row) row.innerHTML = `<span>Esta cotización venció.</span><b>Pedí una nueva al agente</b>`;
        }
      };
      tick();
      countdown = setInterval(tick, 250);
    })
    .catch((e: any) => addMsg("err", e.message));

  $("confirmBtn").onclick = async () => {
    const b = $("confirmBtn") as HTMLButtonElement;
    b.disabled = true; b.textContent = "Firmando…";
    try {
      const r = await api("POST", `/api/v1/confirmations/${c.id}/confirm`);
      clearInterval(countdown);
      $("card").innerHTML = `<div class="receipt"><h4>${isSell ? "Venta" : "Compra"} ejecutada</h4><p>${esc(r.message || "Operación " + r.status)} Tu portfolio y el historial ya reflejan el movimiento.</p></div>`;
      await refresh();
    } catch (e: any) {
      addMsg("err", e.message);
      b.disabled = false; b.textContent = "Reintentar firma";
    }
  };
  $("rejectBtn").onclick = async () => {
    const rb = $("rejectBtn") as HTMLButtonElement;
    rb.disabled = true; rb.textContent = "Rechazando…";
    try {
      const r = await api("POST", `/api/v1/confirmations/${c.id}/reject`);
      clearInterval(countdown);
      $("card").innerHTML = "";
      addMsg("bot", r.message || "Operación rechazada. No se movió nada de tu wallet.");
      await refresh();
    } catch (e: any) { addMsg("err", e.message); rb.disabled = false; rb.textContent = "Rechazar"; }
  };
  $("confirmCard").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function sendChat(text: string) {
  const m = text.trim();
  if (!m) return;
  addMsg("me", m);
  const typing = addTyping();
  try {
    const r = await api("POST", "/api/v1/chat/message", { message: m });
    typing.remove();
    if (r.reply) addMsg("bot", r.reply);
    if (r.confirmation) showCard(r.confirmation);
    if (r.portfolio) { renderPortfolio(r.portfolio); await refresh(); }
  } catch (e: any) {
    typing.remove();
    addMsg("err", e.message === "Failed to fetch" ? "No pude conectar con la API (¿está corriendo en :3001?)." : e.message);
  }
}

function showApp(email: string) {
  $("who").textContent = email;
  $("logout").classList.remove("hidden");
  $("authPanel").classList.add("hidden");
  $("appPanel").classList.remove("hidden");
  refresh();
  startPrices();
}

function busy(btn: HTMLButtonElement, label: string, fn: () => Promise<void>) {
  return async () => {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    try { await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  };
}

on("reg", "click", busy($("reg") as HTMLButtonElement, "Creando…", async () => {
  const msg = $("authMsg");
  try {
    await api("POST", "/api/v1/auth/register", { email: ($("email") as HTMLInputElement).value, password: ($("pass") as HTMLInputElement).value });
    setMsg(msg, "Cuenta creada. Ahora entrá con tu contraseña.", true);
  } catch (e: any) { setMsg(msg, e.message); }
}));
on("login", "click", busy($("login") as HTMLButtonElement, "Entrando…", async () => {
  const msg = $("authMsg");
  try {
    const j = await api("POST", "/api/v1/auth/login", { email: ($("email") as HTMLInputElement).value, password: ($("pass") as HTMLInputElement).value });
    csrf = j.csrfToken;
    setMsg(msg, "", true);
    showApp(j.email);
    addMsg("bot", "Hola. Decime qué querés hacer: por ejemplo, “Invertí 10 USD en el S&P 500”. Cotizo en vivo y nada se ejecuta sin tu confirmación.");
  } catch (e: any) { setMsg(msg, e.message); }
}));
on("logout", "click", async () => {
  try { await api("POST", "/api/v1/auth/logout"); } catch {}
  location.reload();
});
on("mkWallet", "click", busy($("mkWallet") as HTMLButtonElement, "Creando…", async () => {
  try { await api("POST", "/api/v1/wallets"); await refresh(); addMsg("bot", "Wallet paper creada. Cargale USDC paper y pedime una cotización."); }
  catch (e: any) { addMsg("err", e.message); }
}));
on("dep", "click", busy($("dep") as HTMLButtonElement, "Cargando…", async () => {
  try {
    const ws = await api("GET", "/api/v1/wallets");
    const w = ws.items.find((x: any) => x.mode === "paper");
    if (!w) throw new Error("Creá tu wallet paper primero.");
    const d = await api("POST", `/api/v1/wallets/${w.id}/deposit`, { amountUsd: Number(($("depAmt") as HTMLInputElement).value) });
    addMsg("bot", `Listo: tu saldo paper ahora es ${fmtUsd(d.paperUsdc)} USDC.`);
    await refresh();
  } catch (e: any) { addMsg("err", e.message); }
}));
on("send", "click", async () => {
  const input = $("msg") as HTMLInputElement;
  const v = input.value;
  input.value = "";
  input.focus();
  await sendChat(v);
});
$("msg").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") $("send").click(); });
document.querySelectorAll("#quick button").forEach((b) => b.addEventListener("click", () => sendChat(b.getAttribute("data-q") || b.textContent || "")));

renderTicker(null);
api("GET", "/api/v1/me")
  .then((j) => { csrf = j.csrfToken; showApp(j.email); })
  .catch(() => {});
