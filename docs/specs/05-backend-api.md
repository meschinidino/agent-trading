# 05 — Backend API

## Objetivo

Fijar el contrato HTTP entre el chat UI, el backend/agente y los layers de wallet/swap, más el modelo de datos mínimo que lo sostiene.

## Alcance

- Endpoints de chat, confirmations, portfolio y transactions.
- Modelo de datos: `users`, `wallets`, `quotes`, `confirmations`, `orders`, `executions`, `paper_positions`.
- Sketch de auth para demo y fase 2.

## Fuera de alcance

- Admin panel, métricas y webhooks externos.
- API pública para terceros (esto es un backend de producto, no una plataforma).
- Detalle de implementación de Eve por dentro; el agente se consume vía el endpoint de chat.

## Detalle

### Endpoints

Todos bajo `/api/v1`, JSON, errores con `{ error: { code, message } }` y códigos de [04-confirmation-gate.md](04-confirmation-gate.md) donde aplique. Todo POST exige el chequeo de ownership y el token CSRF de la sección Auth.

| Método y ruta | Qué hace | Respuesta clave |
|---|---|---|
| `POST /chat/message` | Recibe el mensaje del usuario, corre el agente Eve, devuelve respuesta y, si el agente propuso, la confirmation creada | `{ reply, confirmation?: { id, status, summary, expiresAt } }` |
| `POST /confirmations/:id/present` | Ack de presentación: el frontend avisa que la tarjeta se renderizó; fija `presentedAt` y arranca el vencimiento único ([04-confirmation-gate.md](04-confirmation-gate.md)) | `{ id, status: "pending_confirmation", expiresAt }` |
| `POST /confirmations/:id/confirm` | Marca `confirmed` y dispara la ejecución interna. Idempotente. Exige ownership | `{ id, status, execution?: { txSignature, explorerUrl } }` · `409` si expiró o fue superseded |
| `POST /confirmations/:id/reject` | Marca `rejected`. Idempotente. Exige ownership | `{ id, status: "rejected" }` |
| `GET /confirmations/:id` | Estado actual (polling del frontend tras confirmar). Exige ownership | `{ id, status, summary, mode, txSignature? }` |
| `GET /portfolio` | Balances reales on-chain + posiciones paper del ledger, separados por `mode` | `{ walletAddress, usdc, positions: [{ symbol, amount, usdValue, mode }] }` |
| `GET /transactions` | Historial: confirmations ejecutadas/fallidas (reales con signature; paper sin link a explorer) | `{ items: [{ id, type, symbol, amountUsd, status, mode, txSignature, createdAt }] }` |

No existe `POST /swaps` ni ruta de ejecución directa: es deliberado ([04-confirmation-gate.md](04-confirmation-gate.md)).

### Ownership, IDs y sesión (requisitos, no sketch)

El gate mueve fondos; sus endpoints se especifican cerrados:

