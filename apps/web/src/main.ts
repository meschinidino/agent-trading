const API = "http://localhost:3001";
const $ = (id: string) => document.getElementById(id)!;
const on = (id: string, ev: string, fn: (e: Event) => void) => $(id).addEventListener(ev, fn);
let csrf = "";
let portfolio: any = null;
let pricesTimer: any = null;

const fmtUsd = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "USD" });
const fmtNum = (n: number, d = 2) => n.toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d });

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

function renderTicker(prices: Record<string, number> | null) {
  const names: Record<string, string> = { SPYx: "S&P 500", AAPLx: "Apple", NVDAx: "Nvidia" };
  const mints: Record<string, string> = {
    SPYx: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    AAPLx: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    NVDAx: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  };
  $("ticker").innerHTML = Object.keys(names)
    .map((s) => {
      const p = prices?.[mints[s]];
      return `<span class="tick" title="${names[s]}">${s} <b class="num">${p ? "$" + fmtNum(p) : "…"}</b></span>`;
    })
    .join("");
}

function renderPortfolio(p: any) {
  portfolio = p;
  renderTicker(p?.prices || null);
  const positions = p?.positions || [];
  const total = (p?.paperUsdc || 0) + positions.reduce((a: number, x: any) => a + (x.usdValue || 0), 0);
  $("totalValue").textContent = p ? fmtUsd(total) : "—";
  $("totalDetail").textContent = p
    ? `Valor total · ${fmtUsd(p.paperUsdc)} USDC disponibles para invertir`
    : "Valor total de tu portfolio paper";
  const box = $("positions");
  if (!p) {
    box.innerHTML = `<div class="empty">Entrá para ver tu portfolio.</div>`;
    return;
  }
  const rows = positions.map((x: any) => {
    const names: Record<string, string> = { SPYx: "S&P 500", AAPLx: "Apple", NVDAx: "Nvidia" };
    return `<div class="position"><div><b>${names[x.symbol] || x.symbol}</b><p class="num">${fmtNum(x.amount, 8)} ${x.symbol} · precio ${x.priceUsd ? "$" + fmtNum(x.priceUsd) : "—"}</p></div><div class="val"><b class="num">${x.usdValue != null ? fmtUsd(x.usdValue) : "—"}</b><p>valor en vivo</p></div></div>`;
  });
  rows.push(`<div class="position"><div><b>USDC paper</b><p>Disponible para invertir</p></div><div class="val"><b class="num">${fmtUsd(p.paperUsdc)}</b><p>saldo</p></div></div>`);
  box.innerHTML = rows.join("");
  const hasWallet = !!p.paperWalletId;
  $("walletText").textContent = hasWallet ? `Wallet paper activa · saldo ${fmtUsd(p.paperUsdc)} USDC` : "Todavía no tenés wallet paper.";
  $("mkWallet").classList.toggle("hidden", hasWallet);
  $("depositBox").classList.toggle("hidden", !hasWallet);
}

function renderHistory(items: any[]) {
  const label: Record<string, string> = { executed: "Ejecutada", proposed: "Propuesta", pending_confirmation: "Esperando confirmación", rejected: "Rechazada", expired: "Vencida", superseded: "Reemplazada", confirmed: "Confirmada" };
  const names: Record<string, string> = { SPYx: "S&P 500", AAPLx: "Apple", NVDAx: "Nvidia" };
  $("history").innerHTML = items.length
    ? items.map((x) => `<div><span style="color:var(--ink)">${x.type === "sell" ? "Venta" : "Compra"} de ${names[x.symbol] || x.symbol}${x.amountUsd != null ? " · " + fmtUsd(x.amountUsd) : ""}</span><span>${label[x.status] || x.status} · paper · ${new Date(x.createdAt).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span></div>`).join("")
    : `<div><span style="color:var(--muted)">Sin movimientos todavía. Pedile una cotización al agente.</span></div>`;
}

async function refresh() {
  try {
    const [p, h] = await Promise.all([api("GET", "/api/v1/portfolio"), api("GET", "/api/v1/transactions")]);
    renderPortfolio(p);
    renderHistory(h.items || []);
  } catch {
    /* sesión vencida o API caída: la UI queda en estado vacío */
  }
}

function startPrices() {
  if (pricesTimer) return;
  pricesTimer = setInterval(refresh, 30000);
}

