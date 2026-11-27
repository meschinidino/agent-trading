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

Eve es filesystem-first: el agente se define en un directorio `agent/` versionado en este repo (cuando se implemente) y corre durable en Vercel o self-hosted en Node 24+/pnpm. Las reglas del canal backend → MCP de [01-wallet.md](01-wallet.md) mandan sobre el hosting: Eve corre en el mismo host que el MCP en fases 0–1, y cualquier hosting remoto exige el canal privado autenticado allí especificado.

```
agent/
  instructions.md        # rol, reglas del gate, alias map (espejo), tono es-AR
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

**Alias map (cerrado). Fuente de verdad única: el backend.** El alias map vive en el backend como única fuente canónica; `agent/instructions.md` lo espeja solo como ayuda de lectura para el modelo, y ante cualquier divergencia manda el backend, que re-deriva activo y monto de forma determinística desde el `rawIntent` (ver abajo). El espejo nunca es autoridad.

| Dice el usuario | Activo |
|---|---|
| "S&P 500", "SP500", "el índice", "SPY" | SPYx |
| "Apple", "AAPL", "la manzana" | AAPLx |
| "Nvidia", "NVDA" | NVDAx |

Un activo fuera del map (p. ej. "Tesla") no se adivina: el agente responde qué puede operar hoy (S&P 500, Apple, Nvidia) y ofrece una de esas. Ampliar el map = ampliar el registry de [02-swaps-xstocks.md](02-swaps-xstocks.md) en el mismo PR, editando primero el backend.

**Montos:** se parsea número + moneda. "100 USD", "cien dólares", "100 usd" → 100 USD. Sin moneda explícita se asume USD y se dice en la propuesta. Pesos ("100 lucas") no se convierten en la demo: fase 3; el agente lo aclara. Reglas de parseo es-AR, aplicadas por el backend de forma determinística: **el punto es separador de miles y la coma es decimal** ("1.000" = mil, "10,50" = diez con cincuenta). Un monto que no parsea sin ambigüedad con estas reglas se rechaza y se pide aclaración; nunca se redondea en silencio. Montos con decimales se aceptan hasta 2 (centavos): un tercer decimal rechaza el monto y el agente lo explica. Los topes de [01-wallet.md](01-wallet.md) (por propuesta y por día, también en paper) se verifican en el backend antes de cotizar.

**La salida del LLM es una propuesta; la validación del backend es la autoridad.** El backend re-deriva activo y monto desde el `rawIntent` con el alias map y las reglas de parseo de arriba, y los contrasta contra lo que el LLM declaró. Si difieren, manda la derivación del backend; si la derivación del backend no es concluyente, no hay propuesta y se pide aclaración. Ninguna tool confía en activo/monto declarados por el modelo sin esta verificación.

**Balance check antes de proponer:** `get_balances` corre siempre antes de `quote_swap`. Si el saldo (paper en Track A, real con flag prendido) no alcanza, no hay propuesta: el agente dice cuánto hay y cuánto falta. Si el saldo SOL (o el mecanismo de fees del path) no cubre la ejecución, se avisa igual.

### Flujos

1. **Compra feliz:** mensaje → parse (activo, monto) → re-derivación determinística en backend → `get_balances` → `quote_swap` (persiste la quote) → `execute_swap_behind_gate` crea la confirmation contra esa quote → el frontend renderiza el gate y acusa presentación ([04-confirmation-gate.md](04-confirmation-gate.md)) → el usuario confirma en la UI → el backend ejecuta (Jupiter, o acreditación simulada a quote en Track A) → el agente reporta el resultado: con flag prendido, signature y link a explorer tras finalidad; en Track A, monto "simulado a quote" sin link a explorer.
2. **Ambigüedad:** falta activo o monto ("quiero invertir") → una sola pregunta de clarificación con opciones concretas. Ambigüedad entre dos activos del map → preguntar cuál, nunca elegir por el usuario.
3. **Rechazo/expiración:** el agente lo reconoce en una línea, sin insistir ni re-proponer solo. Toda re-cotización a pedido del usuario crea una confirmation nueva; nunca se refresca una existente ([04-confirmation-gate.md](04-confirmation-gate.md)).
4. **Consulta:** "¿cuánto tengo?" / "¿cómo va mi portfolio?" → `get_balances` + `get_positions`, respuesta en lenguaje llano con valores en USD, separando saldo real de posiciones paper por `mode` ([05-backend-api.md](05-backend-api.md)).
5. **Fuera de dominio:** temas no financieros o pedidos de recomendación → declina breve y vuelve a ofrecer las acciones disponibles. Nunca propone una orden que el usuario no pidió.
6. **Error de compliance:** si `quote_swap` devuelve el error tipado de elegibilidad ([02-swaps-xstocks.md](02-swaps-xstocks.md)), el agente explica la restricción en lenguaje llano — que el activo no se puede operar desde esta jurisdicción/cuenta por una restricción del emisor —, no ofrece un activo sustituto como atajo y nunca muestra un error genérico.

### Contrato de tools (backend)

| Tool | Input | Output | Efecto |
|---|---|---|---|
| `get_balances` | `{}` | `{ usdc, sol, walletAddress }` en unidades humanas + atómicas (en Track A incluye el saldo paper, marcado `mode: "paper"`) | Ninguno (read) |
| `quote_swap` | `{ fromMint, toMint, amountUsd }` | `{ quoteId, inAmount, outAmount, minOut, slippageBps, priceImpactPct, expiresAt }` | Persiste la quote server-side ([05-backend-api.md](05-backend-api.md)); puede devolver el error tipado de compliance |
| `execute_swap_behind_gate` | `{ quoteId }` | `{ confirmationId, status: "pending_confirmation", summary }` | Crea la confirmation; **no ejecuta** |
| `get_positions` | `{}` | `[{ symbol, amount, usdValue, mode }]` (`mode: "paper" \| "real"` por posición) | Ninguno (read) |

Reglas del contrato:

- `execute_swap_behind_gate` toma el `quoteId` **y valida** el activo/monto que el LLM declara contra la quote persistida (user, wallet, mints y montos atómicos). Cualquier mismatch rechaza la creación con error tipado; un `quoteId` ajeno, vencido o ya redimido no crea nada.
- La creación de confirmations es idempotente contra reintentos del agente: la **clave de deduplicación** es usuario + quote dentro de la ventana de vigencia de la quote; repetir la creación con la misma clave devuelve la confirmation existente en vez de acuñar otra (y por lo tanto no invalida tarjetas por accidente — [04-confirmation-gate.md](04-confirmation-gate.md)).
- Las tools son finas: validan contra el registry, llaman al wallet/swap layer y devuelven datos estructurados. Toda la política (qué se puede, cuánto, cuándo) vive en el backend, no en el prompt. El slippage no es parámetro de ninguna tool: lo fija la política del backend ([02-swaps-xstocks.md](02-swaps-xstocks.md)).

## Criterios de aceptación

- [ ] "Invertí 10 USD en el S&P 500" produce una confirmation `pending_confirmation` sin pedir aclaraciones (saldo paper de referencia: 100 USDC, [01-wallet.md](01-wallet.md)).
- [ ] "Invertí en Apple" (sin monto) produce exactamente una pregunta de clarificación y ninguna tool de swap.
- [ ] "Invertí 100 USD en Tesla" no cotiza nada y ofrece los tres activos del map.
- [ ] "Invertí 1.000 USD en Apple" se deriva como mil USD (y se rechaza por el tope por propuesta si aplica), nunca como uno ([03-agent-flows.md](03-agent-flows.md), reglas es-AR; test de parseo).
- [ ] Un `quoteId` con activo o monto distinto del declarado por el LLM es rechazado por `execute_swap_behind_gate` sin crear confirmation (test).
- [ ] Reintentar `execute_swap_behind_gate` con la misma quote vigente devuelve la misma confirmation (test de deduplicación).
- [ ] Pedir el saldo nunca crea una confirmation.
- [ ] No existe path de código por el que el agente ejecute un swap sin pasar por `execute_swap_behind_gate`.

## Preguntas abiertas

- ¿Voz/dictado en el chat de la demo? Eve lo permite vía channels, pero suma superficie. → [06-roadmap-risks.md](06-roadmap-risks.md), Q6.
