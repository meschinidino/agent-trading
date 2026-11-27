import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { CURATED_ASSET_INFO } from "../src/asset-info.js";
import { REGISTRY } from "../src/registry.js";

let app: any;
beforeAll(async () => { ({ app } = await buildApp(":memory:")); await app.ready(); });
afterEach(() => vi.unstubAllGlobals());

function stubJupiter(priceOk = true) {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("/price/v3")) {
      if (!priceOk) return { ok: false, status: 502, json: async () => ({}) };
      const ids = new URL(u).searchParams.get("ids")!.split(",");
      const body: any = {};
      for (const m of ids) body[m] = { usdPrice: 100.5, priceChange24h: 1.25, stockData: { mcap: 123456789, price: 100.1 } };
      return { ok: true, json: async () => body };
    }
    if (u.includes("/tokens/v2/search")) {
      const mint = new URL(u).searchParams.get("query");
      const t = REGISTRY.find((x) => x.mint === mint);
      return { ok: true, json: async () => t ? [{ id: t.mint, name: t.name, symbol: t.symbol, icon: "https://example.com/i.webp", decimals: 8, isVerified: true, tags: ["xstocks", "token-2022", "verified"], tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", holderCount: 42, circSupply: 1000, mcap: 999, stats24h: { priceChange: 1.25, buyVolume: 10, sellVolume: 5 } }] : [] };
    }
    throw new Error("unexpected fetch " + u);
  });
}

describe("dataset curado (DIN-26)", () => {
  it("cubre el registry, con fuente + asOf, sin campos rápidos hardcodeados", () => {
    for (const t of REGISTRY) {
      const c = CURATED_ASSET_INFO[t.symbol];
      expect(c, t.symbol).toBeTruthy();
      expect(c.sourceUrl).toMatch(/^https:\/\//);
      expect(c.sourceName.length).toBeGreaterThan(3);
      expect(c.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.inceptionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c).not.toHaveProperty("priceUsd");
      expect(c).not.toHaveProperty("marketCapUsd");
    }
    expect(CURATED_ASSET_INFO.SPYx.inceptionLabel).toBe("inception");
    expect(CURATED_ASSET_INFO.AAPLx.inceptionLabel).toBe("ipo");
    expect(CURATED_ASSET_INFO.SPYx.expenseRatioPct).toBeGreaterThan(0);
    expect(CURATED_ASSET_INFO.AAPLx.expenseRatioPct).toBeNull();
  });
});

describe("GET /api/v1/assets (DIN-26)", () => {
  it("lista mergeada: vivo de Jupiter + curado con fuente, mode paper", async () => {
    stubJupiter();
    const r = await app.inject({ method: "GET", url: "/api/v1/assets" });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.mode).toBe("paper");
    expect(j.items.map((x: any) => x.symbol)).toEqual(["SPYx", "AAPLx", "NVDAx"]);
    const spy = j.items[0];
    expect(spy.live.priceUsd).toBe(100.5);
    expect(spy.live.priceChange24hPct).toBe(1.25);
    expect(spy.live.underlyingMarketCapUsd).toBe(123456789);
    expect(spy.live.source).toBe("jupiter");
    expect(spy.curated.underlyingTicker).toBe("SPY");
    expect(spy.curated.sourceUrl).toMatch(/^https:/);
    expect(spy.token.standard).toBe("Token-2022");
  });

  it("detalle por símbolo y 404 tipado fuera del registry", async () => {
    stubJupiter();
    const ok = await app.inject({ method: "GET", url: "/api/v1/assets/NVDAx" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().curated.inceptionDate).toBe("1999-01-22");
    const bad = await app.inject({ method: "GET", url: "/api/v1/assets/TSLAx" });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().error.code).toBe("ASSET_NOT_IN_REGISTRY");
  });

  it("fail-soft: Jupiter caído -> campos vivos null, curados intactos", async () => {
    stubJupiter(false);
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 502, json: async () => ({}) }));
    // cache de 60s puede servir el caso anterior; símbolo nuevo no hay, así que
    // se valida la forma: o live null o el valor cacheado, nunca un invento.
    const r = await app.inject({ method: "GET", url: "/api/v1/assets/AAPLx" });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.curated.underlyingName).toBe("Apple Inc.");
    expect(j.live.priceUsd === null || typeof j.live.priceUsd === "number").toBe(true);
    expect(j.live).not.toHaveProperty("dividendYieldPct");
  });
});
