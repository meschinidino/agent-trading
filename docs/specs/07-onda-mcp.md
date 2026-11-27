# 07 — Onda MCP (Bring Your Own Agent)

## Objetivo

Definir Onda como infraestructura operable desde agentes externos vía Model Context Protocol (MCP), sin duplicar la lógica de negocio ni debilitar el confirmation gate: un usuario le dice a ChatGPT, Claude o Cursor "quiero comprar S&P 500", ese agente cotiza y propone vía Onda MCP, y **la firma ocurre siempre en Onda** (web, slide-to-sign), nunca en el chat externo. Esta spec es de fase 1.2: especifica el contrato implementable; no implementa código.

## Alcance

- Concepto y positioning: dos puertas, una casa (harness Onda + BYOA vía MCP sobre el mismo backend).
- Transporte remoto MCP, hosting, versionado y variante local de desarrollo.
- Auth por usuario para agentes externos (v1 y evolución), scopes, rate limits y auditoría.
- Catálogo de 6 tools con schemas, anotaciones, errores y mapeo a servicios internos de [05-backend-api.md](05-backend-api.md).
- Flujos de onboarding por cliente (ChatGPT, Claude, Claude Code, Cursor) y walkthrough completo.
- Seguridad, abuso, kill switch, compatibilidad, flags, observabilidad.
- Roadmap fase 1.2 vs fases posteriores y preguntas abiertas para el titular del proyecto (con recomendación).

## Fuera de alcance

- Código de producto, deploy y publicación en directorios (eso es fase posterior; acá solo se especifican los requisitos).
- Una tool de ejecución directa. **No existe ni va a existir `onda_execute_*`**: la ejecución sigue siendo interna del backend tras una confirmation firmada en Onda ([04-confirmation-gate.md](04-confirmation-gate.md)).
- Ventas (xStock → USDC), tokens fuera del registry de [02-swaps-xstocks.md](02-swaps-xstocks.md), market data genérico para terceros, API pública REST para terceros (MCP es la superficie externa; REST sigue siendo contrato interno de producto, [05-backend-api.md](05-backend-api.md)).
- Custodia nueva: Onda MCP no firma, no guarda claves y no toca el path de firma de [01-wallet.md](01-wallet.md).

## Detalle

### 1. Concepto y positioning: dos puertas, una casa

Onda existe en dos formas que comparten exactamente el mismo backend:

| Puerta | Quién es el agente | Dónde conversa el usuario | Dónde firma |
|---|---|---|---|
| **Onda harness** (hoy) | Eve / parser interno vía `POST /chat/message` | Web de Onda | Web de Onda (slide-to-sign) |
| **Onda MCP** (esta spec) | Agente externo del usuario: ChatGPT, Claude, Cursor, Claude Code, cualquier cliente MCP | El chat del cliente externo | **Web de Onda (slide-to-sign), siempre** |

Lo que Onda-the-infra vende no es "otro chatbot": es la infraestructura que un agente externo no tiene y no debería improvisar con plata:

1. **Registry verificado** de xStocks ([02-swaps-xstocks.md](02-swaps-xstocks.md)): allowlist cerrada SPYx/AAPLx/NVDAx + USDC, con boot check fail-closed contra Jupiter.
2. **Quotes vivas de Jupiter** persistidas server-side, single-redemption, con minimum-out y slippage fijados solo por política del backend.
3. **Confirmation gate con firma humana en Onda**: máquina de estados de [04-confirmation-gate.md](04-confirmation-gate.md), TTL único visible, una pendiente por usuario, idempotencia downstream.
4. **Ledger y portfolio** con `mode: "paper" | "real"` end-to-end, sin mezclar saldos paper con balances on-chain.
5. **Audit log append-only con hash chain**, `decidedBy` = `userId` autenticado.

**Regla fundacional:** un "sí" en ChatGPT/Claude/Cursor **no es una firma**. El agente externo propone; el usuario firma en Onda con su sesión de Onda; el backend ejecuta o simula; el agente externo consulta el resultado. Ningún cliente MCP, por confiable que parezca, recibe capacidad de confirmar, rechazar en nombre del usuario con efecto de firma, ni ejecutar.

### 2. Transporte y hosting

#### 2.1 Transporte canónico: Streamable HTTP remoto

- **Endpoint:** `POST/GET https://onda.wonderfulsky-b50ff12c.eastus.azurecontainerapps.io/mcp` (mismo origen y mismo servicio Azure Container Apps que la API actual; cuando exista dominio propio, `https://<dominio-onda>/mcp`). Puerto 443, HTTPS obligatorio.
- **Transporte:** Streamable HTTP según MCP spec `2025-06-18` (y compatibilidad con `2025-03-26`, que lo introdujo reemplazando HTTP+SSE). El servidor acepta JSON-RPC por `POST`; `GET` solo si se habilita streaming SSE de notificaciones (v1 no lo requiere, ver §2.2).
- **Por qué no stdio como superficie pública:** stdio es local por diseño (proceso hijo del cliente, credenciales por entorno según la spec de autorización MCP). ChatGPT y Claude (web/desktop) conectan solo a servidores MCP **remotos** por HTTPS; un servidor stdio jamás es alcanzable desde sus nubes. stdio queda como variante opcional de desarrollo local (§2.3).
- **Descubrimiento dentro del protocolo:** tras `initialize`, el cliente recibe `serverInfo` (`name: "onda"`, `title: "Onda — Tu agente inversor"`, `version` = versión del contrato MCP, ver §2.4) y `instructions` cortas que declaran: qué hace Onda, que opera solo SPYx/AAPLx/NVDAx desde USDC, que toda operación requiere firma del usuario en Onda, y que hoy `mode` es `"paper"`. La descripción del servidor y de cada tool es la superficie de tool-selection del LLM: se escribe para el modelo, no para el humano (ver §4).

#### 2.2 Sesión y statelessness

**Decisión propuesta: servidor stateless por request (sin `Mcp-Session-Id` obligatorio en v1).** Cada llamada a una tool es autocontenida: auth por header en cada request (exigencia de la spec de autorización MCP: el token viaja en *cada* request HTTP), y todo el estado durable (quotes, confirmations, ledger) ya vive en la base del backend según [05-backend-api.md](05-backend-api.md). Razones:

