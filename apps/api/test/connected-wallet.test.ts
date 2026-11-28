import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { REGISTRY, USDC } from "../src/registry.js";

const ADDRESS = "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm";
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const nativeFetch = globalThis.fetch;

function account(program: string, mint: string, amount: string, decimals: number, uiAmountString?: string) {
  return { account: { owner: program, data: { parsed: { info: {
    mint, owner: ADDRESS, tokenAmount: { amount, decimals, uiAmount: null, uiAmountString },
  } } } } };
}

function fixture(overrides?: (url: string, method: string) => unknown) {
  const calls: { url: string; method: string; params: any[]; signal: AbortSignal }[] = [];
  const allowed = [config.rpcUrl, config.rpcFallback, config.walletDevnetRpcUrl];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (!allowed.includes(url)) return nativeFetch(input, init);
    const { id, method, params } = JSON.parse(String(init?.body));
    calls.push({ url, method, params, signal: init?.signal! });
    const devnet = url === config.walletDevnetRpcUrl;
    let result: unknown = overrides?.(url, method);
    if (result instanceof Response) return result;
    if (result === undefined) {
      if (method === "getGenesisHash") result = devnet ? DEVNET : MAINNET;
      else if (method === "getBalance") result = { value: devnet ? 0 : 1_000_000_001 };
      else if (method === "getTokenAccountsByOwner") {
        const program = params[1].programId;
        if (program === SPL) result = { value: [
          account(SPL, USDC.mint, "9007199254740992", 6),
          account(SPL, USDC.mint, "1", 6),
          account(SPL, DEVNET_USDC, "20000000", 6),
          account(SPL, REGISTRY[0].mint, "999", 8, "100"),
        ] };
        else if (program === TOKEN_2022) result = { value: [
          account(TOKEN_2022, REGISTRY[0].mint, "100000000", 8, "1.25"),
          account(TOKEN_2022, REGISTRY[0].mint, "1", 8, "0.00000001"),
          account(TOKEN_2022, REGISTRY[1].mint, "0", 8, "0"),
          account(TOKEN_2022, "unlisted", "200000000", 8, "2"),
        ] };
      }
    }
    if (result === undefined) throw new Error(`Unexpected RPC method: ${method}`);
    return Response.json({ jsonrpc: "2.0", id, result });
  });
  return calls;
}

describe("connected Phantom wallet: isolated RPC reads", () => {
  let built: Awaited<ReturnType<typeof buildApp>>;
  let session: string;
  beforeAll(async () => {
    built = await buildApp(":memory:");
    await built.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "read@onda.test", password: "wallet-read-fixture" } });
    const login = await built.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "read@onda.test", password: "wallet-read-fixture" } });
    session = login.cookies.find((cookie) => cookie.name === "session")!.value;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await built.app.close(); built.db.close(); });

  function get(network = "mainnet", address = ADDRESS, signedIn = true) {
    return built.app.inject({ method: "GET", url: "/api/v1/connected-wallet/balances", query: { address, network },
      cookies: signedIn ? { session } : {} });
  }

  it("requires the Onda session, an exact supported cluster and a 32-byte address", async () => {
    const calls = fixture();
    expect((await get("mainnet", ADDRESS, false)).statusCode).toBe(401);
    expect((await get("testnet")).statusCode).toBe(422);
    expect((await get("mainnet", "111111111111111111111111111111111")).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it("sums canonical balances across accounts, using the scaled xStocks RPC amount", async () => {
    const calls = fixture();
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ address: ADDRESS, network: "mainnet", asOf: expect.any(String), balances: [
      { symbol: "SOL", amount: "1.000000001" },
      { symbol: "USDC", amount: "9007199254.740993" },
      { symbol: "SPYx", amount: "1.25000001" },
      { symbol: "AAPLx", amount: "0" },
      { symbol: "NVDAx", amount: "0" },
    ] });
    expect(calls.map(({ method }) => method)).toEqual(["getGenesisHash", "getBalance", "getTokenAccountsByOwner", "getTokenAccountsByOwner"]);
    expect(calls.slice(2).map(({ params }) => params)).toEqual([SPL, TOKEN_2022].map((programId) => [
      ADDRESS, { programId }, { encoding: "jsonParsed", commitment: "confirmed" },
    ]));
    expect(calls.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    expect(built.db.prepare("SELECT COUNT(*) AS n FROM wallets").get()).toEqual({ n: 0 });
  });

  it("uses only the devnet endpoint and mint, without xStocks rows", async () => {
    const calls = fixture();
    const res = await get("devnet");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ network: "devnet", balances: [
      { symbol: "SOL", amount: "0" }, { symbol: "USDC", amount: "20" },
    ] });
    expect(calls.map(({ url }) => url)).toEqual(Array(3).fill(config.walletDevnetRpcUrl));
    expect(calls.at(-1)?.params[1]).toEqual({ programId: SPL });
  });

  it("validates cluster before reads and only retries on a matching mainnet fallback", async () => {
    const calls = fixture((url, method) => url === config.rpcUrl && method === "getGenesisHash" ? DEVNET : undefined);
    expect((await get()).statusCode).toBe(200);
    expect(calls.filter(({ url }) => url === config.rpcUrl).map(({ method }) => method)).toEqual(["getGenesisHash"]);
    expect(calls.filter(({ url }) => url === config.rpcFallback)).toHaveLength(4);
  });

  it("fails closed on invalid scaled amounts and RPC errors instead of reporting partial zeros", async () => {
    fixture((_url, method) => method === "getTokenAccountsByOwner" ? { value: [
      account(TOKEN_2022, REGISTRY[0].mint, "100000000", 8),
    ] } : undefined);
    const incomplete = await get();
    expect(incomplete.statusCode).toBe(503);
    expect(incomplete.json()).toMatchObject({ error: { code: "RPC_UNAVAILABLE" } });
    expect(incomplete.json()).not.toHaveProperty("balances");

    vi.restoreAllMocks();
    fixture((_url, method) => method === "getBalance" ? new Response(null, { status: 429 }) : undefined);
    const throttled = await get("devnet");
    expect(throttled.statusCode).toBe(503);
    expect(throttled.headers["cache-control"]).toBe("no-store");
    expect(throttled.json()).not.toHaveProperty("balances");
  });
});
