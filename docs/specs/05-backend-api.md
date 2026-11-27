# 05 — Backend API

## Objetivo

Fijar el contrato HTTP entre el chat UI, el backend/agente y los layers de wallet/swap, más el modelo de datos mínimo que lo sostiene.

## Alcance

- Endpoints de chat, confirmations, portfolio y transactions.
- Modelo de datos: `users`, `wallets`, `confirmations`, `orders`, `executions`.
- Sketch de auth para demo y fase 2.

## Fuera de alcance

- Admin panel, métricas y webhooks externos.
- API pública para terceros (esto es un backend de producto, no una plataforma).
- Detalle de implementación de Eve por dentro; el agente se consume vía el endpoint de chat.

## Detalle

### Endpoints

Todos bajo `/api/v1`, JSON, errores con `{ error: { code, message } }` y códigos de [04-confirmation-gate.md](04-confirmation-gate.md) donde aplique.

| Método y ruta | Qué hace | Respuesta clave |
|---|---|---|
| `POST /chat/message` | Recibe el mensaje del usuario, corre el agente Eve, devuelve respuesta y, si el agente propuso, la confirmation creada | `{ reply, confirmation?: { id, status, summary, expiresAt } }` |
| `POST /confirmations/:id/confirm` | Marca `confirmed` e dispara la ejecución interna. Idempotente | `{ id, status, execution?: { txSignature, explorerUrl } }` · `409` si expiró |
| `POST /confirmations/:id/reject` | Marca `rejected`. Idempotente | `{ id, status: "rejected" }` |
| `GET /confirmations/:id` | Estado actual (polling del frontend tras confirmar) | `{ id, status, summary, txSignature? }` |
| `GET /portfolio` | Balances + posiciones con valor USD (wallet del usuario) | `{ walletAddress, usdc, positions: [{ symbol, amount, usdValue }] }` |
| `GET /transactions` | Historial: confirmations ejecutadas/fallidas con signature | `{ items: [{ id, type, symbol, amountUsd, status, txSignature, createdAt }] }` |

No existe `POST /swaps` ni ruta de ejecución directa: es deliberado ([04-confirmation-gate.md](04-confirmation-gate.md)).

### Modelo de datos

```text
users          id, email/socialSubject, createdAt
wallets        id, userId, provider ('phantom-mcp' | 'phantom-connect'),
               solanaAddress, createdAt        -- sin claves, jamás
confirmations  id, userId, walletId, status (enum de 04), rawIntent, llmSummary,
               inputMint, outputMint, amountInAtomic, quotedOutAtomic,
               minOutAtomic, slippageBps, quoteId, txSignature NULL,
               errorCode NULL, createdAt, presentedAt, decidedAt, executedAt
orders         id, confirmationId (única), provider ('phantom' | 'jupiter'),
               routeSnapshot JSON, status ('pending'|'submitted'|'confirmed'|'failed')
executions     id, orderId, txSignature, slot NULL, feeLamports NULL,
               actualOutAtomic NULL, errorDetail NULL, createdAt
```

`confirmations` es la fuente de verdad del audit log; `orders`/`executions` guardan el detalle técnico del swap para debugging sin contaminar el registro que lee soporte. La invariante dura, enforceada con constraint único: **un `order` por confirmation, una ejecución exitosa por order.**

En la demo, `users` tiene una fila (el operador) y `wallets` una fila (`phantom-mcp`). El esquema nace multi-usuario para que la fase 2 no migre datos, solo agregue proveedor.

### Auth (sketch)

- **Demo:** un solo operador; sesión simple con cookie firmada tras login con credencial compartida por env (o magic link). Sin registro. El objetivo es que nadie que no sea Dino dispare el chat contra la wallet fondeada.
- **Fase 2:** social login de Phantom Connect crea/identifica al usuario; la sesión de la app (cookie propia, ~31 días alineada a Connect) autoriza los endpoints, y cada request resuelve `userId → wallet` del lado servidor. El frontend nunca envía addresses como autoridad: los deriva el backend de la sesión.
- Rate limit básico por usuario en `/chat/message` y `/confirmations/:id/confirm` desde la demo: el gate protege fondos, el rate limit protege costos de LLM y de RPC.

## Criterios de aceptación

- [ ] `POST /chat/message` con una intención válida devuelve una confirmation `pending_confirmation` y ningún movimiento on-chain.
- [ ] `confirm`/`reject` son idempotentes y respetan TTL (tests contra cada estado de [04-confirmation-gate.md](04-confirmation-gate.md)).
- [ ] `GET /portfolio` y `/transactions` reflejan la ejecución real (signature verificable) en menos de 5 s tras la confirmación on-chain.
- [ ] Ninguna ruta acepta mint, address de destino o monto "crudos" del cliente para ejecutar: todo deriva de la confirmation persistida.

## Preguntas abiertas

- ¿El frontend hace polling de `GET /confirmations/:id` o empujamos por SSE/WebSocket (Eve channels)? Recomendación: polling simple en la demo. → [06-roadmap-risks.md](06-roadmap-risks.md), Q3.