- El estado de negocio nunca debió vivir en la sesión MCP: una quote o una confirmation se recuperan por ID con ownership, igual que en REST.
- Stateless simplifica escalar y reiniciar el contenedor en Azure (la sesión SQLite ya persiste en Azure Files; no se suma un store de sesiones MCP).
- Los clientes objetivo (ChatGPT, Claude, Cursor, Claude Code) soportan Streamable HTTP stateless; el polling de estado lo hace el agente con `onda_get_confirmation`, no hacen falta notificaciones server→client en v1.

Si una fase posterior necesita streaming (p. ej. avisar `executed` sin polling), se habilita `GET` con SSE y sesiones, como cambio menor versionado (§2.4), sin romper v1.

#### 2.3 Variante stdio (solo desarrollo)

Opcional y fuera del path de release: un shim stdio local que reenvía al endpoint remoto (o levanta el mismo servidor en proceso para desarrollo contra la API local). Sirve para Claude Code/Cursor en la máquina del operador durante el desarrollo. No se distribuye, no se documenta como instalación para usuarios y nunca lleva credenciales de producción embebidas.

#### 2.4 Versionado del contrato MCP

- El contrato MCP se versiona por separado del producto: `mcp contract v1` = las 6 tools de §4 con los schemas publicados acá.
- Cambios aditivos (tool nueva, campo opcional nuevo en output) no rompen v1. Cambios que quitan/renombran tools o campos, o cambian semántica, exigen `v2` conviviendo con `v1` al menos un ciclo de release.
- `serverInfo.version` refleja la versión del contrato (p. ej. `"1.0.0"`), no la versión del producto. La versión del producto se expone en `onda_get_limits` (`serverVersion`).
- Deprecación: una tool marcada deprecada en su `description` sigue funcionando al menos un release completo antes de removerse en un major nuevo.

### 3. Auth: quién es el usuario para un agente externo

#### 3.1 Opciones evaluadas

| Opción | Qué exige | Fricción de onboarding | Estado del ecosistema (verificado, §3.5) |
|---|---|---|---|
| **A. OAuth 2.1 completo** (Onda como authorization server: RFC 9728 Protected Resource Metadata, RFC 8414 metadata, RFC 7591 Dynamic Client Registration, PKCE, resource indicators RFC 8707) | Implementar AS propio o integrar uno; cada cliente se registra y hace el flow | La mejor: "Conectar → login en Onda → listo", sin copiar tokens | Es lo que la spec MCP `2025-06-18` prescribe para HTTP remoto y lo que Claude/ChatGPT esperan para connectors "de directorio". Es también lo más caro de construir bien |
| **B. API tokens bearer de larga vida** emitidos por Onda (el usuario crea un token en Settings, lo pega en el cliente) | Tabla de tokens hasheados + scopes + revocación; el cliente lo manda como `Authorization: Bearer` | Media: copiar/pegar una vez por cliente. Claude lo soporta vía *Request headers* en custom connectors; Claude Code vía `--header`; Cursor vía `headers` en `mcp.json`; ChatGPT lo soporta en el alta manual pero su flujo de directorio favorece OAuth | Funciona hoy en todos los clientes objetivo para conexión manual |
| **C. Ambas** (B en v1, A como evolución) | B ahora; A sin cambiar tools ni scopes | v1 manual, después one-click | Ruta recomendada |

**Recomendación (decisión para el titular del proyecto, Q-M1 en §8): v1 = opción B (API tokens), fase 1.3 = opción A (OAuth 2.1).** B es simple, revocable y auditable hoy; A es requisito práctico para directorios y para que el onboarding sea "Conectar" sin copy-paste, pero construir un authorization server correcto (DCR, PKCE, audience binding) es un proyecto en sí y no debe bloquear el primer connect manual que pruebe la tesis BYOA.

En ambas opciones el servidor MCP actúa como *resource server*: valida el bearer en cada request, rechaza con `401` (y, cuando exista OAuth, con `WWW-Authenticate` apuntando al metadata RFC 9728, como exige la spec).

#### 3.2 Tokens v1 (opción B) — especificación

- **Emisión:** en Onda web → Settings → "Agentes externos (MCP)": el usuario crea un token con nombre libre (p. ej. "ChatGPT", "Cursor laptop"). El secreto se muestra **una sola vez** al crearlo. Formato: prefijo `onda_mcp_` + al menos 32 bytes aleatorios en base64url. Server-side se guarda solo `SHA-256(token)` (o HMAC con secreto de servidor), nunca el token en claro.
- **Scopes (allowlist cerrada):** `read:portfolio`, `quote`, `propose`. **No existe scope `execute` ni `confirm`**: no hay operación MCP que los consuma, porque confirmar/firmar es exclusivo de la sesión web de Onda. Un token sin `propose` puede cotizar y consultar pero no crear confirmations; uno sin `quote` no persiste quotes.
  - Presets al crear: "Solo lectura" (`read:portfolio`) y "Operar con confirmación en Onda" (`read:portfolio` + `quote` + `propose`; es el default sugerido, con copy que aclara que operar siempre exige firmar en Onda).
- **Rotación y revocación:** el usuario puede revocar un token en cualquier momento desde Settings (efecto inmediato, ver kill switch §6.4) y crear uno nuevo para rotar. Sin expiración automática en v1, pero Settings muestra `lastUsedAt` y creaciones de más de 90 días se marcan visualmente como viejas. (Expiración configurable queda para la fase OAuth.)
- **Mapeo a usuario:** `token → userId` es la única autoridad. Toda tool resuelve `userId` del token y aplica **las mismas reglas de ownership de [05-backend-api.md](05-backend-api.md)**: IDs ajenos responden como inexistentes (en MCP: error `NOT_FOUND` sin filtrar existencia), IDs impredecibles (UUID), y ninguna tool acepta `userId`, wallet address ni mint como parámetro de autoridad.
- **Identidad del cliente:** en cada call se registra el cliente MCP declarado en `initialize` (`clientInfo.name/version`) junto al `tokenId`. El audit de la confirmation guarda `decidedBy = userId` (quien firma en Onda, [04-confirmation-gate.md](04-confirmation-gate.md)) y, como dato nuevo, `proposedVia: { channel: "mcp", tokenId, clientName, clientVersion }`. La firma sigue siendo del usuario en Onda; el agente queda registrado como *proponente*, nunca como decisor.
- **Transporte del token por cliente:** header `Authorization: Bearer <token>` (Claude Code `--header`, Cursor `headers`, Claude custom connector *Request headers*). Jamás en query string (la spec MCP lo prohíbe para access tokens y aplica igual a API tokens).

