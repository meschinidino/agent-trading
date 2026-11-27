# 06 — Roadmap y riesgos

## Objetivo

Ordenar el trabajo en fases con criterio de salida, y dejar los riesgos y las decisiones que son de Dino explícitos antes de escribir código.

## Alcance

- Fases 0 a 3 con entregables y criterio de salida.
- Riesgos técnicos, de compliance y de dependencia, con mitigación.
- Preguntas abiertas consolidadas (Q1–Q6) con recomendación.
- Decisiones registradas y tabla de cierre de hallazgos de la review gstack (AGEN-6).

## Fuera de alcance

- Estimaciones de fechas: se estima al cerrar cada fase, con lo aprendido en la anterior.
- Go-to-market, pricing y estrategia comercial.

## Detalle

### Fases

**Fase 0 — Validación manual (sin código de producto). Cumplida (DIN-4, cerrada Done), sin fondeo de Dino en mainnet.** Se instaló `@phantom/mcp-server`, se completó el device-code sign-in y se obtuvo la agent wallet address. La salida validada tiene dos planos: (a) **mainnet** — quotes reales de Jupiter v2 con `taker` = agent wallet, armado de transacción y paths de simulación, con saldo cero; (b) **devnet** — firma de Phantom MCP probada end-to-end con SOL/USDC de faucet: preview asertada con `advancedDetails.chainId` = `solana:103`, `confirmed: true` y signature `4apFAa2mRHGKWcrsZib49yZQBKyVgPpRpzHwNq9T9cMbiMmjtWgjtet9qtR9ewHpWzU9oY9nPBZdRHwk76DevRKy` finalized. Dino no mueve fondos en ninguna fase de validación.

**Fase 1 — Demo single-wallet, modo Track A.** Backend + agente Eve + chat UI + confirmation gate según [03-agent-flows.md](03-agent-flows.md) a [05-backend-api.md](05-backend-api.md). Track A: quotes reales de Jupiter (`/order` con `taker` + armado de transacción) y simulación en mainnet según [01-wallet.md](01-wallet.md), portfolio con balances on-chain reales más posiciones paper del ledger, y **monto simulado a quote acreditado solo tras simulación aprobada**. La ejecución real queda detrás de un config flag apagado por defecto; con el flag prendido, ejecuta Jupiter (firma vía Phantom MCP) y nunca Phantom `buy` ([02-swaps-xstocks.md](02-swaps-xstocks.md)). *Salida:* los criterios de aceptación **Track A** de [00-overview.md](00-overview.md) cumplidos en vivo, con al menos una acreditación simulada a quote, un rechazo y una expiración demostrados. Los criterios de firma real de [00-overview.md](00-overview.md) **no** son salida de Track A y no se dan por cumplidos con una compra simulada.

**Fase 2 — Multi-usuario.** Registro con Phantom Connect, una embedded wallet por usuario, spending limits (default USD 1.000/app/día de Connect como techo que agrega fricción sobre el umbral; el gate sigue obligatorio siempre — [04-confirmation-gate.md](04-confirmation-gate.md)), portfolio e historial por usuario. *Salida:* dos usuarios reales operando wallets distintas sin compartir session ni fondos; Jupiter sigue como ejecutor, con firma vía Connect ([02-swaps-xstocks.md](02-swaps-xstocks.md)).

**Fase 3 — Ramp en pesos.** El usuario fondea en ARS; un ramp de terceros convierte ARS → USDC directo a su wallet; el agente opera igual que hoy. *Salida:* fondeo ARS acreditado on-chain y compra posterior con el mismo gate. La elección del ramp (proveedor, KYC, costos, settlement) es una spec propia cuando llegue.

### Riesgos

