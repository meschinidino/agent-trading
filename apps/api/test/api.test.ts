import { describe, it, expect, beforeAll } from "vitest";
import { buildApp } from "../src/app.js";
let app: any, cookie = "", csrf = "";
async function req(method: string, url: string, body?: any, headers: any = {}) {
  const res = await app.inject({ method, url, payload: body, cookies: cookie ? { session: cookie } : {}, headers: { "x-csrf-token": csrf, ...headers } });
  return { status: res.statusCode, json: res.json() };
}
describe("API auth/ownership/CSRF (fixtures locales, sin Jupiter)", () => {
  beforeAll(async () => { ({ app } = await buildApp(":memory:")); await app.ready();
    await req("POST", "/api/v1/auth/register", { email: "a@test.dev", password: "password123" });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "a@test.dev", password: "password123" } });
    cookie = login.cookies.find((c: any) => c.name === "session").value; csrf = login.json().csrfToken;
  });
  it("sin CSRF mutation -> 403", async () => { const r = await app.inject({ method: "POST", url: "/api/v1/wallets", cookies: { session: cookie } }); expect(r.statusCode).toBe(403); });
  it("crear wallet + deposit paper + saldo", async () => {
    const w = await req("POST", "/api/v1/wallets"); expect(w.status).toBe(201);
    const d = await req("POST", `/api/v1/wallets/${w.json.id}/deposit`, { amountUsd: 100 }); expect(d.json.paperUsdc).toBe(100);
  });
  it("confirmation ajena -> 404", async () => { const r = await req("GET", "/api/v1/confirmations/no-existe"); expect(r.status).toBe(404); });
  it("wallet ajena deposit -> 404", async () => { const r = await req("POST", "/api/v1/wallets/nope/deposit", { amountUsd: 1 }); expect(r.status).toBe(404); });
});