#### 3.3 Rate limits por token

Extienden los de [05-backend-api.md](05-backend-api.md) (que rigen por usuario y siguen aplicando como techo global sobre la suma web + MCP):

| Límite | Valor v1 | Error |
|---|---|---|
| Calls MCP totales por token | 60/min | `RATE_LIMITED` |
| `onda_quote_swap` por token | 10/min y comparte el presupuesto de quotes por usuario y el global de 300 quotes/h de spec 05 | `RATE_LIMITED` / `QUOTE_BUDGET_EXCEEDED` / `GLOBAL_QUOTE_BUDGET_EXCEEDED` según el techo que corte |
| `onda_propose_trade` por token | 5/min; además rige "una confirmation pendiente por usuario" de [04-confirmation-gate.md](04-confirmation-gate.md) | `RATE_LIMITED` / `CONFIRMATION_SUPERSEDED` en la anterior |
| Polling `onda_get_confirmation` | Incluido en 60/min; la doc de onboarding recomienda al agente esperar ≥5 s entre polls y parar en estado terminal | — |

Los límites por token protegen contra un agente externo en loop; los de spec 05 siguen protegiendo costos de Jupiter/LLM y fondos. Al prender ejecución real, estos números se revisan en el mismo checklist CRITICAL de spec 05.

#### 3.4 OAuth 2.1 (fase 1.3, especificado desde ya)

Cuando se implemente, Onda publica: `/.well-known/oauth-protected-resource` (RFC 9728) apuntando a su authorization server, metadata RFC 8414, DCR (RFC 7591) para que Claude/ChatGPT se registren solos, authorization code + PKCE obligatorio, resource indicators (RFC 8707) con audience = URL canónica del servidor MCP, y los mismos tres scopes de §3.2. Los API tokens v1 conviven (clientes como Cursor/Claude Code con header manual) y la migración es por cliente, sin tocar tools.

#### 3.5 Hechos del ecosistema verificados (2026-11-27) y fuentes

- La spec MCP vigente (`2025-06-18`; existe draft posterior) define dos transports: **stdio** y **Streamable HTTP** (introducido en `2025-03-26`, reemplaza HTTP+SSE). Para HTTP, la spec de autorización exige **OAuth 2.1**, Protected Resource Metadata (RFC 9728), metadata del AS (RFC 8414), recomienda DCR (RFC 7591) y binding de audience (RFC 8707); el token va como `Authorization: Bearer` en cada request y nunca en query string. Fuentes: `modelcontextprotocol.io/specification/2025-06-18/basic/transports`, `.../basic/authorization`.
- Las anotaciones de tools de la spec son `readOnlyHint` (default `false`), `destructiveHint` (default `true`), `idempotentHint` (default `false`), `openWorldHint` (default `true`), más `title`. Son *hints* no verificables por el cliente: un servidor puede mentir, por eso §6 los trata como UX, no como seguridad. Fuente: `modelcontextprotocol.io` (schema de tools) y blog MCP "Tool Annotations as Risk Vocabulary" (2026-03-16).
- **Claude:** los *custom connectors* remotos se agregan en Customize → Connectors → "Add custom connector" con la URL del servidor MCP; la conexión sale desde la infraestructura de Anthropic (el servidor debe ser público en 443), y la auth puede ser OAuth (con DCR, CIMD o cliente propio; redirect `https://claude.ai/api/mcp/auth_callback`) o **headers fijos** (API key/bearer) configurados en el alta. Fuente: Claude Help Center, "Get started with custom connectors using remote MCP" (`support.claude.com/en/articles/11175166`) y `claude.com/docs/connectors/building`.
- **Claude Code:** `claude mcp add --transport http <name> <url> --header "Authorization: Bearer <token>"` es la forma documentada para HTTP remoto con bearer; en JSON el `type` acepta `http` (alias `streamable-http`). Fuente: `code.claude.com/docs/en/mcp`.
- **ChatGPT:** conecta solo servidores MCP **remotos** (HTTPS, SSE o Streamable HTTP; nada local sin túnel). El alta manual de un servidor propio existe hoy vía Plugins → "Add custom MCP server" (la superficie se llamó Connectors → Apps/Developer Mode → Plugins entre 2025 y 2026: **la UI exacta cambia seguido — UNVERIFIED en su forma final**, verificar al implementar). OpenAI exige para publicación en directorio anotaciones explícitas `readOnlyHint`/`destructiveHint`/`openWorldHint` por tool y revisa que coincidan con el comportamiento. Fuentes: `help.openai.com/en/articles/12584461`, `developers.openai.com/plugins/deploy/submission`.
- **Cursor:** servidores remotos por `~/.cursor/mcp.json` o `.cursor/mcp.json` con `url` + `headers` (`${env:VAR}` soportado) o por OAuth si el servidor lo anuncia vía RFC 9728 — ojo: si el servidor publica discovery OAuth, Cursor puede preferir OAuth sobre el header configurado. Fuente: docs de Cursor citadas por guías MCP 2026 (verificar contra `cursor.com/docs` al implementar — UNVERIFIED en detalle fino).
- **Directorios:** existen hoy dos vías de publicación con revisión: OpenAI (portal de Plugins en `platform.openai.com/plugins`, verificación de dominio con `/.well-known/openai-apps-challenge`, test cases y credenciales de reviewer) y Anthropic (Connectors Directory vía `claude.ai/directory/manage`, escaneo de compliance; hay reportes de revisiones lentas — tiempos UNVERIFIED). Ninguna de las dos es requisito para el connect manual.
- **Descubrimiento automático: no existe.** Ningún cliente actual "descubre" servidores MCP porque un usuario mencione un producto en el chat: no hay registro global consultado en tiempo de conversación. Lo honesto se especifica en §5.5.

### 4. Catálogo de tools

Convenciones comunes:

- Nombres con prefijo `onda_` (namespace claro en clientes con muchos servidores).
- Toda respuesta incluye `mode: "paper"` hoy (y `"real"` solo cuando el flag de ejecución real esté prendido para ese usuario). Ninguna respuesta presenta montos paper como on-chain.
- Errores en el formato MCP: el resultado lleva `isError: true` y un objeto `{ code, message }` con `code` del catálogo de abajo; los mensajes son en español rioplatense neutro, pensados para que el agente los reformule, no para mostrarse crudos necesariamente.
- Códigos de error compartidos: `UNAUTHORIZED` (token inválido/revocado/ausente), `FORBIDDEN_SCOPE` (token sin el scope), `NOT_FOUND` (ID inexistente o ajeno), `VALIDATION` (input fuera de schema o activo fuera del registry), `COMPLIANCE_INELIGIBLE` (activo/jurisdicción no elegible, [02-swaps-xstocks.md](02-swaps-xstocks.md)), `QUOTE_EXPIRED`, `QUOTE_CONSUMED`, `PRICE_IMPACT_TOO_HIGH` (>3%), `INSUFFICIENT_BALANCE`, `CONFIRMATION_NOT_PENDING` (ya decidida/expirada/superseded), `RATE_LIMITED`, `QUOTE_BUDGET_EXCEEDED`, `GLOBAL_QUOTE_BUDGET_EXCEEDED`, `MCP_DISABLED` (flag apagado), `INTERNAL`.
- Schemas en JSON Schema (draft 2020-12 compatible con el subconjunto que aceptan los clientes MCP). Montos monetarios de entrada en USD humanos (`amountUsd`, número > 0); montos de salida del sistema en unidades humanas + atómicas cuando aplique, igual que spec 05.

#### 4.1 `onda_list_assets`

- **Descripción (para el LLM):** "Lista los activos que Onda puede operar hoy (S&P 500, Apple, NVIDIA como xStocks en Solana) con su símbolo, nombre y mint. Usala para resolver qué activo quiere el usuario antes de cotizar; si el activo pedido no está en esta lista, Onda no lo opera."
- **Anotaciones:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. Scope: ninguno (pública dentro de sesión autenticada; igual exige token válido).
- **Input:** `{}`.
- **Output:** `{ mode, assets: [{ symbol: "SPYx", name: "S&P 500 (SP500 xStock)", aliases: ["S&P 500", "SP500", "S&P"], mint, decimals: 8, eligible: true }] }` para SPYx/AAPLx/NVDAx (los `aliases` son los del alias map canónico del backend de [03-agent-flows.md](03-agent-flows.md); el registry y la elegibilidad salen de [02-swaps-xstocks.md](02-swaps-xstocks.md)).

#### 4.2 `onda_get_portfolio`

- **Descripción:** "Devuelve el portfolio del usuario en Onda: saldo USDC y posiciones, separando saldo real on-chain de posiciones paper (campo `mode` por fila). Usala para responder cuánto tiene el usuario o si le alcanza antes de proponer una compra. Nunca inventes saldos: si no llamaste esta tool, no conocés el portfolio."
- **Anotaciones:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. Scope: `read:portfolio`.
- **Input:** `{}` (sin `userId`: sale del token).
- **Output:** el mismo shape que `GET /portfolio` de spec 05: `{ mode, walletAddress, usdc: { amount, mode }, positions: [{ symbol, amount, usdValue, mode }] }`.
- **Errores:** `UNAUTHORIZED`, `FORBIDDEN_SCOPE`, `RATE_LIMITED`, `INTERNAL`.

#### 4.3 `onda_get_limits`

- **Descripción:** "Devuelve los límites operativos vigentes de Onda para este usuario: topes por propuesta y por día, slippage aplicado por el backend, impacto máximo permitido, y si la ejecución es paper o real (`mode`). Consultala si el usuario pregunta límites o antes de proponer montos grandes."
- **Anotaciones:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. Scope: `read:portfolio`.
- **Input:** `{}`.
- **Output:** `{ mode, executionEnabled: false, serverVersion, mcpContractVersion: "1.0.0", perProposalCapUsd, dailyCapUsd, slippageBps: 50, maxPriceImpactPct: 3, confirmationTtlSeconds: 60, quoteTtlSeconds: 30, scopes: [...] }` (valores desde la política del backend; los topes paper actuales son los de spec 01/CHANGELOG: 25 USD/propuesta y 50 USD/día, leídos de config, no hardcodeados en la tool).

#### 4.4 `onda_quote_swap`

- **Descripción:** "Cotiza en vivo (Jupiter) una compra de un xStock con USDC y persiste la cotización en Onda. Devuelve el `quoteId` y el resumen exacto que el usuario vería al firmar. Cotizar no compra nada ni crea una propuesta: para proponer usá `onda_propose_trade` con este `quoteId`. El slippage y el minimum-out los fija Onda; no podés cambiarlos."
- **Anotaciones:** `readOnlyHint: false` (persiste una quote server-side), `destructiveHint: false`, `idempotentHint: false` (cada call es una quote nueva), `openWorldHint: true` (consulta Jupiter en vivo). Scope: `quote`.
- **Input:** `{ symbol: "SPYx" | "AAPLx" | "NVDAx", amountUsd: number }`. El backend resuelve `symbol → mint` desde el registry (el agente nunca manda mints), valida saldo con la misma regla de balance-check de [03-agent-flows.md](03-agent-flows.md) y aplica el alias map solo como ayuda de selección previa vía `onda_list_assets` (la tool recibe símbolo canónico).
- **Output:** `{ mode, quoteId, symbol, name, amountInUsd, quotedOut, quotedOutAtomic, minOut, minOutAtomic, slippageBps: 50, priceImpactPct, priceImpactWarning: boolean, expiresAt, summary }` donde `summary` es el texto humano canónico del gate ([04-confirmation-gate.md](04-confirmation-gate.md)) para que el agente lo muestre tal cual.
- **Reglas heredadas (no negociables por el agente):** slippage 50 bps solo-backend (rango 10–100 por política), **hard reject si `|priceImpactPct| > 3%`** (`PRICE_IMPACT_TOO_HIGH`), warning entre 1% y 3% (`priceImpactWarning: true` y el agente debe mencionarlo), quote persistida y single-redemption con TTL 30 s ([05-backend-api.md](05-backend-api.md)), enforcement de elegibilidad en tiempo de quote (`COMPLIANCE_INELIGIBLE`).
- **Errores:** además de los comunes: `VALIDATION` (símbolo fuera del registry o monto inválido), `INSUFFICIENT_BALANCE`, `COMPLIANCE_INELIGIBLE`, `PRICE_IMPACT_TOO_HIGH`, `QUOTE_BUDGET_EXCEEDED`, `GLOBAL_QUOTE_BUDGET_EXCEEDED`.