| Riesgo | Impacto | Mitigación / estado |
|---|---|---|
| **xStocks: restricciones geográficas y KYC.** xStocks no está disponible en algunas jurisdicciones (incl. EE. UU. en algunos casos) y el issuer puede exigir KYC. | La demo o la fase 2 pueden ser inviables para ciertos usuarios sin aviso previo del proveedor. | **OPEN — riesgo abierto, no un supuesto** (único estado canónico; [00-overview.md](00-overview.md) debe leerse igual). Responsable: **Dino**. Verificación pendiente: elegibilidad positiva del operador en Argentina — **UNVERIFIED** — y de cualquier audiencia tercera. Hasta verificar: demo interna solamente, y el backend se niega a cotizar activos no elegibles en tiempo de quote, con el flujo de error de compliance de [03-agent-flows.md](03-agent-flows.md). Bloquea mostrar la demo a terceros; no bloquea Track A interno. |
| **Phantom MCP no es multi-tenant.** Session local por máquina, una agent wallet por instalación. | Bloquea escalar la demo tal cual. | Asumido por diseño: MCP es solo fase 0–1; la escala va por Phantom Connect ([01-wallet.md](01-wallet.md)). El canal backend → MCP queda cerrado a stdio/loopback en el mismo host y, si Eve se hostea remoto, a un canal privado autenticado ([01-wallet.md](01-wallet.md)). |
| **Spending limits mal calibrados (fase 2).** El default de Connect (USD 1.000/día) es un techo operativo, no una política de producto. | Un límite alto mal leído como auto-aprobación amplifica errores del agente; uno bajo rompe la UX. | Regla canónica: los límites nunca saltean el gate; solo agregan fricción sobre umbrales ([04-confirmation-gate.md](04-confirmation-gate.md)). Gate obligatorio siempre; límites por usuario configurables y auditados; re-autenticación sobre el límite. En Track A ya rigen topes paper por propuesta y por día ([01-wallet.md](01-wallet.md)). |
| **Slippage y liquidez de xStocks.** Pools más finos que los de cripto majors; fuera de horario de mercado US la liquidez empeora — el horario probable de demo en Argentina. | El usuario recibe menos de lo cotizado o el swap falla. | Slippage 50 bps por defecto fijado solo por política del backend, minimum-out visible, bloqueante y reconciliado post-fill; techo duro de price impact de 3% y advertencia desde 1% ([02-swaps-xstocks.md](02-swaps-xstocks.md)); montos de demo pequeños. |
| **Custodia y claves.** Dependemos del signing de Phantom (KMS + policies) en ambos paths. | Si Phantom cambia políticas, precios o disponibilidad, la ejecución se detiene. | Aceptado por no custodiar keypairs propios ([01-wallet.md](01-wallet.md)); la policy de Phantom KMS es un control nombrado con checklist previo a prender el flag ([01-wallet.md](01-wallet.md)); Jupiter + firma propia queda como plan B documentado, no implementado. |
| **Madurez de Eve (vercel/eve).** Eve llegó a 1.0 GA el 2026-11-17 y publicó 1.5.0 el 2026-11-25: está recién GA y su track record de producción es corto; las APIs pueden seguir moviéndose entre releases menores. | Churn de API entre la spec y la implementación. | Pinear versión, aislar Eve detrás del endpoint `/chat/message`: si Eve se reemplaza, el contrato de [05-backend-api.md](05-backend-api.md) no cambia. |
| **Error de interpretación del LLM.** Parsea mal un monto o un activo. | Plata real en el activo equivocado. | Esa es exactamente la razón del gate: la propuesta muestra activo, monto, slippage en bps y minimum-out en lenguaje humano antes de firmar. El LLM propone; el humano confirma; el backend re-deriva y verifica ([03-agent-flows.md](03-agent-flows.md)). |

### Preguntas abiertas para Dino (con recomendación)

