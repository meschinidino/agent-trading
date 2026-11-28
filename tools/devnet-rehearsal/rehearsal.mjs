import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

export const ENDPOINT = "https://api.devnet.solana.com";
export const CHAIN = "solana:devnet";
export const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const LAMPORTS = 1_000_000;
const AIRDROP = 10_000_000;
const TTL = 60_000;
const FINALIZED = { commitment: "finalized" };

export async function devnetRpc(method, params = [], request = fetch) {
  const response = await request(ENDPOINT, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: RPC ${body.error.code} ${body.error.message}`);
  assert(body.jsonrpc === "2.0" && body.id === 1 && Object.hasOwn(body, "result"), `${method}: respuesta RPC inválida`);
  return body.result;
}

async function checkGenesis(rpc) {
  assert.equal(await rpc("getGenesisHash"), GENESIS, "Genesis distinto de Solana devnet");
}

async function finalized(rpc, signature, encoding, wait) {
  assert.equal(typeof signature, "string", "Falta signature");
  assert.equal(bs58.decode(signature).length, 64, "Signature inválida");
  for (let attempt = 0; attempt < 45; attempt++) {
    const tx = await rpc("getTransaction", [signature, { ...FINALIZED, encoding, maxSupportedTransactionVersion: 0 }]);
    if (tx !== null) {
      assert(tx.meta?.err === null && Number.isSafeInteger(tx.slot) && tx.slot >= 0,
        "Transacción finalizada con error o metadata inválida");
      return tx;
    }
    if (attempt < 44) await wait(2_000);
  }
  throw new Error("No se observó finalidad; consultar la signature, no reenviar");
}

function delta(tx, index) {
  const pre = tx.meta.preBalances?.[index];
  const post = tx.meta.postBalances?.[index];
  assert([pre, post].every((v) => Number.isSafeInteger(v) && v >= 0), "Faltan balances atómicos válidos");
  return post - pre;
}

export async function fund(rpc, address, { publish, wait = sleep }) {
  await checkGenesis(rpc);
  publish({ event: "genesis-checked", chain: CHAIN, genesis: GENESIS, endpoint: ENDPOINT });
  const signature = await rpc("requestAirdrop", [address, AIRDROP, FINALIZED]);
  publish({ event: "airdrop-requested", chain: CHAIN, signature, recipient: address, lamports: AIRDROP });
  const tx = await finalized(rpc, signature, "jsonParsed", wait);
  assert.equal(tx.transaction.signatures[0], signature, "Signature de faucet no coincide");
  const recipientIndex = tx.transaction.message.accountKeys.findIndex(({ pubkey }) => pubkey === address);
  const recipientDeltaLamports = delta(tx, recipientIndex);
  assert.equal(recipientDeltaLamports, AIRDROP, "Delta del faucet no coincide");
  publish({ event: "airdrop-finalized", chain: CHAIN, genesis: GENESIS, asset: "SOL de prueba",
    signature, slot: tx.slot, recipient: address, lamports: AIRDROP, recipientDeltaLamports });
}

const monotonicEpochMs = () => Math.floor(performance.timeOrigin + performance.now());

export function prepareTransfer({ rpc, sender, recipient, confirmation, publish, now = monotonicEpochMs, wait = sleep }) {
  assert(!sender.publicKey.equals(recipient), "El destino debe ser otra cuenta del ensayo");
  assert(confirmation === "terminal-operator" || confirmation === "automated-test", "Modo de confirmación inválido");
  const proposal = Object.freeze({
    id: randomUUID(), chain: CHAIN, genesis: GENESIS, asset: "SOL de prueba",
    sender: sender.publicKey.toBase58(), recipient: recipient.toBase58(), lamports: LAMPORTS,
    expiresAtMs: now() + TTL,
  });
  const challenge = `CONFIRMAR ${proposal.id}`;
  let consumed = false;
  return { proposal, challenge, async submit(approval, answer) {
    assert(approval, "Falta confirmación");
    assert(!consumed, "Confirmación ya consumida");
    assert.deepEqual(approval, proposal, "La confirmación no coincide con la propuesta presentada");
    if (confirmation === "terminal-operator") assert.equal(answer, challenge, "Transferencia no aprobada");
    assert(now() < proposal.expiresAtMs, "Confirmación vencida");
    consumed = true;
    await checkGenesis(rpc);
    const { value: { blockhash } } = await rpc("getLatestBlockhash", [FINALIZED]);
    assert(now() < proposal.expiresAtMs, "Confirmación vencida");
    const transaction = new Transaction({ feePayer: sender.publicKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: sender.publicKey, toPubkey: recipient, lamports: proposal.lamports }),
    );
    transaction.sign(sender);
    const signature = bs58.encode(transaction.signature);
    const bytes = transaction.serialize().toString("base64");
    const { accountKeys } = transaction.compileMessage();
    const senderIndex = accountKeys.findIndex((key) => key.equals(sender.publicKey));
    const recipientIndex = accountKeys.findIndex((key) => key.equals(recipient));
    const evidence = { ...proposal, endpoint: ENDPOINT, confirmation, signing: "automated-test-key", signature };
    publish({ event: "submission-intent", ...evidence });
    let returnedSignature;
    try {
      returnedSignature = await rpc("sendTransaction", [bytes, {
        encoding: "base64", preflightCommitment: "finalized", skipPreflight: false, maxRetries: 0,
      }]);
    } catch (error) {
      publish({ event: "submission-unverified", chain: CHAIN, signature, reason: error.message });
    }
    if (returnedSignature !== undefined) {
      assert.equal(returnedSignature, signature, "RPC devolvió una signature distinta; no reenviar");
      publish({ event: "submission-acknowledged", chain: CHAIN, signature });
    }
    const tx = await finalized(rpc, signature, "base64", wait);
    assert.deepEqual(tx.transaction, [bytes, "base64"], "Los bytes finalizados no coinciden con la transferencia aprobada");
    const recipientDeltaLamports = delta(tx, recipientIndex);
    const senderDeltaLamports = delta(tx, senderIndex);
    const feeLamports = tx.meta.fee;
    assert(Number.isSafeInteger(feeLamports) && feeLamports >= 0, "Fee inválido");
    assert.equal(recipientDeltaLamports, proposal.lamports, "Delta del destinatario no coincide");
    assert.equal(senderDeltaLamports, -proposal.lamports - feeLamports, "Delta del emisor no coincide");
    return { event: "transfer-finalized", ...evidence, finality: "finalized", slot: tx.slot,
      recipientDeltaLamports, senderDeltaLamports, feeLamports,
      explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` };
  } };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const automated = args.length === 2 && args[1] === "--automated";
    assert(args[0] === "--live" && (args.length === 1 || automated),
      "Uso: node rehearsal.mjs --live [--automated]. No se aceptan endpoints ni wallets.");
    assert(automated || (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY),
      "La confirmación de operador requiere una terminal");
    const publish = (event) => console.log(JSON.stringify({ mode: "live-devnet", ...event }));
    const sender = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    await fund(devnetRpc, sender.publicKey.toBase58(), { publish });
    const confirmation = automated ? "automated-test" : "terminal-operator";
    const { proposal, challenge, submit } = prepareTransfer({ rpc: devnetRpc, sender, recipient, confirmation, publish });
    publish({ event: "proposal", confirmation, ...proposal });
    let answer;
    if (!automated) {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        answer = await terminal.question(`Para aprobar esta transferencia devnet, escribí ${challenge}: `,
          { signal: AbortSignal.timeout(Math.max(1, proposal.expiresAtMs - monotonicEpochMs())) });
      } finally {
        terminal.close();
      }
    }
    publish(await submit(proposal, answer));
  } catch (error) {
    console.error(`Ensayo devnet detenido: ${error.message}`);
    process.exitCode = 1;
  }
}
