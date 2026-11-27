# Changelog

## [Unreleased]

- Nada por ahora.

## [0.1.0] - 2026-11-27

### Added
- MVP Track A (paper, sin fondos reales): usuarios (register/login con argon2, cookie httpOnly SameSite=Lax, CSRF en mutaciones, sesión de 8 h), paper wallet por usuario (ledger, sin claves) y wallet real del agente Phantom MCP como sistema view-only (DbjQ…pCcu).
- Faucet paper auditado (`paper_faucet`, tope 1000 USD), quotes reales de Jupiter en cada pedido (taker = agent wallet, slippage 50 bps backend-owned, hard reject price impact > 3%, warning > 1%), confirmation gate completo (proposed → pending_confirmation vía `/present` → executing con lease → executed/failed, un pendiente por usuario con supersede, TTL único `min(60s, quote 30s)`, idempotencia por `confirmationId`).
- Simulación real con `simulateTransaction` mainnet: primero la tx de Jupiter con taker = agent wallet (su error se registra tal cual); si falla por fondos, sustitución documentada `paper-substituted` (spec 01) que prueba la misma ruta con un taker fondeado. El monto acreditado es el `outAmount` de la quote persistida, etiquetado "simulado a quote", solo tras simulación OK.
- Portfolio con posiciones paper valuadas a precios Jupiter en vivo + balances reales on-chain de la agent wallet vía RPC; historial; audit log append-only con hash chain (`decidedBy` = userId autenticado).
- Chat con parser determinístico (alias SPYx/AAPLx/NVDAx, números es-AR) detrás de `AGENT_MODE=parser|eve`; scaffold Eve 1.5.0 real en `agent/` (instructions espejo + tools finas) sin fingir un LLM.
- Web mínima en español: registro/login, crear wallet, cargar USDC paper, chat, tarjeta de confirmación con countdown único, portfolio e historial. Todo rotulado "Modo demo paper".
- Seguridad: ownership 404, IDs UUID, CSRF, rate limits numéricos de spec 05 (20/min chat, 300 quotes/h global), topes paper 25 USD/propuesta y 50 USD/día, registry con boot check contra Jupiter (fail-closed), `EXECUTION_ENABLED=false`.

### Notes
- Specs: el paquete `docs/specs/**` se cerró contra la review gstack (20/20 hallazgos, PR #3) y el README raíz llegó en PR #2; esta es la primera versión con código de producto.