#### 4.5 `onda_propose_trade`

- **Descripción:** "Crea en Onda una propuesta de compra (confirmation en estado pendiente) a partir de un `quoteId` vigente de `onda_quote_swap`, y devuelve el link para que el usuario la firme EN ONDA. Esta tool NUNCA ejecuta ni confirma: sin la firma del usuario en Onda, no se mueve nada. Después de proponer, mostrá el `signingUrl` y esperá; consultá el resultado con `onda_get_confirmation`. Si ya hay una propuesta pendiente del usuario, esta la reemplaza (la anterior queda superseded)."
- **Anotaciones:** `readOnlyHint: false`, `destructiveHint: false` (proponer es aditivo y reversible; no firma ni ejecuta — la honestidad de esta anotación se defiende en §6.3), `idempotentHint: true` (misma deduplicación usuario+quote de spec 05: repetir con el mismo `quoteId` vigente devuelve la misma confirmation), `openWorldHint: false`. Scope: `propose` (y exige `quote` implícito vía la quote consumida).
- **Input:** `{ quoteId }`. El backend valida que la quote es del usuario del token, está vigente y no consumida, y que consume la quote al crear la confirmation (single-redemption, spec 05). La confirmation nace en `proposed`; pasa a `pending_confirmation` cuando el usuario abre el link y la web acusa presentación (`/present` de spec 05), que es cuando arranca el TTL único `min(60 s, quote)`.
- **Output:** `{ mode, confirmationId, status: "proposed", symbol, amountInUsd, quotedOut, minOut, slippageBps, priceImpactPct, expiresAt, signingUrl, summary }`. `signingUrl` = deep link a Onda web (p. ej. `https://onda.../confirm/<confirmationId>`) que exige sesión de Onda del usuario (login si no la tiene) y presenta la tarjeta con slide-to-sign idéntica a la del harness.
- **Errores:** `QUOTE_EXPIRED`, `QUOTE_CONSUMED`, `NOT_FOUND` (quote ajena), `FORBIDDEN_SCOPE`, `RATE_LIMITED`, y `CONFIRMATION_NOT_PENDING` no aplica acá. Crear la propuesta **marca `superseded` la pendiente anterior** del usuario (misma transacción, [04-confirmation-gate.md](04-confirmation-gate.md)) — incluida una creada desde la web de Onda, y viceversa: una pendiente es una pendiente, venga de la puerta que venga.

#### 4.6 `onda_get_confirmation`

- **Descripción:** "Devuelve el estado de una propuesta de Onda por `confirmationId`: `pending` (esperando firma en Onda), `executed`, `rejected`, `expired`, `superseded` o `failed`, con el resultado real cuando ejecutó. Usala para contarle al usuario qué pasó después de que firmó (o no) en Onda. Un estado `pending` no es un éxito ni un fracaso: no afirmes que se compró hasta ver `executed`."
- **Anotaciones:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. Scope: `read:portfolio`.
- **Input:** `{ confirmationId }` (ownership por token: ajena → `NOT_FOUND`).
- **Output:** `{ mode, confirmationId, status, symbol, amountInUsd, quotedOut, minOut, actualOut?, actualOutAtomic?, txSignature?, explorerUrl?, errorCode?, createdAt, expiresAt, decidedAt?, executedAt? }`. El mapeo al enum interno de [04-confirmation-gate.md](04-confirmation-gate.md): `proposed`/`pending_confirmation` → `pending`; `executing` → `pending` con `statusDetail: "executing"`; `executed`/`rejected`/`expired`/`superseded`/`failed` homónimos. En `mode: "paper"` ejecutada: `actualOut` es el monto simulado a quote acreditado y `txSignature`/`explorerUrl` van ausentes (jamás un link a explorer para paper, [04-confirmation-gate.md](04-confirmation-gate.md)). En real: éxito solo tras finalidad `finalized` + reconciliación `actualOutAtomic >= minOutAtomic` ([02-swaps-xstocks.md](02-swaps-xstocks.md)).

#### 4.7 Lo que el catálogo deliberadamente no tiene

- **Sin tool de ejecución ni de confirmación/rechazo.** La decisión es `POST /confirmations/:id/confirm|reject` con sesión web de Onda y CSRF (spec 05), fuera de MCP por diseño.
- Sin tool de venta, sin transferencias, sin firma de mensajes/transacciones arbitrarias, sin acceso a claves o seeds (que Onda tampoco tiene: [01-wallet.md](01-wallet.md)).
- Sin tool de "buscar activos en internet": el universo operable es el registry cerrado; el agente externo puede investigar S&P 500 con sus propias herramientas, pero solo opera lo de `onda_list_assets`.

### 5. Onboarding por cliente y walkthrough

Pasos exactos con la superficie actual de cada cliente (verificadas en §3.5; la UI de ChatGPT es la más cambiante — re-verificar al implementar y al redactar la ayuda pública).

#### 5.1 Prerrequisito común (auth v1 por token)

1. El usuario entra a Onda web, se registra/inicia sesión y crea su wallet paper (flujo actual).
2. En **Settings → Agentes externos (MCP)** crea un token ("Operar con confirmación en Onda"), lo copia una vez y lo guarda.
3. URL del servidor para todos los clientes: `https://onda.wonderfulsky-b50ff12c.eastus.azurecontainerapps.io/mcp`.

#### 5.2 ChatGPT

1. En ChatGPT (web, plan pago con acceso a servidores MCP personalizados): ir a **Plugins → "Add custom MCP server"** (en versiones anteriores: Settings → Connectors → Developer Mode → crear conector; la ruta exacta varía — UNVERIFIED en su forma del día, la ayuda de Onda debe linkear la ayuda oficial de OpenAI).
2. Nombre: `Onda`. Server URL: la de §5.1. Auth: bearer/API key con el token de Onda donde el formulario lo pida (si el formulario solo ofrece OAuth, ese cliente queda para la fase 1.3 — decirlo honestamente en la ayuda).
3. Guardar/instalar y habilitar Onda en la conversación. Primera prueba sugerida: "¿Qué activos puedo operar con Onda?" → `onda_list_assets`.

