# Roadmap de entrega

Vista de delivery. El registro de riesgos y decisiones vive en [docs/specs/06-roadmap-risks.md](specs/06-roadmap-risks.md); acá no se duplica.

| Fase | Estado |
|---|---|
| 0 — Validación (DIN-4) | ✅ Done: quotes mainnet reales + firma devnet vía Phantom MCP |
| 1 — MVP v0.1.0 Track A paper | ✅ Done: PR #4 (MVP: usuarios, paper wallets, quotes Jupiter en vivo, gate, simulación real, portfolio, historial) + PR #7 (Terminal amable: diseño implementado en la web real) + PR #8 (deploy Azure + branding Onda). Live en https://onda.wonderfulsky-b50ff12c.eastus.azurecontainerapps.io/ — “Onda — Tu agente inversor”, demo interna con ejecución paper. Corte v0.2.0 ver [CHANGELOG.md](../CHANGELOG.md) |
| 1.1 — Updates en vivo + camino a ejecución real | ⏭️ Next: SSE para estado en vivo (decidido el 2026-11-27, Q3 — SSE sobre polling; todavía no implementado); ejecución real detrás de `EXECUTION_ENABLED` sigue pendiente de la decisión de fondeo del operador + checklist KMS de spec 01 + reconciliación `actualOutAtomic >= minOutAtomic`, con `EXECUTION_MODE=paper` como default; opcional, una proof de firma MCP en devnet iniciada desde la API. El diseño a live ya está hecho (PR #7); no es parte de esta fase |
| 1.2 — Onda MCP (BYOA) | 📝 Especificado en [07-onda-mcp.md](specs/07-onda-mcp.md) (sin código): servidor MCP remoto (Streamable HTTP) para que el usuario opere desde su propio agente (ChatGPT/Claude/Cursor), 6 tools sin tool de ejecución, firma siempre en Onda. **Decisiones Q-M1..Q-M5 registradas el 2026-11-27** (detalle en spec 07 §Decisiones registradas): auth v1 por API tokens (OAuth 2.1 → 1.3), entrega de estado por polling (sin push en 1.2), conexión manual solamente (URL + token) hasta connects probados + H11 cerrado, tokens con vencimiento a 90 días, y **dominio propio como paso precondition explícito antes del onboarding público** (elegir/comprar el dominio: owner Dino; el hostname de Azure queda staging-only para `/mcp`). Implementación pendiente |
| 2 — Phantom Connect multi-usuario | Pendiente: embedded wallets por usuario, spending limits. Cruzar con H11 en [06](specs/06-roadmap-risks.md): la demo sigue interna hasta verificar la elegibilidad xStocks en Argentina |
| 3 — Ramp ARS → USDC | Pendiente: proveedor, KYC y settlement como spec propia. Cruzar con H11 en [06](specs/06-roadmap-risks.md) |
