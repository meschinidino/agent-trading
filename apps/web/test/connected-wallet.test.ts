import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectedWallet, type BalanceSnapshot, type PhantomProvider, type PublicKey, type WalletNetwork, type WalletState } from "../src/connected-wallet.ts";

const A = "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm";
const B = "11111111111111111111111111111111";
const key = (address: string) => ({ toBase58: () => address });

function fixture(hasProvider = true) {
  let state!: WalletState;
  const calls: string[] = [];
  const requests: {
    address: string;
    network: WalletNetwork;
    signal: AbortSignal;
    resolve: (value: BalanceSnapshot | null) => void;
    reject: (reason: Error) => void;
  }[] = [];
  const listeners = new Map<string, (key?: PublicKey | null) => void>();
  let approve!: (value: { publicKey: PublicKey }) => void;
  let reject!: (reason: Error) => void;
  let failDisconnect = false;
  const provider: PhantomProvider = {
    isPhantom: true,
    connect(...args) {
      assert.deepEqual(args, []);
      calls.push("connect");
      return new Promise((resolve, fail) => { approve = resolve; reject = fail; });
    },
    async disconnect() {
      calls.push("disconnect");
      if (failDisconnect) throw new Error("extension unavailable");
    },
    on: (event, fn) => { listeners.set(event, fn); },
    off: (event, fn) => { if (listeners.get(event) === fn) listeners.delete(event); },
  };
  const wallet = createConnectedWallet(
    () => hasProvider ? provider : undefined,
    (address, network, signal) => new Promise((resolve, reject) => { requests.push({ address, network, signal, resolve, reject }); }),
    (next) => { state = next; },
  );
  function finish(i: number, override?: Partial<BalanceSnapshot>) {
    const { resolve, address, network } = requests[i];
    resolve({ address, network, asOf: new Date(0).toISOString(), balances: [{ symbol: "SOL", amount: "123" }], ...override });
  }
  const switchAccount = (address: string | null) => listeners.get("accountChanged")?.(address ? key(address) : null);
  return { wallet, calls, requests, listeners, finish, switchAccount, state: () => state,
    approve: () => approve({ publicKey: key(A) }), reject: () => reject(new Error("denied")),
    failDisconnect: () => { failDisconnect = true; }, revoke: () => listeners.get("disconnect")?.() };
}

test("no automatic connect, and missing extension causes no balance reads", async () => {
  const f = fixture(false);
  assert.equal(f.state().status, "idle");
  await f.wallet.connect();
  assert.equal(f.state().status, "missing");
  assert.deepEqual([f.calls, f.requests], [[], []]);
});

test("denied connection, even with an account event, never reads the address", async () => {
  const f = fixture();
  const connecting = f.wallet.connect();
  f.switchAccount(B);
  f.reject();
  await connecting;
  assert.equal(f.state().status, "connectFailed");
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.requests, []);
});

test("a late connect result after logout cannot restore the address", async () => {
  const f = fixture();
  const connecting = f.wallet.connect();
  await f.wallet.disconnect();
  f.approve();
  await connecting;
  assert.deepEqual(f.calls, ["connect", "disconnect"]);
  assert.equal(f.state().address, null);
  assert.deepEqual(f.requests, []);
});

test("a new account and a new network abort older reads and clear the displayed snapshot", async () => {
  const f = fixture();
  const connecting = f.wallet.connect();
  f.approve();
  await connecting;
  f.finish(0);
  await Promise.resolve();
  assert.equal(f.state().snapshot?.address, A);

  f.switchAccount(B);
  assert.equal(f.state().snapshot, null);
  assert.equal(f.state().address, B);
  f.wallet.setNetwork("devnet");
  assert.equal(f.requests[1].signal.aborted, true);
  f.finish(2);
  f.finish(1);
  await Promise.resolve();
  assert.equal(f.state().snapshot?.network, "devnet");
  assert.equal(f.state().snapshot?.address, B);
  assert.deepEqual(f.calls, ["connect"]);
});

test("unauthorized account change and provider disconnect leave no listeners, balances or reconnect", async () => {
  for (const lost of ["account", "provider"]) {
    const f = fixture();
    const connecting = f.wallet.connect();
    f.approve();
    await connecting;
    if (lost === "account") f.switchAccount(null);
    else f.revoke();
    assert.equal(f.requests[0].signal.aborted, true);
    f.finish(0);
    await Promise.resolve();
    assert.equal(f.state().status, "disconnected");
    assert.equal(f.state().address, null);
    assert.equal(f.state().snapshot, null);
    assert.equal(f.listeners.size, 0);
    assert.deepEqual(f.calls, ["connect"]);
  }
});

test("RPC error and wrong-cluster response show no amounts; retry works without reconnect", async () => {
  const f = fixture();
  const connecting = f.wallet.connect();
  f.approve();
  await connecting;
  f.requests[0].reject(new Error("503"));
  await Promise.resolve();
  assert.equal(f.state().status, "rpcFailed");
  const wrong = f.wallet.refresh();
  f.finish(1, { network: "devnet" });
  await wrong;
  assert.equal(f.state().status, "rpcFailed");
  assert.equal(f.state().snapshot, null);
  const retry = f.wallet.refresh();
  f.finish(2);
  await retry;
  assert.equal(f.state().status, "ready");
  assert.deepEqual(f.calls, ["connect"]);
});

test("explicit disconnect clears local data even if Phantom disconnect fails", async () => {
  const f = fixture();
  const connecting = f.wallet.connect();
  f.approve();
  await connecting;
  f.failDisconnect();
  await f.wallet.disconnect();
  f.finish(0);
  await Promise.resolve();
  assert.equal(f.state().status, "disconnectFailed");
  assert.equal(f.state().address, null);
  assert.equal(f.state().snapshot, null);
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.calls, ["connect", "disconnect"]);
});

test("expired Onda session and browser pagehide both drop the local wallet", async () => {
  const f = fixture();
  const connecting = f.wallet.connect();
  f.approve();
  await connecting;
  f.requests[0].resolve(null);
  await Promise.resolve();
  assert.equal(f.state().status, "sessionExpired");
  assert.equal(f.state().address, null);

  const reconnect = f.wallet.connect();
  f.approve();
  await reconnect;
  f.wallet.clear();
  f.finish(1);
  await Promise.resolve();
  assert.equal(f.state().status, "idle");
  assert.equal(f.state().snapshot, null);
  assert.equal(f.listeners.size, 0);
});
