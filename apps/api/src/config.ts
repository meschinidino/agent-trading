export const config = {
  port: Number(process.env.PORT || 3001),
  sessionSecret: process.env.SESSION_SECRET || "dev-only-change-me-at-least-32-chars!!",
  databasePath: process.env.DATABASE_PATH || "./data/app.sqlite",
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  rpcFallback: process.env.SOLANA_RPC_FALLBACK_URL || "https://solana-rpc.publicnode.com",
  agentWallet: process.env.AGENT_WALLET_ADDRESS || "DbjQkyag5Fnb8tbWe2BFWFAXmYrn6qAWDqk5Uqv2pCcu",
  simulationProofTaker: process.env.SIMULATION_PROOF_TAKER || "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm",
  executionEnabled: process.env.EXECUTION_ENABLED === "true",
  executionMode: process.env.EXECUTION_MODE || "paper",
  agentMode: process.env.AGENT_MODE || "parser",
  gateTtlMs: Number(process.env.GATE_TTL_MS || 60000),
  slippageBps: Number(process.env.SLIPPAGE_BPS || 50),
  paperFaucetCapUsd: Number(process.env.PAPER_FAUCET_CAP_USD || 1000),
  paperPerProposalCapUsd: Number(process.env.PAPER_PER_PROPOSAL_CAP_USD || 25),
  paperDailyCapUsd: Number(process.env.PAPER_DAILY_CAP_USD || 50),
  mcpEnabled: process.env.MCP_ENABLED === "true",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "http://localhost:5173").replace(/\/$/, ""),
  mcpContractVersion: "1.0.0",
  // DIN-25/DIN-30 (AGEN-28/AGEN-31/AGEN-34): SQLite on Azure Files (SMB). busy_timeout
  // must precede journal_mode; SQLITE_JOURNAL_MODE chooses the mode only for NEW
  // databases and defaults to DELETE (rollback journal, no persistent -wal/-shm files,
  // no WAL lock for a second revision to collide with). An existing database keeps its
  // own mode (never forced at boot). Local disk may opt into WAL for new DBs with
  // SQLITE_JOURNAL_MODE=WAL. Invalid values fall back to DELETE with a warning.
  sqliteBusyTimeoutMs: Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 5000),
  // DIN-30: on top of each attempt's busy_timeout, openDb retries the whole open+init
  // sequence with backoff for up to this budget (default ~30s), to ride out the revision
  // transitions on Azure Files where a stale SMB lock can outlive a single busy window.
  sqliteBootBudgetMs: Number(process.env.SQLITE_BOOT_BUDGET_MS || 30000),
  sqliteJournalMode: ((): "WAL" | "DELETE" | "TRUNCATE" | "PERSIST" | "MEMORY" | "OFF" => {
    // Applies ONLY when creating a NEW database (DIN-30): an existing DB keeps the
    // journal mode it already has. Invalid values fall back to DELETE with a warning.
    const raw = String(process.env.SQLITE_JOURNAL_MODE || "DELETE");
    const v = raw.trim().toUpperCase();
    if ((["WAL", "DELETE", "TRUNCATE", "PERSIST", "MEMORY", "OFF"] as const).includes(v as any)) return v as any;
    console.warn(`[db] WARNING: invalid SQLITE_JOURNAL_MODE=${JSON.stringify(raw)}; falling back to DELETE (applies only when creating a new database)`);
    return "DELETE";
  })(),
  mcpTokenTtlDays: 90,
  serverVersion: "0.5.4",
};