#### 5.3 Claude (claude.ai / Desktop)

1. **Customize → Connectors → "+ Add" → "Add custom connector"**.
2. Nombre: `Onda`. URL: la de §5.1 → Continue.
3. En *Request headers*: `Authorization: Bearer <token-de-Onda>` (auth por header fijo soportada hoy). Si se elige OAuth, queda para fase 1.3.
4. "Add" y habilitar el connector en la conversación. (En planes Team/Enterprise, primero lo agrega un Owner a la organización y después cada usuario conecta el suyo.)

#### 5.4 Claude Code

```bash
claude mcp add --transport http onda https://onda.wonderfulsky-b50ff12c.eastus.azurecontainerapps.io/mcp \
  --header "Authorization: Bearer <token-de-Onda>"
```

Verificar con `claude mcp list`. El token queda en la config local del usuario; la ayuda recomienda scope de usuario (no de proyecto compartido) para no filtrarlo a un repo.

#### 5.5 Cursor

En `~/.cursor/mcp.json` (global) — o Settings → Tools & MCP → "Add a custom MCP":

```json
{
  "mcpServers": {
    "onda": {
      "url": "https://onda.wonderfulsky-b50ff12c.eastus.azurecontainerapps.io/mcp",
      "headers": { "Authorization": "Bearer ${env:ONDA_MCP_TOKEN}" }
    }
  }
}
```

Guardar y reiniciar Cursor; las tools `onda_*` aparecen en Available Tools.

#### 5.6 La verdad sobre el descubrimiento (honestidad obligatoria)

**Frase canónica para docs y ayuda (una línea):** *Hoy ningún agente descubre Onda solo: el usuario conecta Onda una vez (URL + su token) y recién ahí su ChatGPT/Claude/Cursor puede operar; el descubrimiento por directorios llega recién si OpenAI/Anthropic aprueban el listing.*

La visión del producto — decirle a ChatGPT "quiero comprar S&P 500", que busque online, encuentre a Onda y se conecte solo — **no existe hoy como mecanismo**: ningún cliente consulta un registro global en tiempo de chat, y Onda no puede inyectarse en una conversación ajena. Lo que sí existe y esta spec habilita:

1. **Connect manual una vez** (§5.2–§5.5): desde ahí, el agente ya conectado sí resuelve "quiero comprar S&P 500" → SPYx vía `onda_list_assets` sin ayuda del usuario.
2. **Directorios (fase posterior, §8):** si el listing se aprueba en ChatGPT Plugins y/o Claude Connectors Directory, el usuario encuentra "Onda" buscando dentro del directorio de su cliente y conecta con OAuth (fase 1.3). Incluso aprobado, el primer connect y la firma siguen siendo actos del usuario.
3. **Web abierta:** que ChatGPT navegando encuentre la landing de Onda con instrucciones de conexión es contenido/marketing, no un protocolo: puede ayudar a que el *usuario* decida conectar, nunca conecta por él.

Ningún copy de Onda (landing, ayuda, respuestas MCP) puede prometer auto-descubrimiento ni conexión sin acción del usuario.

#### 5.7 Walkthrough "quiero comprar S&P 500" (end-to-end)

1. **(Una sola vez)** El usuario conectó Onda en su cliente (§5.2–§5.5) con su token.
2. El usuario dice en ChatGPT: *"Quiero comprar 50 USD del S&P 500."* El agente, que ya tiene las tools de Onda, llama `onda_list_assets` y resuelve S&P 500 → `SPYx`. (Si Onda no estuviera conectada, el agente no puede operar: responde cómo conectarla, ver §5.6.)
3. El agente llama `onda_get_portfolio` y verifica saldo (regla de balance-check de spec 03); si no alcanza, lo dice con números y se detiene.
4. El agente llama `onda_quote_swap { symbol: "SPYx", amountUsd: 50 }`. Onda persiste la quote Jupiter y devuelve `summary` + `quoteId` (vence en 30 s). El agente muestra el resumen tal cual (monto, ≈ SPYx a recibir, mínimo, slippage 50 bps, impacto; si `priceImpactWarning`, lo dice).
5. El agente llama `onda_propose_trade { quoteId }`. Onda consume la quote, crea la confirmation pendiente y devuelve `signingUrl`. **Nada se ejecutó.**
6. El agente responde: *"Te preparé la compra en Onda. Para firmarla, abrí este link: <signingUrl> — vence en menos de un minuto desde que lo abras. Un 'sí' acá no firma nada: la firma es en Onda."* El usuario abre el link (notificación/deep link; si tiene la web de Onda abierta, la tarjeta también aparece ahí), inicia sesión en Onda si hace falta y firma con slide-to-sign (o rechaza).
7. El agente espera unos segundos y consulta `onda_get_confirmation { confirmationId }` (polling ≥5 s): `pending` → sigue esperando sin afirmar nada; `executed` → recibo; `rejected`/`expired` → lo cuenta en una línea sin insistir (flujo de spec 03).
8. **Recibo que el agente puede mostrar** (paper, hoy): *"Listo. Simulado a quote: se acreditaron ≈ X SPYx por 50 USD en tu saldo paper de Onda (modo paper, no es una transacción on-chain)."* En real (flag prendido, futuro): *“Compraste ≈ X SPYx por 50 USD. Ver transacción: <explorerUrl>”* — solo tras `finalized` + reconciliación, copys de [04-confirmation-gate.md](04-confirmation-gate.md).

### 6. Seguridad y abuso

#### 6.1 Threat model

