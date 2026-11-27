# 03 — Agent flows (Eve)

## Objetivo

Definir el comportamiento observable del agente: cómo pasa de una frase en español a una propuesta confirmable, cuándo pregunta, y qué tools puede tocar.

## Alcance

- Intent parsing: activos (alias map), montos, moneda.
- Flujos: consultar saldo/posiciones, proponer compra, manejar ambigüedad y errores.
- Estructura Eve en `agent/` y contrato de las cuatro tools del backend.

## Fuera de alcance

- El texto interno del system prompt más allá de las reglas de comportamiento aquí fijadas (vive en `agent/instructions.md` y se itera sin cambiar esta spec).
- Evals automatizados del LLM (deseables, no bloquean la demo).
- Canales distintos del chat web (Eve soporta channels; la demo usa uno solo).

## Detalle

### Estructura Eve

Eve es filesystem-first: el agente se define en un directorio `agent/` versionado en este repo (cuando se implemente) y corre durable en Vercel o self-hosted en Node 24+/pnpm.

```
agent/
  instructions.md        # rol, reglas del gate, alias map, tono es-AR
  tools/
    get_balances.ts
    quote_swap.ts
    execute_swap_behind_gate.ts
    get_positions.ts
  skills/                # opcional: conocimiento xStocks/jurisdicción
  channels/              # chat web (demo)
  schedules/             # ninguno en la demo
```

La regla estructural clave: **el agente no tiene ninguna tool que ejecute un swap directamente.** `execute_swap_behind_gate` crea la confirmation y devuelve `pending`; la ejecución real ocurre en el backend cuando llega el confirm ([04-confirmation-gate.md](04-confirmation-gate.md), [05-backend-api.md](05-backend-api.md)). Si el LLM "decide" saltear el gate, no tiene con qué.

### Intent parsing

**Alias map (cerrado, en `instructions.md` y espejado en el backend):**

| Dice el usuario | Activo |
|---|---|
| "S&P 500", "SP500", "el índice", "SPY" | SPYx |
| "Apple", "AAPL", "la manzana" | AAPLx |
| "Nvidia", "NVDA" | NVDAx |

Un activo fuera del map (p. ej. "Tesla") no se adivina: el agente responde qué puede operar hoy (S&P 500, Apple, Nvidia) y ofrece una de esas. Ampliar el map = ampliar el registry de [02-swaps-xstocks.md](02-swaps-xstocks.md) en el mismo PR.

**Montos:** se parsea número + moneda. "100 USD", "cien dólares", "100 usd" → 100 USD. Sin moneda explícita se asume USD y se dice en la propuesta. Pesos ("100 lucas") no se convierten en la demo: fase 3; el agente lo aclara. Montos con decimales se aceptan hasta 2 (centavos).

**Balance check antes de proponer:** `get_balances` corre siempre antes de `quote_swap`. Si el saldo USDC no alcanza, no hay propuesta: el agente dice cuánto hay y cuánto falta. Si el saldo SOL (o el mecanismo de fees del path) no cubre la ejecución, se avisa igual.

### Flujos

1. **Compra feliz:** mensaje → parse (activo, monto) → `get_balances` → `quote_swap` → `execute_swap_behind_gate` crea la confirmation → el frontend renderiza el gate → el usuario confirma en la UI → el backend ejecuta → el agente reporta resultado con signature y link a explorer.
2. **Ambigüedad:** falta activo o monto ("quiero invertir") → una sola pregunta de clarificación con opciones concretas. Ambigüedad entre dos activos del map → preguntar cuál, nunca elegir por el usuario.
3. **Rechazo/expiración:** el agente lo reconoce en una línea, sin insistir ni re-proponer solo.
4. **Consulta:** "¿cuánto tengo?" / "¿cómo va mi portfolio?" → `get_balances` + `get_positions`, respuesta en lenguaje llano con valores en USD.
5. **Fuera de dominio:** temas no financieros o pedidos de recomendación → declina breve y vuelve a ofrecer las acciones disponibles. Nunca propone una orden que el usuario no pidió.

### Contrato de tools (backend)

| Tool | Input | Output | Efecto |
|---|---|---|---|
| `get_balances` | `{}` | `{ usdc, sol, walletAddress }` en unidades humanas + atómicas | Ninguno (read) |
| `quote_swap` | `{ fromMint, toMint, amountUsd }` | `{ quoteId, inAmount, outAmount, minOut, priceImpactPct, expiresAt }` | Ninguno (read; Jupiter `/order` o Phantom `simulate`) |
| `execute_swap_behind_gate` | `{ quoteId }` | `{ confirmationId, status: "pending_confirmation", summary }` | Crea la confirmation; **no ejecuta** |
| `get_positions` | `{}` | `[{ symbol, amount, usdValue }]` | Ninguno (read) |

Las tools son finas: validan contra el registry, llaman al wallet/swap layer y devuelven datos estructurados. Toda la política (qué se puede, cuánto, cuándo) vive en el backend, no en el prompt.

## Criterios de aceptación

- [ ] "Invertí 3 USD en el S&P 500" produce una confirmation `pending_confirmation` sin pedir aclaraciones.
- [ ] "Invertí en Apple" (sin monto) produce exactamente una pregunta de clarificación y ninguna tool de swap.
- [ ] "Invertí 100 USD en Tesla" no cotiza nada y ofrece los tres activos del map.
- [ ] Pedir el saldo nunca crea una confirmation.
- [ ] No existe path de código por el que el agente ejecute un swap sin pasar por `execute_swap_behind_gate`.

## Preguntas abiertas

- ¿Voz/dictado en el chat de la demo? Eve lo permite vía channels, pero suma superficie. → [06-roadmap-risks.md](06-roadmap-risks.md), Q6.