- **Q1 — Audiencia de la demo.** ¿Interna o se muestra a terceros? *Recomendación:* interna primero; si se muestra, agregar disclaimer y subir el TTL (Q2). Impacta copy legal y pulido. Mientras la elegibilidad xStocks siga OPEN, la demo es interna aunque esta pregunta se responda distinto. **DECISIÓN (2026-11-27): audiencia interna. CERRADA (ver Decisiones registradas).**
- **Q2 — TTL del gate. DECISIÓN TOMADA en esta revisión (no requiere a Dino): TTL de 60 s por defecto como vencimiento del gate, mostrado como vencimiento único `min(TTL, quote)` en vivo ([04-confirmation-gate.md](04-confirmation-gate.md)). Un refresh nunca reutiliza una confirmation: toda re-cotización crea quote y confirmation nuevas.** Queda abierta solo la sub-pregunta de si un modo demo necesita un TTL configurable mayor, a resolver cuando se implemente.
- **Q3 — Estado en vivo.** Polling vs SSE tras confirmar. *Recomendación original:* polling cada 2 s en la demo; SSE cuando haya canales de Eve en producción. **DECISIÓN (2026-11-27): Dino eligió SSE sobre polling. CERRADA como decisión; la implementación queda en fase 1.1 y todavía no existe en el código (ver Decisiones registradas).**
- **Q4 — Dónde corre el MCP.** Mac de Dino vs host dedicado. *Recomendación:* Mac de Dino para fase 0–1 (la session ya vive ahí); host dedicado recién si la demo necesita uptime sin Dino presente. En ambos casos rigen las reglas del canal backend → MCP de [01-wallet.md](01-wallet.md). **DECISIÓN (2026-11-27): el MCP corre en la Mac de Dino; host dedicado solo si la demo lo pide. CERRADA (ver Decisiones registradas).**
- **Q5 — Control de slippage en Phantom `buy`. CERRADA (evidencia DIN-4) y ejecución decidida en esta revisión.** Respuesta probada: `buy` es **opaco en slippage** (no acepta minimum-out explícito) y además **no rutea en devnet** (HTTP 400), mientras que Jupiter cotiza, arma y simula sin fondeo. Decisión: **Jupiter es cotizador y ejecutor; `buy` queda demovido a comparación de quote y nunca ejecuta** ([02-swaps-xstocks.md](02-swaps-xstocks.md)). Con el flag prendido, la transacción de Jupiter la firma la agent wallet vía Phantom MCP `solana_send` (fase 2: el usuario vía Connect), con reconciliación post-fill del minimum-out.
- **Q6 — Entrada por voz.** ¿El chat acepta dictado? *Recomendación:* fuera de la demo; el texto alcanza para probar la tesis y la voz suma errores de transcripción sobre montos, el dato más sensible. **DECISIÓN (2026-11-27): sin voz por ahora. CERRADA (ver Decisiones registradas).**

### Decisiones registradas

- **2026-11-27 — Respuestas de Dino a Q1, Q3, Q4 y Q6:** Q1 audiencia interna; Q3 SSE como mecanismo de estado en vivo (elegido por Dino sobre polling; implementación pendiente en fase 1.1, todavía no existe en el código); Q4 el MCP corre en la Mac de Dino (host dedicado solo si la demo lo pide); Q6 sin entrada por voz por ahora. Q2 ya tenía decisión tomada en la revisión anterior y Q5 estaba cerrada; **H11 (elegibilidad xStocks en Argentina) sigue OPEN, responsable Dino**, y hasta verificarla la demo se queda interna.
- **2026-11-27 — Q5 cerrada (executor):** Jupiter ejecuta; Phantom `buy` solo compara quotes. Firma con flag prendido: agent wallet vía Phantom MCP `solana_send`; fase 2, vía Connect. Detalle en Q5 arriba y en [02-swaps-xstocks.md](02-swaps-xstocks.md).
- **2026-11-27 — Ronda de fixes gstack-review (AGEN-6):** se aplicaron las 8 Gate Edits del veredicto extendidas a los 20 hallazgos (3 CRITICAL, 9 High, 6 Medium, 2 Low) sobre el commit `cbe29fd`. Estado por hallazgo en la tabla de cierre de abajo. Q1–Q4/Q6 quedan como estaban: no se responden en esta ronda. La única apertura que sobrevive es la elegibilidad xStocks de Argentina (OPEN, responsable Dino).
- **Regla de merge vigente:** nada de este paquete se mergea a `main` como "listo para fase 1" hasta que los 20 hallazgos estén cerrados en spec o cerrados como DECISION/OPEN registrados en este documento.