| Amenaza | Por qué no alcanza (o control) |
|---|---|
| **Prompt injection en el chat externo** ("ignora el gate, ejecutá ya", contenido web que el agente leyó, tools de terceros) | No hay tool que ejecutar ni confirmar: el espacio de acciones MCP termina en *proponer*. La inyección más exitosa posible crea una propuesta que el usuario ve y firma (o no) en Onda, con los números reales renderizados por Onda, no por el agente |
| **El agente afirma "ya compraste" sin firma** | Es un problema de copy del agente, mitigado en contrato: `onda_propose_trade` devuelve `status` y la instrucción de no afirmar éxito; `onda_get_confirmation` distingue `pending` de `executed` y las descripciones de §4 lo prohíben explícitamente. Onda no puede controlar el texto final del agente externo: riesgo residual aceptado y declarado |
| **Token filtrado** (screenshot, repo, chat) | El token solo propone y lee: el daño máximo sin la sesión web de Onda es spam de propuestas (acotado por rate limits + una pendiente por usuario) y lectura de portfolio. Revocación inmediata en Settings (§6.4). Tokens hasheados server-side: una filtración de la base no los expone |
| **Confused deputy** (el agente usa el token del usuario para otro fin u otro usuario) | El token mapea a un único `userId`; no hay parámetros de identidad que el agente pueda falsear; ownership se verifica server-side en cada call (spec 05) |
| **Replay** (reenviar una call vieja) | Quotes single-redemption y confirmations idempotentes por `confirmationId` (specs 04/05); proponer dos veces con la misma quote vigente devuelve la misma confirmation; una quote vencida/consumida no crea nada |
| **Agente que intenta widen slippage / saltar caps / otro mint** | No existen esos parámetros en ningún schema; slippage, caps, registry y techo de impacto son política del backend ([02-swaps-xstocks.md](02-swaps-xstocks.md)) |
| **DoS / loop de quotes de un agente** | Rate limits por token + presupuestos de quotes de spec 05 (§3.3) |
| **El servidor MCP miente anotaciones** (riesgo genérico MCP) | Nuestras anotaciones son honestas (§6.3) pero la seguridad nunca depende de ellas: depende de que no exista tool ejecutora |

#### 6.2 Minimización de datos

El agente externo ve: activos del registry, portfolio del usuario (saldos y posiciones con `mode`), quotes y estados de confirmations que él mismo propuso (y cualquier pendiente del usuario vía su `confirmationId`, solo si conoce el ID). No ve: credenciales, cookies de sesión, claves (Onda no las tiene), `rawIntent` de otros canales, ni el audit completo. Los IDs son impredecibles (spec 05), así que conocer el formato no habilita enumeración.

#### 6.3 Honestidad de anotaciones

`onda_propose_trade` lleva `destructiveHint: false` y se defiende así: proponer crea una confirmation **pendiente y sin efecto financiero**, reversible por expiración/rechazo/supersede, y la acción destructiva potencial (firmar) está fuera del servidor MCP, en Onda. Marcarla `destructiveHint: true` sería mentir en la otra dirección y entrenaría a los clientes a pedir confirmaciones duplicadas sobre una acción que ya tiene su propio gate humano. `onda_quote_swap` es `readOnlyHint: false` con honestidad equivalente: persiste una quote (efecto server-side real, aunque sin efecto financiero). Las tools de lectura son `readOnlyHint: true` sin asteriscos: no escriben estado de negocio.

#### 6.4 Kill switch

- **Revocar un token** (Settings, un click) invalida el bearer al instante (la validación consulta estado del token en cada request; cache máxima tolerable: 0 en v1 dado el volumen).
- **Efecto sobre pendientes:** al revocar, las confirmations en `proposed`/`pending_confirmation` creadas por ese token (`proposedVia.tokenId`) pasan a `expired` en la misma operación y su `signingUrl` deja de funcionar. Las ya `confirmed`/`executing` **no** se tocan: ya hubo firma humana en Onda y frenarlas crearía el riesgo inverso. El evento queda en audit.
- **Kill switch global:** `MCP_ENABLED=false` (§7) apaga el endpoint `/mcp` completo (todas las tools devuelven `MCP_DISABLED` o el endpoint responde 404, a definir en implementación; criterio: que ningún cliente crea que Onda "anda mal" de forma ambigua) sin tocar la web ni la API.

### 7. Contrato de compatibilidad

#### 7.1 Una sola lógica de negocio

Las tools MCP son adaptadores finos sobre los **mismos servicios internos** que usa `apps/api` (mismo patrón que las tools finas de Eve en [03-agent-flows.md](03-agent-flows.md)). Está prohibido reimplementar reglas en la capa MCP: si una regla vive en el backend (registry, slippage, caps, TTL, ownership), la tool la consume, no la copia.

| Tool MCP | Servicio / endpoint interno (spec 05) |
|---|---|
| `onda_list_assets` | Token registry + elegibilidad ([02-swaps-xstocks.md](02-swaps-xstocks.md)) |
| `onda_get_portfolio` | `GET /portfolio` (servicio de portfolio: RPC real + `paper_positions`) |
| `onda_get_limits` | Política de límites del backend (specs 01/02/05) + flags de ejecución |
| `onda_quote_swap` | Servicio de quotes (= `quote_swap` de spec 03): persiste `quotes`, Jupiter `/order` |
| `onda_propose_trade` | Servicio de confirmations (= `execute_swap_behind_gate` de spec 03): consume quote, crea `confirmations`, supersede |
| `onda_get_confirmation` | `GET /confirmations/:id` con ownership |

La presentación y la decisión (`/present`, `/confirm`, `/reject`) **no** se mapean a MCP: quedan en la web.

#### 7.2 Flags, observabilidad, hosting

- **Flag:** `MCP_ENABLED` (default `false` hasta shippear fase 1.2). Con el flag apagado, el resto del sistema no sabe que MCP existe. Flags de ejecución (`EXECUTION_ENABLED`, `EXECUTION_MODE=paper`) son los mismos de siempre: MCP no agrega un camino para prenderlos.
- **Hosting:** mismo proceso/origen que la API en Azure Container Apps (ruta `/mcp` en el mismo Fastify o servicio hermano detrás del mismo hostname). Nada de un deploy separado con su propia base: comparte SQLite y servicios.
- **Observabilidad:** métricas por `tokenId` y por tool (calls, errores por `code`, latencia), correlación `confirmationId ↔ tokenId ↔ clientName` en logs/audit (`proposedVia`, §3.2), y alerta sobre picos de `RATE_LIMITED`/`UNAUTHORIZED` por token (señal de loop o de token filtrado). Sin contenido de tokens ni de `rawIntent` en logs de la capa MCP.
- **Evolución de spec 05:** esta spec **extiende** spec 05 en dos puntos que la implementación debe reflejar allí o en el código como fuente: la tabla de tokens MCP (`id, userId, name, tokenHash, scopes, createdAt, lastUsedAt, revokedAt`) y el campo `proposedVia` en el audit de confirmations. Hasta implementarlo, spec 05 sigue siendo el contrato vigente y esta es su extensión propuesta.

