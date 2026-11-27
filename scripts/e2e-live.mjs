// E2E contra APIs EN VIVO (Jupiter + Solana RPC). Nada de fixtures.
const API = "http://localhost:3001";
let cookie = "", csrf = "";
async function call(method, path, body, useCsrf = true) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie: `session=${cookie}` } : {}), ...(useCsrf ? { "x-csrf-token": csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0].split("=")[1];
  const j = await r.json(); console.log(method, path, r.status, JSON.stringify(j).slice(0, 600)); if (!r.ok) throw new Error(path + " " + JSON.stringify(j)); return j;
}
const email = `e2e-${Date.now()}@test.dev`;
await call("POST", "/api/v1/auth/register", { email, password: "password123" }, false);
const login = await call("POST", "/api/v1/auth/login", { email, password: "password123" }, false); csrf = login.csrfToken;
const w = await call("POST", "/api/v1/wallets", {});
await call("POST", `/api/v1/wallets/${w.id}/deposit`, { amountUsd: 100 });
const chat = await call("POST", "/api/v1/chat/message", { message: "Invertí 10 USD en el S&P 500" });
if (!chat.confirmation) throw new Error("sin confirmation");
await call("POST", `/api/v1/confirmations/${chat.confirmation.id}/present`, {});
await new Promise(r => setTimeout(r, 2100)); // RPC rate-limit hygiene entre sims
const conf = await call("POST", `/api/v1/confirmations/${chat.confirmation.id}/confirm`, {});
console.log("CONFIRM RESULT:", conf.status, conf.message, JSON.stringify(conf.execution));
const p = await call("GET", "/api/v1/portfolio", undefined, false);
console.log("PORTFOLIO SPYx:", JSON.stringify(p.positions), "paperUsdc:", p.paperUsdc, "real SOL:", p.real?.sol);
const h = await call("GET", "/api/v1/transactions", undefined, false);
console.log("HISTORY:", JSON.stringify(h.items.slice(0, 3)));
if (conf.status !== "executed") { console.error("E2E: NO ejecutó — ver motivo arriba (honesto, sin fallback)"); process.exit(2); }
console.log("E2E OK — fill paper acreditado solo tras simulación real OK");