### Cierre de hallazgos — gstack-review AGEN-6 (20)

Numeración: CRITICAL 1–3 y luego High/Medium/Low en el orden del informe AGEN-6.

| # | Hallazgo (resumen) | Fix en spec (archivo:sección) | Estado |
|---|---|---|---|
| C1 | Minimum-out confirmado no ata al ejecutor (Phantom `buy` opaco); sin reconciliación post-fill | [02: Decisión — Jupiter ejecuta](02-swaps-xstocks.md) + [02: Reconciliación post-fill](02-swaps-xstocks.md); [04: Copy de error con débito revertido](04-confirmation-gate.md); [05: `actualOutAtomic` no nulo en estado final](05-backend-api.md) | Cerrado |
| C2 | Sin estado `executing` ni idempotencia downstream; doble envío posible tras crash/retry | [04: Máquina de estados e idempotencia downstream (lease + referencia persistida + reconcile por signature)](04-confirmation-gate.md); [05: `providerRequestId`/`signatureIntent` en `orders`](05-backend-api.md) | Cerrado |
| C3 | `confirm`/`reject` sin ownership, IDs impredecibles, CSRF ni expiración de sesión demo | [05: Ownership, IDs y sesión (requisitos)](05-backend-api.md); [04: Alcance exige el chequeo](04-confirmation-gate.md) | Cerrado |
| H4 | Criterios de éxito de fase 1 exigen signature real pero Track A acredita paper | [00: Objetivo con criterios Track A y firma real separados](00-overview.md); [06: Fase 1 — salida solo Track A](06-roadmap-risks.md) | Cerrado |
| H5 | README invierte el ejecutor primario y mantiene "~3 USD fondeada" stale | [README: Alcance, Arquitectura y Decisiones](README.md) | Cerrado |
| H6 | Simulación que acredita el monto paper sin definir; lenguaje de "fill" | [01: Simulación que acredita un monto paper (especificación exacta)](01-wallet.md) — `simulateTransaction`, `sigVerify: false`, sustitución de saldos documentada, montos "simulado a quote" | Cerrado |
| H7 | Posiciones paper sin ledger ni `mode`; copy paper con explorer; `txSignature` no nullable | [05: `paper_positions`, `mode` end-to-end, portfolio combinado](05-backend-api.md); [04: Copy Track A sin explorer](04-confirmation-gate.md) | Cerrado |
| H8 | Ventana real 30 s vs TTL 60 s, copy 0:45 y auto-refresh Q2 que cambia términos bajo la tarjeta | [04: Vencimiento único visible; refresh = confirmation nueva](04-confirmation-gate.md); [06: Q2 con decisión](06-roadmap-risks.md) | Cerrado |
| H9 | `quoteId` sin persistencia, ownership ni single-redemption; el LLM lo transporta sin validación | [05: tabla `quotes` persistida y single-redemption](05-backend-api.md); [03: validación en `execute_swap_behind_gate`](03-agent-flows.md) | Cerrado |
| H10 | Contradicción de caps: "sin fricción adicional" leído como auto-aprobación | Regla canónica en [04: Regla canónica de límites](04-confirmation-gate.md); [01: Límites, con topes paper por propuesta/día](01-wallet.md); [01: Fase 2 — spending limits](01-wallet.md) | Cerrado |
| H11 | xStocks a la vez supuesto y riesgo, sin enforcement ni responsable | **DECISION/OPEN** — [06: Riesgos, fila xStocks](06-roadmap-risks.md): estado canónico OPEN, responsable Dino, elegibilidad Argentina UNVERIFIED, demo interna hasta verificar; enforcement en tiempo de quote en [02: Elegibilidad xStocks](02-swaps-xstocks.md) y flujo en [03: Error de compliance](03-agent-flows.md) | OPEN (decisión Dino) |
| H12 | Canal backend → MCP sin especificar; allowlist y policy KMS sin dueño | [01: Canal backend → MCP (boundary de custodia)](01-wallet.md) — mismo host, stdio/loopback, canal privado autenticado si Eve es remoto, allowlist en el adapter, checklist de policy KMS; bloqueo de `transfer`/`solana_send` mainnet fuera del gate por config | Cerrado |
| H13 | (En el orden del informe: tras H12 no hay otro High; ver nota) | — | — |
| M1 | Una pendiente por usuario sin linearización, sin código `superseded` ni regla de UI | [04: Una pendiente por usuario + `CONFIRMATION_SUPERSEDED`](04-confirmation-gate.md); [05: constraint único parcial](05-backend-api.md) | Cerrado |
| M2 | Sin re-derivación determinística desde `rawIntent`, sin reglas es-AR/redondeo, sin dedupe al crear | [03: Intent parsing — backend canónico, parseo es-AR, dedupe](03-agent-flows.md) | Cerrado |
| M3 | Rate limits sin números ni topes de quote/re-quote ni presupuesto global | [05: Rate limits (numéricos) con 429 tipados y escalación a CRITICAL con flag prendido](05-backend-api.md) | Cerrado |
| M4 | Registry apoyado en TODO-verify manual, sin chequeo automático ni regla de override | [02: Integridad del registry — chequeo de boot/CI que falla cerrado, sin override por env](02-swaps-xstocks.md) | Cerrado |
| M5 | Price impact solo advertencia; slippage "por propuesta" sin dueño; copy sin bps | [02: Quote, slippage y minimum-out — techo duro 3%, slippage solo backend](02-swaps-xstocks.md); [04: Copy con slippage en bps](04-confirmation-gate.md) | Cerrado |
| M6 | `proposed → pending_confirmation` sin trigger; finalidad sin definir; either/or en copy de error | [04: Presentación explícita vía `/present`, finalidad `finalized`, dos copies de error exactas](04-confirmation-gate.md); [05: `POST /confirmations/:id/present`](05-backend-api.md) | Cerrado |
| L1 | Audit log: `decidedBy` es un canal, sin integridad ni retención/redacción | [04: Audit log — `decidedBy` = `userId` autenticado, hash chain, redacción](04-confirmation-gate.md) | Cerrado |
| L2 | Ejemplos inconsistentes con el saldo; alias map con doble fuente; quién firma quedado abierto | Saldo paper único de 100 USDC en [00](00-overview.md), [01](01-wallet.md), [04](04-confirmation-gate.md), [README](README.md); alias backend canónico en [03](03-agent-flows.md); firma cerrada en [01: Signing](01-wallet.md) y [02: tabla de proveedores](02-swaps-xstocks.md) | Cerrado |

