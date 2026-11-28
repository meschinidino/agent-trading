import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Keypair, SystemInstruction, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { CHAIN, ENDPOINT, GENESIS, LAMPORTS, devnetRpc, fund, prepareTransfer } from "./rehearsal.mjs";

function fixture({
  genesis = GENESIS, onBlockhash, send = "ok", finalized = "ready", changeReceipt = () => {}, confirmation = "automated-test",
} = {}) {
  const sender = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  let clock = 1_000_000;
  const calls = [];
  const events = [];
  let receipt, signature;
  const rpc = async (method, params) => {
    calls.push(method);
    switch (method) {
      case "getGenesisHash":
        return genesis;
      case "getLatestBlockhash":
        onBlockhash?.(() => { clock += 60_000; });
        assert.deepEqual(params, [{ commitment: "finalized" }]);
        return { value: { blockhash: GENESIS } };
      case "sendTransaction": {
        assert.deepEqual(params[1], { encoding: "base64", preflightCommitment: "finalized", skipPreflight: false, maxRetries: 0 });
        const [bytes] = params;
        const tx = Transaction.from(Buffer.from(bytes, "base64"));
        assert(tx.verifySignatures());
        assert.equal(tx.instructions.length, 1);
        const transfer = SystemInstruction.decodeTransfer(tx.instructions[0]);
        assert(transfer.fromPubkey.equals(sender.publicKey));
        assert(transfer.toPubkey.equals(recipient));
        assert.equal(transfer.lamports, BigInt(LAMPORTS));
        const fee = 5_000;
        const { accountKeys } = tx.compileMessage();
        receipt = {
          slot: 42, transaction: [bytes, "base64"],
          meta: { err: null, fee,
            preBalances: accountKeys.map((key) => key.equals(sender.publicKey) ? 10_000_000 : 0),
            postBalances: accountKeys.map((key) => key.equals(sender.publicKey) ? 10_000_000 - LAMPORTS - fee
              : key.equals(recipient) ? LAMPORTS : 0) },
        };
        changeReceipt(receipt);
        signature = bs58.encode(tx.signature);
        assert.equal(events.at(-1).event, "submission-intent");
        assert.equal(events.at(-1).signature, signature);
        assert(!("bytes" in events.at(-1)));
        if (send === "ambiguous") throw new Error("fixture: reply lost");
        return send === "wrong-signature" ? "wrong-signature" : signature;
      }
      case "getTransaction":
        assert.deepEqual(params, [signature, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }]);
        return finalized === "missing" ? null : receipt;
      default:
        assert.fail(`RPC inesperado: ${method}`);
    }
  };
  const gate = prepareTransfer({
    rpc, sender, recipient, confirmation, publish: (e) => events.push(e),
    now: () => clock, wait: async () => {},
  });
  return { ...gate, calls, events, advance: () => { clock += 60_000; } };
}

test("solo URL oficial: el transporte rechaza redirects y propaga HTTP 429", async () => {
  await assert.rejects(devnetRpc("getGenesisHash", [], async (url, options) => {
    assert.equal(url, "https://api.devnet.solana.com");
    assert.equal(url, ENDPOINT);
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] });
    return { ok: false, status: 429 };
  }), /HTTP 429/);
});

test("la CLI rechaza endpoint, wallet y confirmación de operador por pipe", () => {
  for (const [args, message] of [
    [["--live", "--automated", "https://api.mainnet-beta.solana.com"], /No se aceptan endpoints ni wallets/],
    [["--live", "--wallet=fixture.json"], /No se aceptan endpoints ni wallets/],
    [["--live"], /requiere una terminal/],
  ]) {
    const result = spawnSync(process.execPath, [new URL("./rehearsal.mjs", import.meta.url).pathname, ...args], { input: "CONFIRMAR" });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), message);
    assert.equal(result.stdout.toString(), "");
  }
});

test("faucet: valida genesis, solicita una vez y comprueba delta finalizado", async () => {
  const address = Keypair.generate().publicKey.toBase58();
  const events = [];
  const sig = bs58.encode(Buffer.alloc(64, 1));
  const replies = [
    ["getGenesisHash", undefined, GENESIS],
    ["requestAirdrop", [address, 10_000_000, { commitment: "finalized" }], sig],
    ["getTransaction", [sig, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], {
      slot: 21, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: address }] } },
      meta: { err: null, preBalances: [0], postBalances: [10_000_000] },
    }],
  ];
  await fund(async (method, params) => {
    const [expected, expectedParams, result] = replies.shift();
    assert.equal(method, expected);
    assert.deepEqual(params, expectedParams);
    return result;
  }, address, { publish: (e) => events.push(e) });
  assert.equal(replies.length, 0);
  assert.equal(events.at(-1).event, "airdrop-finalized");
  assert.equal(events.at(-1).recipientDeltaLamports, 10_000_000);
});

test("faucet: HTTP 410 detiene el ensayo sin reintentos ni firma", async () => {
  const calls = [];
  const events = [];
  const rpc = (method, params) => devnetRpc(method, params, async (_url, options) => {
    calls.push(JSON.parse(options.body).method);
    if (method === "requestAirdrop") return { ok: false, status: 410 };
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: GENESIS }) };
  });
  await assert.rejects(fund(rpc, "fixture", { publish: (e) => events.push(e) }), /requestAirdrop: HTTP 410/);
  assert.deepEqual(calls, ["getGenesisHash", "requestAirdrop"]);
  assert.deepEqual(events.map((e) => e.event), ["genesis-checked"]);
});

