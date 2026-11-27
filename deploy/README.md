# Onda — Azure deploy

Single container: Fastify API serves the Vite web build same-origin when `SERVE_WEB=true`.
SQLite at `DATABASE_PATH` (mounted Azure Files share on Container Apps). Env: EXECUTION_ENABLED=false, EXECUTION_MODE=paper, AGENT_MODE=parser, SESSION_SECRET as Container Apps secret only.

> **Deploy note — SQLite on Azure Files (refs DIN-25, AGEN-28/AGEN-31):** until further notice, replace revisions with the ordered transition **deactivate the old revision first, then activate the new one**. The app-side fix in 0.5.2 (`busy_timeout` before `journal_mode`, 0-byte recovery, `SQLITE_JOURNAL_MODE=DELETE` default) makes an overlap survivable, but the ordered transition remains recommended: it avoids the brief lock contention entirely and is the only ordering proven end-to-end on the SMB share. Do not rely on multi-revision WAL overlap in prod.

Build: `docker build -f deploy/Dockerfile -t onda .`
Run local: `docker run -p 8080:8080 -e SESSION_SECRET=$(openssl rand -hex 32) onda`

## Live resources (rg-agent-trading-preview, eastus)

App: https://onda.wonderfulsky-b50ff12c.eastus.azurecontainerapps.io/ — “Onda — Tu agente inversor”, running in Container Apps.
Static design mockup in the same resource group: https://agenttradingprev6cbfcf.z13.web.core.windows.net/ (mockup only; keep it).

Resources created for the app:

- Container Apps environment `onda-env` + app `onda` (Consumption, 0.5 vCPU / 1 GiB, min 1 replica) ≈ USD 15–25/month
- ACR `ondaagenttrading` (Basic, system identity + AcrPull) ≈ USD 5/month
- Storage account `ondaagentdata` (Azure Files 5 GiB, SQLite) ≈ USD 1/month
- Log Analytics `onda-logs` ≈ USD 0–2/month

Estimated total: ~USD 20–30/month. The runtime flags match the local defaults:
`EXECUTION_ENABLED=false`, `EXECUTION_MODE=paper`, `AGENT_MODE=parser`; `SESSION_SECRET` exists only as a
Container Apps secret and is never committed.

## Teardown

App only (preserves the resource group and the static mockup):

```bash
az containerapp delete -g rg-agent-trading-preview -n onda --yes
az containerapp env delete -g rg-agent-trading-preview -n onda-env --yes
az acr delete -g rg-agent-trading-preview -n ondaagenttrading --yes
az storage account delete -g rg-agent-trading-preview -n ondaagentdata --yes
az monitor log-analytics workspace delete -g rg-agent-trading-preview -n onda-logs --force true --yes
```

Full teardown including the static mockup — only on the project owner's explicit order:

```bash
az group delete -n rg-agent-trading-preview --yes
```
