# Roadmap de entrega

Vista de delivery. El registro de riesgos y decisiones vive en [docs/specs/06-roadmap-risks.md](specs/06-roadmap-risks.md); acá no se duplica.

| Fase | Estado |
|---|---|
| 0 — Validación (DIN-4) | ✅ Done: quotes mainnet reales + firma devnet vía Phantom MCP |
| 1 — MVP v0.1.0 Track A paper | ✅ Done en este release: usuarios, paper wallets, quotes Jupiter en vivo, gate, simulación real, portfolio, historial |
| 1.1 — Ejecución real detrás de flag | ⏭️ Next: prender `EXECUTION_ENABLED` solo con fondeo + checklist KMS de spec 01 + reconciliación `actualOutAtomic >= minOutAtomic`; opcional `EXECUTION_MODE=devnet` como proof de firma vía MCP |
| 2 — Phantom Connect multi-usuario | Pendiente: embedded wallets por usuario, spending limits |
| 3 — Ramp ARS → USDC | Pendiente: proveedor, KYC y settlement como spec propia |