let countdown: any = null;
function showCard(c: any) {
  clearInterval(countdown);
  const names: Record<string, string> = { SPYx: "S&P 500", AAPLx: "Apple", NVDAx: "Nvidia" };
  const human = names[c.symbol] || c.human || c.symbol;
  const verb = c.side === "sell" ? "Venta" : "Compra";
  const receiveLabel = c.side === "sell" ? "Recibís aproximadamente" : "Recibís aproximadamente";
  const receiveUnit = c.side === "sell" ? "USDC" : c.symbol;
  $("card").innerHTML = `
  <div class="confirm" id="confirmCard">
    <h3>${verb === "Compra" ? "Confirmá tu compra" : "Confirmá tu venta"} de ${esc(human)}</h3>
    <p>Cotización de Jupiter en vivo. Si confirmás, la operación se simula a este precio en tu saldo paper.</p>
    <div class="kv num">
      <div><span>${c.side === "sell" ? "Vendés" : "Invertís"}</span><b>${c.side === "sell" ? esc(String(c.quotedOut)) + " " + c.symbol : fmtUsd(Number(c.amountUsd))}</b></div>
      <div><span>${receiveLabel}</span><b>${c.side === "sell" ? fmtUsd(Number(c.amountUsd)) : esc(String(c.quotedOut)) + " " + receiveUnit}</b></div>
      <div><span>Mínimo garantizado</span><b>${esc(String(c.minOut))} ${receiveUnit}</b></div>
      <div><span>Slippage máximo</span><b>${c.slippageBps} bps</b></div>
      <div><span>Impacto de precio</span><b>${fmtNum(Math.abs(Number(c.priceImpactPct)))}%</b></div>
    </div>
    <div class="countbar"><i id="countBar" style="width:100%"></i></div>
    <div class="count-row" id="countRow"><span>La cotización vence en</span><b class="num" id="countText">…</b></div>
    <div class="cta"><button class="ok" id="confirmBtn">Confirmar ${c.side === "sell" ? "venta" : "compra"}</button><button class="no" id="rejectBtn">Rechazar</button></div>
    <p class="safe">Modo paper: no se firma ni se envía ninguna transacción real.</p>
  </div>`;

  api("POST", `/api/v1/confirmations/${c.id}/present`)
    .then((p) => {
      const exp = new Date(p.expiresAt).getTime();
      const start = Date.now();
      const span = Math.max(1, exp - start);
      const tick = () => {
        const leftMs = exp - Date.now();
        const left = Math.max(0, Math.ceil(leftMs / 1000));
        const ct = $("countText");
        if (!ct) { clearInterval(countdown); return; }
        ct.textContent = `0:${String(left).padStart(2, "0")}`;
        const bar = $("countBar");
        if (bar) bar.style.width = `${Math.max(0, (leftMs / span) * 100)}%`;
        $("countRow")?.classList.toggle("urgent", left <= 10);
        if (left <= 0) {
          clearInterval(countdown);
          $("confirmCard")?.classList.add("expired");
          const b = $("confirmBtn") as HTMLButtonElement | null;
          if (b) { b.disabled = true; b.textContent = "Cotización vencida"; }
          ct.textContent = "vencida — pedí una cotización nueva";
        }
      };
      tick();
      countdown = setInterval(tick, 250);
    })
    .catch((e: any) => addMsg("err", e.message));

  $("confirmBtn").onclick = async () => {
    const b = $("confirmBtn") as HTMLButtonElement;
    b.disabled = true; b.textContent = "Confirmando…";
    try {
      const r = await api("POST", `/api/v1/confirmations/${c.id}/confirm`);
      clearInterval(countdown);
      $("card").innerHTML = "";
      addMsg("bot", r.message || "Operación " + r.status);
      await refresh();
    } catch (e: any) {
      addMsg("err", e.message);
      b.disabled = false; b.textContent = "Reintentar";
    }
  };
  $("rejectBtn").onclick = async () => {
    try {
      const r = await api("POST", `/api/v1/confirmations/${c.id}/reject`);
      clearInterval(countdown);
      $("card").innerHTML = "";
      addMsg("bot", r.message || "Operación cancelada. No se movió nada de tu wallet.");
      await refresh();
    } catch (e: any) { addMsg("err", e.message); }
  };
  $("confirmCard").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function sendChat(text: string) {
  const m = text.trim();
  if (!m) return;
  addMsg("me", m);
  try {
    const r = await api("POST", "/api/v1/chat/message", { message: m });
    if (r.reply) addMsg("bot", r.reply);
    if (r.confirmation) showCard(r.confirmation);
    if (r.portfolio) { renderPortfolio(r.portfolio); await refresh(); }
  } catch (e: any) {
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

on("reg", "click", async () => {
  const msg = $("authMsg");
  try {
    await api("POST", "/api/v1/auth/register", { email: ($("email") as HTMLInputElement).value, password: ($("pass") as HTMLInputElement).value });
    setMsg(msg, "Cuenta creada. Ahora entrá con tu contraseña.", true);
  } catch (e: any) { setMsg(msg, e.message); }
});
on("login", "click", async () => {
  const msg = $("authMsg");
  try {
    const j = await api("POST", "/api/v1/auth/login", { email: ($("email") as HTMLInputElement).value, password: ($("pass") as HTMLInputElement).value });
    csrf = j.csrfToken;
    setMsg(msg, "", true);
    showApp(j.email);
    addMsg("bot", "Hola. Decime qué querés hacer: por ejemplo, “Invertí 10 USD en el S&P 500”. Cotizo en vivo y nada se ejecuta sin tu confirmación.");
  } catch (e: any) { setMsg(msg, e.message); }
});
on("logout", "click", async () => {
  try { await api("POST", "/api/v1/auth/logout"); } catch {}
  location.reload();
});
on("mkWallet", "click", async () => {
  try { await api("POST", "/api/v1/wallets"); await refresh(); addMsg("bot", "Wallet paper creada. Cargale USDC paper y pedime una cotización."); }
  catch (e: any) { addMsg("err", e.message); }
});
on("dep", "click", async () => {
  try {
    const ws = await api("GET", "/api/v1/wallets");
    const w = ws.items.find((x: any) => x.mode === "paper");
    if (!w) throw new Error("Creá tu wallet paper primero.");
    const d = await api("POST", `/api/v1/wallets/${w.id}/deposit`, { amountUsd: Number(($("depAmt") as HTMLInputElement).value) });
    addMsg("bot", `Listo: tu saldo paper ahora es ${fmtUsd(d.paperUsdc)} USDC.`);
    await refresh();
  } catch (e: any) { addMsg("err", e.message); }
});
on("send", "click", async () => {
  const input = $("msg") as HTMLInputElement;
  const v = input.value;
  input.value = "";
  await sendChat(v);
});
$("msg").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") $("send").click(); });
document.querySelectorAll("#quick button").forEach((b) => b.addEventListener("click", () => sendChat(b.getAttribute("data-q") || b.textContent || "")));
$("refreshP")?.addEventListener("click", refresh);

renderTicker(null);
api("GET", "/api/v1/me")
  .then((j) => { csrf = j.csrfToken; showApp(j.email); })
  .catch(() => {});
