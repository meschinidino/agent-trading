export type WalletNetwork = "mainnet" | "devnet";
export type PublicKey = { toBase58(): string };
type WalletEvent = "accountChanged" | "disconnect";
type Listener = (key?: PublicKey | null) => void;
export interface PhantomProvider {
  isPhantom: boolean;
  connect(): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  on(event: WalletEvent, listener: Listener): void;
  off(event: WalletEvent, listener: Listener): void;
}
export interface BalanceSnapshot {
  address: string;
  network: WalletNetwork;
  asOf: string;
  balances: { symbol: string; amount: string }[];
}
type WalletStatus = "idle" | "missing" | "connecting" | "connectFailed" | "disconnected" | "disconnecting" |
  "disconnectFailed" | "loading" | "ready" | "rpcFailed" | "sessionExpired";
export interface WalletState {
  status: WalletStatus;
  address: string | null;
  network: WalletNetwork;
  snapshot: BalanceSnapshot | null;
}

export function createConnectedWallet(
  detect: () => PhantomProvider | undefined,
  read: (address: string, network: WalletNetwork, signal: AbortSignal) => Promise<BalanceSnapshot | null>,
  render: (state: WalletState) => void,
) {
  let state: WalletState = { status: "idle", address: null, network: "mainnet", snapshot: null };
  let connection: { provider: PhantomProvider; remove(): void } | null = null;
  let disconnecting = false;
  let request: AbortController | null = null;

  function update(changes: Partial<WalletState>) {
    state = { ...state, ...changes };
    render(state);
  }
  function cancelRead() {
    request?.abort();
    request = null;
  }
  function detach(status: WalletStatus) {
    const old = connection;
    connection = null;
    cancelRead();
    try { old?.remove(); } catch {}
    update({ address: null, snapshot: null, status });
    return old;
  }
  async function refresh() {
    const { address, network } = state;
    cancelRead();
    if (!address) return;

    const active = new AbortController();
    request = active;
    update({ status: "loading", snapshot: null });
    try {
      const snapshot = await read(address, network, active.signal);
      if (request !== active) return;
      if (!snapshot) {
        detach("sessionExpired");
        return;
      }
      if (snapshot.address !== address || snapshot.network !== network) throw new Error("Unexpected balance response");
      update({ status: "ready", snapshot });
    } catch {
      if (request === active) update({ status: "rpcFailed" });
    } finally {
      if (request === active) request = null;
    }
  }
  async function connect() {
    if (connection || disconnecting) return;
    const provider = detect();
    if (provider?.isPhantom !== true || typeof provider.connect !== "function" || typeof provider.disconnect !== "function"
      || typeof provider.on !== "function" || typeof provider.off !== "function") {
      update({ status: "missing" });
      return;
    }
    let pending = true;
    let latestAccount: PublicKey | null | undefined;
    function setAccount(key?: PublicKey | null) {
      let address: string | undefined;
      try { address = key?.toBase58(); } catch {}
      if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        detach("disconnected");
        return;
      }
      if (address === state.address) return;
      state = { ...state, address };
      void refresh();
    }
    const changed: Listener = (key) => {
      if (connection !== active) return;
      if (pending) latestAccount = key ?? null;
      else setAccount(key);
    };
    const lost: Listener = () => { if (connection === active) detach("disconnected"); };
    const active = {
      provider,
      remove() {
        provider.off("accountChanged", changed);
        provider.off("disconnect", lost);
      },
    };
    connection = active;
    update({ status: "connecting" });
    try {
      provider.on("accountChanged", changed);
      provider.on("disconnect", lost);
      const { publicKey } = await provider.connect();
      pending = false;
      if (connection === active) setAccount(latestAccount === undefined ? publicKey : latestAccount);
    } catch {
      if (connection === active) detach("connectFailed");
    }
  }
  async function disconnect() {
    if (disconnecting) return;
    disconnecting = true;
    const old = detach(connection ? "disconnecting" : "idle");
    try {
      if (old) await old.provider.disconnect();
      if (state.status === "disconnecting") update({ status: "idle" });
    } catch {
      if (state.status === "disconnecting") update({ status: "disconnectFailed" });
    } finally {
      disconnecting = false;
    }
  }
  function setNetwork(network: WalletNetwork) {
    if (network === state.network) return;
    if (state.address) {
      state = { ...state, network };
      void refresh();
    } else {
      update({ network });
    }
  }
  render(state);
  return { connect, disconnect, setNetwork, refresh, clear: () => { detach("idle"); } };
}