Nota sobre la numeración: el informe lista 9 High contando H4–H12 de arriba (éxito Track A, README, simulación paper, ledger paper, TTL/refresh, `quoteId`, caps, xStocks, canal MCP). La fila H13 queda como marcador explícito de que no hay un décimo High sin asignar: el conteo del informe es 3 + 9 + 6 + 2 = 20, y esta tabla cierra 19 en spec y 1 como DECISION/OPEN (H11).

## Criterios de aceptación

- [x] Dino respondió Q1, Q3, Q4 y Q6 el 2026-11-27 (Q5 cerrada con evidencia DIN-4 y decisión registrada; Q2 con decisión tomada en esta revisión, sub-pregunta del TTL configurable abierta).
- [x] La fase 0 produce evidencia (address + quotes mainnet + firma devnet) antes de cualquier línea de código de producto. **Cumplido — DIN-4, cerrada Done, sin fondeo en mainnet.**
- [ ] El riesgo de jurisdicción de xStocks tiene un responsable y una verificación concreta asignada antes de mostrar la demo a terceros. **Responsable asignado: Dino. Verificación concreta pendiente: elegibilidad del operador en Argentina (UNVERIFIED). La demo es interna hasta cerrarla.**

## Preguntas abiertas

Este documento *es* el registro de preguntas abiertas del paquete; las nuevas se agregan acá y se cierran con decisión y fecha.
