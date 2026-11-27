const $ = (id: string) => document.getElementById(id)!;
let csrf = "";
async function api(method: string, path: string, body?: any) {
  const r = await fetch("http://localhost:3001" + path, { method, credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.statusText); return j;
}
function log(t: string) { $("chat").innerHTML += `<p>${t}</p>`; }
$("reg").onclick = async () => { try { await api("POST", "/api/v1/auth/register", { email: ($("email") as HTMLInputElement).value, password: ($("pass") as HTMLInputElement).value }); log("Cuenta creada. Ahora entrá."); } catch (e: any) { log("⚠️ " + e.message); } };
$("login").onclick = async () => { try { const j = await api("POST", "/api/v1/auth/login", { email: ($("email") as HTMLInputElement).value, password: ($("pass") as HTMLInputElement).value }); csrf = j.csrfToken; $("who").textContent = j.email; await refresh(); } catch (e: any) { log("⚠️ " + e.message); } };
$("mkWallet").onclick = async () => { try { const w = await api("POST", "/api/v1/wallets"); log("Paper wallet creada: " + w.id); await refresh(); } catch (e: any) { log("⚠️ " + e.message); } };
$("dep").onclick = async () => { try { const ws = await api("GET", "/api/v1/wallets"); const w = ws.items.find((x: any) => x.mode === "paper"); const d = await api("POST", `/api/v1/wallets/${w.id}/deposit`, { amountUsd: Number(($("depAmt") as HTMLInputElement).value) }); $("bal").textContent = d.paperUsdc + " USDC paper"; await refresh(); } catch (e: any) { log("⚠️ " + e.message); } };
let timer: any;
function showCard(c: any) {
  $("card").innerHTML = `<div class="card"><b>¿Confirmás esta ${c.side === "sell" ? "venta" : "compra"}?</b><br>Estás ${c.side === "sell" ? "vendiendo" : "comprando"} <b>${c.amountUsd} USD</b> de <b>${c.human} (${c.symbol})</b>.<br>Cotización (Jupiter en vivo): recibís ≈ ${c.quotedOut} ${c.side === "buy" ? c.symbol : "USDC"} (mínimo ${c.minOut}). Slippage: ${c.slippageBps} bps. Impacto: ${c.priceImpactPct}%.<br><span id="count"></span><br><button id="confirm">Confirmar</button> <button id="reject">Rechazar</button><div class="muted">Simulado a quote — modo paper, sin transacción real.</div></div>`;
  api("POST", `/api/v1/confirmations/${c.id}/present`).then((p) => {
    const exp = new Date(p.expiresAt).getTime(); clearInterval(timer);
    timer = setInterval(() => { const left = Math.max(0, Math.round((exp - Date.now()) / 1000)); $("count").textContent = `La cotización vence en 0:${String(left).padStart(2, "0")}`; if (left <= 0) clearInterval(timer); }, 250);
  });
  $("confirm").onclick = async () => { try { const r = await api("POST", `/api/v1/confirmations/${c.id}/confirm`); log(r.message || r.status); $("card").innerHTML = ""; await refresh(); } catch (e: any) { log("⚠️ " + e.message); } };
  $("reject").onclick = async () => { try { const r = await api("POST", `/api/v1/confirmations/${c.id}/reject`); log(r.message || "Rechazada"); $("card").innerHTML = ""; await refresh(); } catch (e: any) { log("⚠️ " + e.message); } };
}
$("send").onclick = async () => { const m = ($("msg") as HTMLInputElement).value; log("<b>Vos:</b> " + m); try { const r = await api("POST", "/api/v1/chat/message", { message: m }); log(r.reply); if (r.confirmation) { api("POST", `/api/v1/confirmations/${r.confirmation.id}/present`).catch(() => {}); showCard(r.confirmation); } await refresh(); } catch (e: any) { log("⚠️ " + e.message); } };
async function refresh() { try { const p = await api("GET", "/api/v1/portfolio"); $("bal").textContent = p.paperUsdc + " USDC paper"; $("portfolio").textContent = JSON.stringify(p, null, 2); const h = await api("GET", "/api/v1/transactions"); $("history").textContent = h.items.map((x: any) => `${x.createdAt} ${x.type} ${x.symbol} ${x.amountUsd ?? ""} ${x.status} [${x.mode}]`).join("\n") || "Sin movimientos"; } catch {} }
$("refreshP").onclick = refresh;
api("GET", "/api/v1/me").then((j) => { csrf = j.csrfToken; $("who").textContent = j.email; refresh(); }).catch(() => {});
