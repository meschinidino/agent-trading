import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { config } from "./config.js";
import { REGISTRY, USDC } from "./registry.js";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const GENESIS = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};
export const balanceQuery = z.object({
  address: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).refine((value) => {
    try { return new PublicKey(value).toBase58() === value; } catch { return false; }
  }),
  network: z.enum(["mainnet", "devnet"]),
}).strict();
type BalanceQuery = z.infer<typeof balanceQuery>;

const lamports = z.object({ value: z.number().int().nonnegative() });
const tokenAccounts = z.object({ value: z.array(z.object({
  account: z.object({
    owner: z.string(),
    data: z.object({ parsed: z.object({ info: z.object({
      mint: z.string(),
      owner: z.string(),
      tokenAmount: z.unknown(),
    }) }) }),
  }),
})) });
const tokenAmount = z.object({
  amount: z.string().regex(/^\d{1,20}$/),
  decimals: z.number().int().nonnegative(),
  uiAmountString: z.string().optional(),
});

function decimal(amount: bigint, decimals: number) {
  if (!decimals) return amount.toString();
  const s = amount.toString().padStart(decimals + 1, "0");
  return (s.slice(0, -decimals) + "." + s.slice(-decimals)).replace(/\.?0+$/, "");
}

async function readSnapshot(url: string, { address, network }: BalanceQuery) {
  const signal = AbortSignal.timeout(5000);
  async function read(method: "getGenesisHash" | "getBalance" | "getTokenAccountsByOwner", params: unknown[]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
      signal,
    });
    if (!response.ok) throw new Error("RPC HTTP error");
    const body = await response.json();
    if (body?.id !== method || body?.error || body?.result == null) throw new Error("RPC response error");
    return body.result;
  }

  if (await read("getGenesisHash", []) !== GENESIS[network]) throw new Error("Unexpected Solana cluster");
  const opts = { commitment: "confirmed", encoding: "jsonParsed" };
  const [sol, spl, token2022] = await Promise.all([
    read("getBalance", [address, { commitment: opts.commitment }]).then((r) => lamports.parse(r).value),
    read("getTokenAccountsByOwner", [address, { programId: TOKEN }, opts]).then((r) => tokenAccounts.parse(r).value),
    network === "mainnet"
      ? read("getTokenAccountsByOwner", [address, { programId: TOKEN_2022 }, opts]).then((r) => tokenAccounts.parse(r).value)
      : [],
  ]);
  const balances = [
    { symbol: "SOL", amount: decimal(BigInt(sol), 9) },
    ...[network === "mainnet" ? USDC : { ...USDC, mint: DEVNET_USDC }, ...(network === "mainnet" ? REGISTRY : [])].map((token) => {
      const program = token.symbol === "USDC" ? TOKEN : TOKEN_2022;
      let total = 0n;
      for (const { account } of program === TOKEN ? spl : token2022) {
        const info = account.data.parsed.info;
        if (info.mint !== token.mint) continue;
        const amount = tokenAmount.parse(info.tokenAmount);
        if (account.owner !== program || info.owner !== address || amount.decimals !== token.decimals) throw new Error("Unexpected token account");
        if (program === TOKEN) {
          total += BigInt(amount.amount);
        } else {
          const match = /^(\d{1,20})(?:\.(\d+))?$/.exec(amount.uiAmountString ?? "");
          if (!match || (match[2]?.length ?? 0) > token.decimals) throw new Error("Missing scaled token amount");
          total += BigInt(match[1] + (match[2] ?? "").padEnd(token.decimals, "0"));
        }
      }
      return { symbol: token.symbol, amount: decimal(total, token.decimals) };
    }),
  ];
  return { address, network, balances, asOf: new Date().toISOString() };
}

export async function connectedWalletBalances(query: BalanceQuery) {
  const urls = query.network === "mainnet" ? [config.rpcUrl, config.rpcFallback] : [config.walletDevnetRpcUrl];
  for (const url of new Set(urls)) {
    try { return await readSnapshot(url, query); } catch {}
  }
  return null;
}
