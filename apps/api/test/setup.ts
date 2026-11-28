import { REGISTRY, USDC, byMint } from "../src/registry.js";

const nativeFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === "https://api.jup.ag") {
    if (url.pathname === "/price/v3") {
      const mints = url.searchParams.get("ids")?.split(",") ?? [];
      return Response.json(Object.fromEntries([USDC, ...REGISTRY].filter(({ mint }) => mints.includes(mint)).map(({ mint }) => [
        mint, mint === USDC.mint ? { usdPrice: 1 } : { usdPrice: 101.25, priceChange24h: 2.5 },
      ])));
    }
    if (url.pathname === "/tokens/v2/search") {
      const token = byMint(url.searchParams.get("query") ?? "");
      return Response.json(token ? [{
        id: token.mint, name: token.name, symbol: token.symbol, decimals: token.decimals,
        isVerified: true, stats24h: { buyVolume: 30, sellVolume: 20 },
      }] : []);
    }
  }
  if (url.origin === "https://rpc.onda.test" && init?.method === "POST" && typeof init.body === "string") {
    const { id, method } = JSON.parse(init.body);
    if (method === "getBalance" || method === "getTokenAccountsByOwner") {
      return Response.json({ jsonrpc: "2.0", id, result: { value: method === "getBalance" ? 1_500_000_000 : [] } });
    }
  }
  if (url.protocol === "http:" && url.hostname === "127.0.0.1") return nativeFetch(input, init);
  throw new Error(`Unexpected outbound fetch in tests: ${url.origin}${url.pathname}`);
};
