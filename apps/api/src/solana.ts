import { config } from "./config.js";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function rpc(method: string, params: unknown[], retries = 4): Promise<any> {
  let lastErr: any;
  for (const url of [config.rpcUrl, config.rpcFallback]) {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const j: any = await res.json();
        if (j.error) { lastErr = j.error; if (j.error.code === 429 || String(j.error.message).includes("Too many")) { await sleep(700 * (i + 1)); continue; } throw Object.assign(new Error(j.error.message), { code: "RPC_ERROR", rpc: j.error }); }
        return j.result;
      } catch (e) { lastErr = e; await sleep(500 * (i + 1)); }
    }
  }
  throw Object.assign(new Error(`RPC ${method} falló: ${lastErr?.message || lastErr?.code || "sin respuesta"}`), { code: "RPC_UNAVAILABLE" });
}
export async function simulate(txB64: string) {
  const result = await rpc("simulateTransaction", [txB64, { sigVerify: false, replaceRecentBlockhash: true, encoding: "base64" }]);
  const v = result?.value;
  return { err: v?.err ?? null, logs: (v?.logs || []) as string[], unitsConsumed: v?.unitsConsumed, slot: result?.context?.slot };
}
export async function getSolBalance(address: string) { const r = await rpc("getBalance", [address]); return r.value as number; }
export async function getTokenBalances(address: string) {
  const out: { mint: string; amountAtomic: string; uiAmount: number }[] = [];
  for (const programId of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
    const r = await rpc("getTokenAccountsByOwner", [address, { programId }, { encoding: "jsonParsed" }]);
    for (const a of r.value || []) { const info = a.account.data.parsed.info; out.push({ mint: info.mint, amountAtomic: info.tokenAmount.amount, uiAmount: info.tokenAmount.uiAmount || 0 }); }
    await sleep(250);
  }
  return out;
}
