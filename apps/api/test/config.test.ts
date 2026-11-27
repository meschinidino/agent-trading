import { describe, it, expect, vi, afterEach } from "vitest";

// config.ts reads process.env once at import time, so each case re-imports it fresh.
describe("config SQLITE_JOURNAL_MODE (refs DIN-25/DIN-30)", () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("defaults to DELETE for new databases when unset", async () => {
    delete process.env.SQLITE_JOURNAL_MODE;
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.sqliteJournalMode).toBe("DELETE");
  });

  it("accepts a valid mode (case-insensitive), e.g. WAL", async () => {
    process.env.SQLITE_JOURNAL_MODE = "wal";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.sqliteJournalMode).toBe("WAL");
  });

  it("invalid SQLITE_JOURNAL_MODE falls back to DELETE with a warning", async () => {
    process.env.SQLITE_JOURNAL_MODE = "bogus-mode";
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config } = await import("../src/config.js");
    expect(config.sqliteJournalMode).toBe("DELETE");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/invalid SQLITE_JOURNAL_MODE/);
  });

  it("SQLITE_BOOT_BUDGET_MS defaults to ~30s", async () => {
    delete process.env.SQLITE_BOOT_BUDGET_MS;
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.sqliteBootBudgetMs).toBe(30000);
  });
});
