import { LOCALE, S } from "./i18n";
import { createConnectedWallet, type BalanceSnapshot, type PhantomProvider } from "./connected-wallet";

export function mountWalletPanel(api: string) {
  const panel = document.querySelector<HTMLElement>("#connectedWallet")!;
  const action = panel.querySelector<HTMLButtonElement>("#walletAction")!;
  const select = panel.querySelector<HTMLSelectElement>("#walletNetwork")!;
  const details = panel.querySelector<HTMLElement>("#walletReadout")!;
  const address = panel.querySelector<HTMLElement>("#walletAddress")!;
  const refresh = panel.querySelector<HTMLButtonElement>("#walletRefresh")!;
  const balances = panel.querySelector<HTMLElement>("#walletBalances")!;
  const status = panel.querySelector<HTMLElement>("#walletStatus")!;
  const time = new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const separator = Intl.NumberFormat(LOCALE).formatToParts(1.1).find((p) => p.type === "decimal")!.value;
  const provider = () => (window as Window & { phantom?: { solana?: PhantomProvider } }).phantom?.solana;
  let connected = false;

  const wallet = createConnectedWallet(provider, async (address, network, signal) => {
    const params = new URLSearchParams({ address, network });
    const response = await fetch(`${api}/api/v1/connected-wallet/balances?${params}`, {
      credentials: "include",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error("Balance request failed");
    const snapshot: BalanceSnapshot = await response.json();
    if (!Number.isFinite(Date.parse(snapshot.asOf)) || !Array.isArray(snapshot.balances)
      || !snapshot.balances.every(({ symbol, amount }) => typeof symbol === "string" && /^\d+(?:\.\d+)?$/.test(amount))) {
      throw new Error("Invalid balance response");
    }
    return snapshot;
  }, (state) => {
    const pending = state.status === "connecting" || state.status === "disconnecting";
    connected = !!state.address;
    action.disabled = pending;
    action.textContent = state.status === "connecting" ? S.walletConnecting
      : state.status === "disconnecting" ? S.walletDisconnecting
      : connected ? S.walletDisconnect : S.walletConnect;
    select.value = state.network;
    details.hidden = !connected;
    if (address.textContent !== (state.address ?? "")) {
      const value = state.address ?? "";
      const midpoint = Math.ceil(value.length / 2);
      address.replaceChildren(value.slice(0, midpoint), document.createElement("wbr"), value.slice(midpoint));
    }
    refresh.hidden = !connected;
    refresh.disabled = state.status === "loading";
    refresh.textContent = state.status === "rpcFailed" ? S.walletRetry : S.walletRefresh;

    balances.replaceChildren();
    for (const row of state.snapshot?.balances ?? []) {
      const token = document.createElement("dt");
      token.textContent = row.symbol;
      const value = document.createElement("dd");
      const [whole, fraction] = row.amount.split(".");
      value.className = "num";
      value.textContent = BigInt(whole).toLocaleString(LOCALE) + (fraction ? separator + fraction : "");
      balances.append(token, value);
    }
    const messages = {
      idle: "",
      missing: S.walletMissing,
      connecting: S.walletConnectingNote,
      connectFailed: S.walletConnectFailed,
      disconnected: S.walletAccountLost,
      disconnecting: "",
      disconnectFailed: S.walletDisconnectFailed,
      loading: S.walletLoading,
      ready: state.snapshot ? S.walletUpdated(time.format(new Date(state.snapshot.asOf))) : "",
      rpcFailed: S.walletRpcFailed,
      sessionExpired: S.walletSessionExpired,
    };
    status.textContent = messages[state.status];
    status.classList.toggle("wallet-error", ["rpcFailed", "connectFailed", "disconnectFailed", "sessionExpired"].includes(state.status));
    panel.querySelector<HTMLElement>("#walletDevnetNote")!.hidden = state.network !== "devnet";
  });
  action.addEventListener("click", () => connected ? void wallet.disconnect() : void wallet.connect());
  refresh.addEventListener("click", () => void wallet.refresh());
  select.addEventListener("change", () => wallet.setNetwork(select.value === "devnet" ? "devnet" : "mainnet"));
  window.addEventListener("pagehide", wallet.clear);

  return { show: () => panel.classList.remove("hidden"), disconnect: wallet.disconnect };
}