- **Ownership obligatorio:** `POST /confirmations/:id/confirm`, `/reject` y `/present`, y `GET /confirmations/:id`, verifican `confirmation.userId == session.userId` server-side en cada request. En mismatch responden **`404`** (no `403`: no se confirma la existencia de confirmations ajenas).
- **IDs impredecibles:** todo `id` público (confirmations, quotes, orders) es UUIDv4 o un random de al menos 128 bits. Ningún ID secuencial ni derivable se expone en una ruta.
- **CSRF:** todo POST exige un token CSRF válido atado a la sesión, además de la cookie. La cookie de sesión es `HttpOnly`, `Secure` y **`SameSite=Lax` como mínimo** (`Strict` si el flujo de login lo permite).
- **Sesión demo:** la credencial compartida por env rota al menos cada **24 horas** o ante cualquier sospecha de exposición, y la sesión emitida vence a las **8 horas** sin uso. La credencial nunca viaja al frontend ni queda en el repo.
- **Prep fase 2 (DIN-36):** el endpoint de [consulta de balances públicos](01-wallet.md#prep-de-fase-2--phantom-inyectado-solo-lectura-din-36) recibe la dirección como dato a consultar, no como credencial ni autoridad para operar. No la asocia al usuario.
- **Fase 2:** se plantea que el social login de Phantom Connect cree/identifique al usuario; la sesión de la app (cookie propia) autoriza los endpoints, y cada request resuelve `userId → wallet` del lado servidor. El frontend nunca envía addresses como autoridad: los deriva el backend de la sesión. Las reglas de ownership, IDs impredecibles y CSRF de arriba aplican sin cambios.

### Modelo de datos

```text
users          id, email/socialSubject, createdAt
wallets        id, userId, provider ('phantom-mcp' | 'phantom-connect'),
               solanaAddress, createdAt        -- sin claves, jamás
quotes         id, userId, walletId, inputMint, outputMint, amountInAtomic,
               quotedOutAtomic, minOutAtomic, slippageBps, priceImpactPct,
               expiresAt, consumedAt NULL, createdAt
confirmations  id, userId, walletId, quoteId, mode ('paper'|'real'),
               status (enum de 04), rawIntent, llmSummary,
               inputMint, outputMint, amountInAtomic, quotedOutAtomic,
               minOutAtomic, slippageBps, priceImpactPct,
               errorCode NULL, prevHash, recordHash,
               createdAt, presentedAt, decidedAt, decidedByUserId, executedAt
orders         id, confirmationId (única), provider ('jupiter'),
               providerRequestId NULL, signatureIntent NULL,
               routeSnapshot JSON, status ('pending'|'submitted'|'confirmed'|'failed')
executions     id, orderId, mode ('paper'|'real'),
               txSignature NULL,  -- obligatorio si mode='real' y hubo envío;
                                  -- siempre NULL si mode='paper'
               slot NULL, feeLamports NULL,
               actualOutAtomic NULL,  -- no nulo en estado final real (o error registrado)
               errorDetail NULL, createdAt
paper_positions id, userId, walletId, confirmationId (única), outputMint,
               symbol, amountAtomic, quotedInAtomic, simulationRef,
               createdAt       -- ledger paper: una fila por acreditación
```

Reglas del modelo:

- **Quotes persistidas al cotizar:** `quote_swap` crea la fila de `quotes` antes de responder, atada a usuario + wallet + mints + montos atómicos. La quote es **single-redemption**: `execute_swap_behind_gate` la consume (`consumedAt`) al crear la confirmation, y una quote vencida o consumida no crea nada. `execute_swap_behind_gate` valida además que el activo/monto declarados por el LLM coinciden con la quote persistida ([03-agent-flows.md](03-agent-flows.md)).
- **Deduplicación al crear confirmations:** la clave es `userId + quoteId` dentro de la vigencia de la quote; repetir la creación devuelve la confirmation existente.
- **Una pendiente por usuario:** constraint único parcial sobre `confirmations (userId)` donde `status IN ('proposed','pending_confirmation')`; la creación de una nueva marca la anterior `superseded` en la misma transacción ([04-confirmation-gate.md](04-confirmation-gate.md)).
- **`mode` end-to-end:** `confirmations`, `orders` (vía su confirmation) y `executions` llevan `paper | real` desde la creación hasta el historial. `executions.txSignature` es nullable **solo** cuando `mode = 'paper'`; con `mode = 'real'` y envío realizado es obligatoria.
- **Ledger paper:** `paper_positions` es la única fuente de posiciones paper. `GET /portfolio` devuelve balances on-chain reales (vía RPC) **más** las posiciones de `paper_positions`, cada fila con su `mode`; nunca mezcla un monto paper dentro de un balance real.
- **Reconciliación en el modelo:** en una execution real en estado final, `actualOutAtomic` tiene el valor leído on-chain o `errorDetail` explica por qué no se pudo leer; el par nunca queda "éxito con `actualOutAtomic` nulo" ([02-swaps-xstocks.md](02-swaps-xstocks.md)).

`confirmations` es la fuente de verdad del audit log; `orders`/`executions` guardan el detalle técnico del swap para debugging sin contaminar el registro que lee soporte. La invariante dura, enforceada con constraint único: **un `order` por confirmation, una ejecución exitosa por order.** Antes de enviar, el worker persiste `orders.providerRequestId` y `orders.signatureIntent`, y todo retry reconcilia contra esa referencia antes de re-enviar ([04-confirmation-gate.md](04-confirmation-gate.md)).

En la demo, `users` tiene una fila (el operador) y `wallets` una fila (`phantom-mcp`). El esquema nace multi-usuario para que la fase 2 no migre datos, solo agregue proveedor.

### Rate limits (numéricos)

Sin números no hay límite: hay una esperanza. Rigen desde la demo, por usuario salvo el global:

| Límite | Valor | Respuesta al exceder |
|---|---|---|
| `POST /chat/message` | 20 mensajes/min por usuario | `429 RATE_LIMITED` tipado |
| Quotes por intención | 3 quotes por mensaje/intención | `429 QUOTE_BUDGET_EXCEEDED` tipado |
| Re-quotes por cadena de confirmation | 5 re-quotes por cadena (cada una como confirmation nueva) | `429 REQUOTE_BUDGET_EXCEEDED` tipado |
| Presupuesto global de quotes Jupiter | 300 quotes/hora en toda la demo (una sola credencial) | `429 GLOBAL_QUOTE_BUDGET_EXCEEDED` tipado |

El gate protege fondos; estos límites protegen costos de LLM, RPC y Jupiter. **Escalación registrada:** el día que el flag de ejecución real se prenda, estos límites pasan a ser control CRITICAL — se revisan y endurecen antes de prenderlo, como parte del checklist de [01-wallet.md](01-wallet.md) — porque el costo de un loop ya no es solo cómputo.

## Criterios de aceptación

- [ ] `POST /chat/message` con una intención válida devuelve una confirmation `pending_confirmation` y ningún movimiento on-chain.
- [ ] `confirm`/`reject`/`present` con un `userId` de sesión distinto del dueño devuelven 404 y no cambian ningún estado (test IDOR); sin token CSRF devuelven 403 (test).
- [ ] `confirm`/`reject` son idempotentes y respetan el vencimiento único (tests contra cada estado de [04-confirmation-gate.md](04-confirmation-gate.md)).
- [ ] Una quote vencida, consumida o ajena no crea confirmations (test).
- [ ] `GET /portfolio` muestra tras una acreditación Track A la posición paper con `mode: "paper"` y sin link a explorer, separada de los balances reales (test).
- [ ] `GET /portfolio` y `/transactions` reflejan la ejecución real (signature verificable) en menos de 5 s tras alcanzar finalidad `finalized`, no antes.
- [ ] Ninguna ruta acepta mint, address de destino o monto "crudos" del cliente para ejecutar: todo deriva de la confirmation persistida.
- [ ] Los cuatro límites de la tabla responden su `429` tipado al excederse (test).

## Preguntas abiertas

- ¿El frontend hace polling de `GET /confirmations/:id` o empujamos por SSE/WebSocket (Eve channels)? Recomendación: polling simple en la demo. → [06-roadmap-risks.md](06-roadmap-risks.md), Q3.
