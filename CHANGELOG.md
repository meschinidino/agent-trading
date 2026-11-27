# Changelog

## [Unreleased]

### Changed
- Landing con demo guiada del flujo real (refs DIN-24).

## [0.5.0] - 2026-11-27

### Added
- **Ficha por activo (info + IPO/inception) en web y MCP (refs DIN-26):** `GET /api/v1/assets` y `GET /api/v1/assets/:symbol` devuelven la vista mergeada por activo (registry + datos vivos de Jupiter con cache server-side de 60s y fail-soft a null: precio, cambio 24h, volumen 24h, market cap del subyacente vía `stockData` de price/v3, holders, estándar Token-2022; + dataset curado tipado en `apps/api/src/asset-info.ts` con emisor xStocks/Backed, subyacente, exchange, sector y fecha IPO/inception — SPY 1993-01-22 inception, AAPL 1980-12-12 IPO, NVDA 1999-01-22 IPO — cada campo con `sourceName`/`sourceUrl`/`asOf`). Los campos sin fuente honesta y keyless (dividend yield) quedan null/ausentes: no se inventan números ni se cachean precios como estáticos.
- **MCP: nueva tool read-only `onda_get_asset_info`** (7 tools; scope existente `read:portfolio`, sin scopes nuevos y sin tool execution-adjacent): misma ficha tipada con fuente/asOf y `mode:"paper"`. Justificación: `onda_list_assets` debe seguir liviana para resolver símbolos; la ficha completa es una lectura distinta y opt-in.
- **Web: panel de ficha del activo en el rail** (sin modal: la app no tiene modales y el rail ya es el lenguaje de detalle), alcanzable desde las filas de watchlist y desde posiciones, en ES y EN (todas las strings nuevas en ambos diccionarios de `i18n.ts`), con nota de respaldo 1:1 xStocks, microcopy `Fuente: … · al …` para lo curado y precio desde el mismo path de Jupiter. Acento V1 `--lime` (#a8c256), sin colores nuevos.
- Tests: shaping del endpoint de assets incl. fail-soft con Jupiter caído, schema del dataset curado, y `onda_get_asset_info` con el cliente MCP real del SDK.

## [0.4.1] - 2026-11-27

### Changed
- Paleta de acento V1 Lima domado en landing + app (refs DIN-21).


## [0.4.0] - 2026-11-27

### Added
- **Onda MCP (fase 1.2, spec 07) detrás de `MCP_ENABLED` (default `false`; no prendido en Azure):** servidor MCP remoto Streamable HTTP stateless en `/mcp` sobre el mismo Fastify, con el SDK oficial `@modelcontextprotocol/sdk@1.32.2`. 6 tools sin tool de ejecución/confirmación: `onda_list_assets`, `onda_get_portfolio`, `onda_get_limits`, `onda_quote_swap`, `onda_propose_trade`, `onda_get_confirmation`. Signing siempre en Onda: `propose` devuelve `signingUrl` a `/confirm/<id>` (deep link que la web carga con la sesión normal) y el cliente solo hace polling.
- **API tokens por usuario:** endpoints `GET/POST/DELETE /api/v1/settings/mcp-tokens`, scopes cerrados `read:portfolio`/`quote`/`propose` (sin `execute`), secreto mostrado una sola vez, server-side solo SHA-256 hash, vencimiento 90 días (Q-M5). Revocar o vencer expira las confirmations pendientes creadas bajo ese token; `proposedVia {channel, tokenId, clientName, clientVersion}` queda en audit/confirmation y `decidedBy` sigue siendo el `userId` que firma en la web.
- **Settings UI en la web** (mismo sistema de diseño, sin tocar colores): panel "Agentes externos (MCP)" con lista de tokens (nombre/scopes/created/expiresAt/lastUsedAt), crear con secreto de un solo uso, revocar, frase de descubrimiento honesto de spec 07 §5.6 y endpoint desde `PUBLIC_BASE_URL`.
- Tests con **cliente MCP real** (SDK client por HTTP contra Fastify): lifecycle de tokens, tools/list, quote persistida→propose→poll, IDOR entre usuarios, scopes, token vencido/revocado y rate limit por token (60/min, quote 10/min, propose 5/min). Env nuevas: `MCP_ENABLED`, `PUBLIC_BASE_URL`.

## [0.3.2] - 2026-11-27

### Fixed
- Landing screenshots now match the site language. The EN landing no longer shows the app in Spanish ("Confirmá tu compra", "Deslizá para firmar", "Invertís/Recibís"): `site/assets/` now ships real captures per language (`en/` + `es/` — start, confirmation card, receipt) and the EN/ES toggle swaps the images with the copy. No pixel-edited translations; every screenshot is a straight render of the real app.

### Added
- English display seed in the app (`apps/web/src/i18n.ts`): all UI chrome in `apps/web` (header, auth, portfolio rail, confirmation card, receipt, prompts) renders in English via `?lang=en`, the header ES/EN switch, `localStorage onda-app-lang`, or an English browser locale; number formatting follows the locale. Scope is display strings only — the agent parser/chat still understands es-AR only: chat orders are always composed in Spanish, server agent prose is not machine-translated, and the English UI + landing caption disclose that. This is a UI seed, not English chat support.


## [0.3.1] - 2026-11-27

### Changed
- Landing copy: faster, shorter. Hero is now one idea at display size — "Your own personal broker." / "Tu broker personal." — with the mechanism + gate in a ≤22-word subline, one primary CTA above the fold (`Try the live demo`) and `Read the code` as a quiet text link. Below the fold compressed by ≥50% per section: 3 numbered one-liner steps with smaller screenshots, gate headline + 3 bullets, tighter two-doors table (MCP still `Spec · roadmap — not live`), and a 2-line paper-demo notice. Visible copy went from 645 to 270 words (text-node count on `site/index.html`, EN). Cold-dark terminal system unchanged; no new palette, serif, gradient text, or eyebrow chips.

## [0.3.0] - 2026-11-27

### Added
- Public landing page in `site/` (static, dependency-free, EN primary + ES toggle): real product screenshots, the confirmation-gate story, an honest paper-demo framing, and the BYOA/MCP door labeled as spec 07 / roadmap (not live). Ready to deploy on Cloudflare Pages (`wrangler.toml`, project `onda`); see `site/README.md`. All CTAs point to the live Azure app.

## [0.2.2] - 2026-11-27

### Changed
- Decisiones **Q-M1..Q-M5** de [07-onda-mcp.md](docs/specs/07-onda-mcp.md) registradas (Dino, 2026-11-27): auth v1 por API tokens (OAuth 2.1 → fase 1.3), directorios solo tras connects manuales probados + H11 cerrado, dominio propio obligatorio antes del onboarding público de MCP (Azure staging-only para `/mcp`), estado por polling sin push en 1.2, y tokens de agente con vencimiento a los 90 días con `expiresAt` visible y efecto de revocación al vencer. Sin código de producto.

## [0.2.1] - 2026-11-27

### Added
- Spec [07-onda-mcp.md](docs/specs/07-onda-mcp.md) (fase 1.2, solo especificación): Onda como servidor MCP remoto para agentes externos del usuario (BYOA), con catálogo de 6 tools sin tool de ejecución, auth por API tokens en v1 y firma siempre en la web de Onda.

### Fixed
- El diagrama de arquitectura y la documentación pública ya no nombran ninguna máquina personal: el componente de firma se identifica como servicio en el host del operador, y se neutralizaron las referencias personales en README (EN/ES), specs y deploy.

## [0.2.0] - 2026-11-27

### Added
- UI Terminal amable implementada en la web real desde el mockup aprobado: terminal oscura fría, confirmación como objeto de swap de Jupiter con slide-to-sign, layout con thread central, rail de portfolio y strip de precios en vivo.
- Branding de producto **Onda** — nombre de producto aprobado; reemplaza el wordmark interno "Agente Inversor" en la UI y el título. El repo sigue siendo `agent-trading`.
- Deploy público en Azure: Container Apps con web + API en el mismo origen, SQLite persistente en Azure Files, `deploy/Dockerfile` y `SERVE_WEB=true` para servir el build web same-origin. Vivo como "Onda — Tu agente inversor" en https://onda.wonderfulsky-b50ff12c.eastus.azurecontainerapps.io/ (resource group `rg-agent-trading-preview`, ~USD 20–30/mes).
- Flujo agéntico probado en vivo sobre la URL pública: register → wallet paper → depósito → compra paper de SPYx con slide-to-sign → portfolio e historial.

### Changed
- La dirección de diseño web cambió: la editorial C (PR #5, pulida en PR #6) quedó reemplazada por Terminal amable tras el teardown DIN-12 y se implementó en PR #7. La editorial C queda como antecedente histórico, no como dirección vigente.
- Documentación sincronizada con la realidad (README raíz bilingüe EN/ES, roadmap, spec 06, `deploy/README.md`): el producto está live, la audiencia de la demo es interna y las decisiones del proyecto quedan registradas.
- Licencia cambiada de MIT a Apache-2.0 (© 2026 Dino Meschini).

### Notes / todavía no está
- **Ejecución real apagada:** `EXECUTION_ENABLED=false`. Las compras son paper: quotes, precios, simulación y balances de la agent wallet son reales y en vivo; la acreditación paper es la única capa ficticia.
- **La firma real vía Phantom MCP sigue corriendo en el host del operador (single-tenant dev host today)** (la session vive ahí); no hay firma desde la API en Azure.
- **El modo Eve/LLM está apagado sin keys de modelo:** el chat corre con `AGENT_MODE=parser` (parser determinístico). El scaffold de Eve 1.5.0 existe pero no finge un LLM.
- **SSE decidido pero no implementado:** se eligió SSE sobre polling para el estado en vivo (Q3); es el próximo paso en fase 1.1, hoy no existe en el código.
- El mockup estático de diseño sigue vivo en https://agenttradingprev6cbfcf.z13.web.core.windows.net/ (solo mockup; no es la app).

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