### 8. Roadmap y preguntas abiertas

#### 8.1 Fase 1.2 (esta spec) vs después

| Entra en 1.2 (implementación siguiente) | Queda para después |
|---|---|
| Servidor MCP Streamable HTTP stateless en `/mcp`, `MCP_ENABLED` default off | OAuth 2.1 completo (authorization server, DCR, metadata) → **fase 1.3** |
| API tokens v1 con scopes, emisión/rotación/revocación en Settings | Submissions a directorios (OpenAI Plugins, Claude Connectors Directory) con sus reviews, dominio verificado y test accounts → tras probar connects manuales |
| Las 6 tools de §4 sobre los servicios existentes | Notificaciones server→client / streaming (si el polling molesta) |
| Onboarding manual documentado para ChatGPT, Claude, Claude Code, Cursor | Venta (xStock → USDC) como tools nuevas, si entra al alcance del producto |
| Kill switch por token + global | Expiración configurable de tokens y tokens por-dispositivo |

#### 8.2 Riesgos

- **Churn del ecosistema:** la superficie de ChatGPT cambió de nombre tres veces en ~un año (Connectors → Developer Mode/Apps → Plugins) y los requisitos de directorio se endurecen (anotaciones, revisión). Mitigación: el contrato MCP (tools/schemas) es estable aunque cambie el envoltorio; la ayuda de onboarding se re-verifica en cada release y nunca se hardcodea en copy de producto sin link a la doc oficial.
- **Madurez de la auth MCP:** la spec de autorización es joven (2025) y los clientes la implementan con diferencias (DCR vs CIMD vs cliente propio; Cursor prefiriendo OAuth si hay discovery). Por eso v1 arranca con bearer simple, que todos soportan por header.
- **Carga de soporte:** cada cliente externo es una superficie de "no me conecta" que Onda no controla. Mitigación: onboarding con primera prueba de solo lectura (`onda_list_assets`), errores tipados y página de ayuda por cliente con la frase de descubrimiento honesto (§5.6).
- **H11 sigue abierto:** la elegibilidad xStocks en Argentina (UNVERIFIED, responsable: titular del proyecto, [06-roadmap-risks.md](06-roadmap-risks.md)) no se resuelve con MCP; al contrario, BYOA amplía la audiencia potencial. Hasta cerrarla: MCP solo para la demo interna, tokens solo para cuentas internas, y ningún listing público.

## Criterios de aceptación

- [ ] No existe ninguna tool MCP que ejecute, confirme o rechace: el catálogo completo es el de §4 y un "sí" en un chat externo no produce ningún cambio de estado firmable (verificable contra el schema publicado del servidor).
- [ ] Las 6 tools llaman a los mismos servicios que la API de spec 05 (tabla §7.1); no hay regla de negocio (slippage, caps, registry, TTL, ownership) implementada dos veces.
- [ ] Un token revocado deja de autenticar de inmediato y expira las confirmations pendientes que creó; un token sin scope `propose` no crea confirmations; ningún token puede leer confirmations ajenas (equivalente MCP del test IDOR de spec 05).
- [ ] `onda_quote_swap` rechaza impacto >3%, aplica slippage solo-backend y persiste quote single-redemption; `onda_propose_trade` con quote vencida/consumida/ajena no crea nada.
- [ ] Toda respuesta de tool lleva el `mode` correcto (`"paper"` hoy) y ninguna respuesta paper incluye `txSignature` ni link a explorer.
- [ ] El walkthrough §5.7 funciona en al menos Claude (custom connector) y Claude Code contra el servidor remoto: quote → propose → firma en Onda → poll con `executed` y recibo paper correcto.
- [ ] Con `MCP_ENABLED=false` el endpoint no opera y web/API no se enteran; con `true`, las métricas por token distinguen calls, errores y cliente.
- [ ] La ayuda de onboarding incluye la frase de descubrimiento honesto de §5.6 y ningún copy promete auto-descubrimiento ni ejecución desde el chat.

## Preguntas abiertas (para el titular del proyecto, con recomendación)

- **Q-M1 — Auth v1: ¿API tokens ahora, OAuth 2.1 después?** *Recomendación: sí — tokens bearer v1 (fase 1.2) y OAuth 2.1 en 1.3, como está especificado en §3.* La alternativa (OAuth primero) retrasa el primer connect real meses y es requisito de directorio, no de uso manual.
- **Q-M2 — ¿Listings en directorios (OpenAI/Anthropic) como objetivo de 1.3 junto a OAuth?** *Recomendación: sí, pero solo después de que los connects manuales funcionen y con H11 cerrado o con listing acotado a demo interna/paper claramente rotulada.* Un listing público con ejecución paper y H11 abierto es el peor de los mundos.
- **Q-M3 — ¿Dominio propio para `/mcp` antes de publicar onboarding?** La URL larga de Azure funciona pero es frágil como dirección pública permanente (si el recurso se recrea, cambia). *Recomendación: sí si el onboarding va a salir de la demo interna; no bloquea 1.2 interno.*
- **Q-M4 — ¿El polling del agente alcanza o se quiere aviso push (SSE/notificaciones MCP) en 1.2?** *Recomendación: polling en 1.2 (simple, stateless); streaming solo si la UX real lo pide.*
- **Q-M5 — ¿Tokens con expiración automática (p. ej. 90 días) desde v1?** *Recomendación: no obligatoria en v1 (fricción sin ganancia clara con revocación + `lastUsedAt` visibles); sí como opción del usuario.*

---

*Fuentes del ecosistema (consultadas 2026-11-27): MCP specification 2025-06-18 — transports y authorization (`modelcontextprotocol.io`); MCP blog, "Tool Annotations as Risk Vocabulary" (2026-03-16); Claude Help Center #11175166 (custom connectors, remote MCP) y `claude.com/docs/connectors/building` (+ submission); Claude Code MCP docs (`code.claude.com/docs/en/mcp`); OpenAI Help #12584461 (custom MCP servers in ChatGPT) y `developers.openai.com/plugins/deploy/submission`; docs y guías de Cursor MCP (`mcp.json`). Lo marcado UNVERIFIED en §3.5/§5 se re-verifica al implementar.*