test("genesis incorrecto impide tanto el airdrop como la firma", async () => {
  const bad = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const calls = [];
  await assert.rejects(fund(async (method) => {
    calls.push(method);
    return bad;
  }, "fixture", { publish: assert.fail }), /Genesis distinto/);
  assert.deepEqual(calls, ["getGenesisHash"]);
  const f = fixture({ genesis: bad });
  await assert.rejects(f.submit(f.proposal), /Genesis distinto/);
  assert.deepEqual(f.calls, ["getGenesisHash"]);
  assert.deepEqual(f.events, []);
});

test("rechaza aprobación ausente o alterada en red, genesis, monto, destino o ID", async () => {
  const f = fixture();
  await assert.rejects(f.submit(), /Falta confirmación/);
  for (const change of [
    { chain: "solana:mainnet" }, { genesis: "otro" }, { lamports: LAMPORTS + 1 },
    { recipient: f.proposal.sender }, { id: "otra-propuesta" }, { expiresAtMs: f.proposal.expiresAtMs + 1 },
  ]) {
    await assert.rejects(f.submit({ ...f.proposal, ...change }), /no coincide/);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.events, []);
});

test("vence tanto antes de reclamar la aprobación como antes de firmar", async () => {
  const stale = fixture();
  stale.advance();
  await assert.rejects(stale.submit(stale.proposal), /vencida/);
  assert.deepEqual(stale.calls, []);
  const delayed = fixture({ onBlockhash: (advance) => advance() });
  await assert.rejects(delayed.submit(delayed.proposal), /vencida/);
  assert.deepEqual(delayed.calls, ["getGenesisHash", "getLatestBlockhash"]);
  assert.deepEqual(delayed.events, []);
});

test("la aprobación de operador exige el desafío de esa propuesta", async () => {
  const f = fixture({ confirmation: "terminal-operator" });
  await assert.rejects(f.submit(f.proposal), /Transferencia no aprobada/);
  await assert.rejects(f.submit(f.proposal, "CANCELAR"), /Transferencia no aprobada/);
  await assert.rejects(f.submit(f.proposal, fixture().challenge), /Transferencia no aprobada/);
  assert.deepEqual(f.calls, []);
  const receipt = await f.submit(f.proposal, f.challenge);
  assert.equal(receipt.confirmation, "terminal-operator");
  assert.equal(receipt.signing, "automated-test-key");
});

test("firma automatizada, un solo envío incluso con replay concurrente, y recibo reconciliado", async () => {
  const f = fixture();
  const first = f.submit({ ...f.proposal });
  await assert.rejects(f.submit(f.proposal), /ya consumida/);
  const receipt = await first;
  await assert.rejects(f.submit(f.proposal), /ya consumida/);
  assert.deepEqual(f.calls, ["getGenesisHash", "getLatestBlockhash", "sendTransaction", "getTransaction"]);
  assert.deepEqual({ ...receipt, signature: undefined, explorer: undefined }, {
    ...f.proposal, event: "transfer-finalized", endpoint: ENDPOINT, confirmation: "automated-test",
    signing: "automated-test-key", signature: undefined, explorer: undefined, chain: CHAIN,
    finality: "finalized", slot: 42, feeLamports: 5_000, recipientDeltaLamports: LAMPORTS,
    senderDeltaLamports: -LAMPORTS - 5_000,
  });
  assert.equal(f.events.at(-1).signature, receipt.signature);
  assert.equal(f.events.at(-1).event, "submission-acknowledged");
  assert.equal(receipt.explorer, `https://explorer.solana.com/tx/${receipt.signature}?cluster=devnet`);
});

test("envío incierto se reconcilia solo por signature local; nunca reenvía", async () => {
  const f = fixture({ send: "ambiguous" });
  const receipt = await f.submit(f.proposal);
  assert.equal(f.events.at(-1).event, "submission-unverified");
  assert.equal(f.events.at(-1).signature, receipt.signature);
  assert.equal(f.calls.filter((m) => m === "sendTransaction").length, 1);
});

test("sin finalidad no hay recibo, reenvío ni reuso de la aprobación", async () => {
  const f = fixture({ send: "ambiguous", finalized: "missing" });
  await assert.rejects(f.submit(f.proposal), /No se observó finalidad/);
  await assert.rejects(f.submit(f.proposal), /ya consumida/);
  assert.equal(f.calls.filter((m) => m === "sendTransaction").length, 1);
  assert.equal(f.calls.filter((m) => m === "getTransaction").length, 45);
});

test("no acredita un recibo con signature, bytes, estado o deltas incorrectos", async () => {
  for (const [options, reason] of [
    [{ send: "wrong-signature" }, /signature distinta/],
    [{ changeReceipt: (r) => { r.transaction[0] = "otro"; } }, /bytes finalizados no coinciden/],
    [{ changeReceipt: (r) => { r.meta.err = { InstructionError: [0, "fixture"] }; } }, /finalizada con error/],
    [{ changeReceipt: (r) => { r.meta.postBalances[1] -= 1; } }, /Delta del destinatario/],
    [{ changeReceipt: (r) => { r.meta.postBalances[0] += 1; } }, /Delta del emisor/],
  ]) {
    const f = fixture(options);
    await assert.rejects(f.submit(f.proposal), reason);
    assert.equal(f.calls.filter((m) => m === "sendTransaction").length, 1);
  }
});
