# 02 — Swaps y xStocks

## Objetivo

Definir cómo se ejecuta un swap USDC → xStock, con qué proveedor, bajo qué reglas de quote y slippage, y sobre qué token registry cerrado.

## Alcance

- Comparación Phantom MCP `buy` vs Jupiter Swap API v2 y elección por fase.
- Token registry inicial: USDC, SPYx, AAPLx, NVDAx (Solana mainnet).
- Reglas de quote, slippage y minimum-out para la propuesta que ve el usuario.

## Fuera de alcance

- Ventas (xStock → USDC): mismo mecanismo inverso, se especifica cuando entre al alcance.
- Tokens fuera del registry: el agente no cotiza ni ejecuta nada que no esté en la tabla.
- Market making, liquidez propia, órdenes límite.

## Detalle

### Proveedores de ejecución comparados

| Eje | Phantom MCP `buy` | Jupiter Swap API v2 |
|---|---|---|
| Routing | Phantom routing, swaps fee-free (según Phantom) | Aggregator propio (`metis`), multi-DEX (p. ej. Byreal en rutas xStock) |
| Fees | Sin fee de swap de Phantom; aplican network fees | Sin fee de Jupiter en la quote base; `feeBps`/platform fee solo si configuramos fee account propio. Network fees aparte |
| Signing | Firma Phantom vía KMS con policies; nuestro backend nunca toca la transacción | `/order` devuelve la transacción lista para firmar: **la firma la hace la agent wallet vía Phantom MCP `solana_send`** (en fase 2, el usuario vía Phantom Connect) |
| Control | Bajo: una tool opaca, simulation-first disponible vía `simulate` | Alto: `/build` devuelve instructions componibles, amounts y route plan inspeccionables |
| Quote para el gate | `simulate` antes de `buy`; la tool `price` de Phantom no sirve: devuelve `Token not found` para xStocks y para el USDC de Solana (probado en DIN-4) | `/order` con `taker` devuelve `outAmount`, `otherAmountThreshold`, `priceImpactPct` y route plan exactos, y es la fuente de precios |
| Integración demo | Nativa con la agent wallet del MCP, pero `buy` no rutea en devnet (HTTP 400, probado en DIN-4) y su control de slippage es opaco: **no acepta minimum-out explícito** | Sin fondeo alcanza para cotizar y simular end-to-end; con el flag prendido, su transacción es la que se ejecuta |

**Decisión (cerrada): Jupiter ejecuta; Phantom `buy` nunca ejecuta.** El path primario de quote, armado **y ejecución** es **Jupiter `/order` con `taker` = agent wallet**. Con el flag de ejecución encendido, la demo ejecuta la transacción construida por Jupiter: la firma la agent wallet vía Phantom MCP `solana_send` ahora, y el usuario vía Phantom Connect en fase 2. Así, el minimum-out que el usuario confirma (`otherAmountThreshold`) ata al ejecutor real, porque el ejecutor es quien construyó la transacción. **Phantom `buy` queda demovido a comparación de quote solamente**: puede cotizarse en paralelo para mostrar diferencias, pero nunca firma ni envía la operación del gate. Sin flag de ejecución (Track A), la demo llega hasta la simulación especificada en [01-wallet.md](01-wallet.md) y acredita un monto simulado a quote. En fase 2 esta decisión no se reabre en su fondo — Jupiter sigue siendo el ejecutor — ; solo cambia quién firma (Connect).

### Reconciliación post-fill (obligatoria con flag prendido)

Toda ejecución real se reconcilia antes de darse por buena:

1. Al confirmarse la transacción (finalidad según [04-confirmation-gate.md](04-confirmation-gate.md)), el backend lee el `actualOutAtomic` real de la ejecución.
2. Se verifica **`actualOutAtomic >= minOutAtomic`** contra el minimum-out que el usuario confirmó.
3. Si no se cumple, o si `actualOutAtomic` no puede leerse: error visible para el usuario, entrada de audit con `errorCode: MIN_OUT_NOT_MET` (o el motivo de lectura), y la operación **no** se reporta como éxito aunque la transacción exista on-chain. El copy exacto vive en [04-confirmation-gate.md](04-confirmation-gate.md).
4. Post-ejecución, `actualOutAtomic` **deja de ser nullable**: una execution en estado final siempre tiene su valor real o un error registrado que explica por qué no se pudo leer ([05-backend-api.md](05-backend-api.md)).

### Token registry (Solana mainnet)

Verificado contra la token API de Jupiter (`api.jup.ag/tokens/v2/search`, flag `isVerified`, tag `xstocks`) el 2026-11-26. Aun verificado, **re-confirmar mint y decimals contra Jupiter antes del primer swap real** — es el TODO-verify permanente de esta tabla, porque un mint equivocado compra un token falso con el mismo símbolo (existen decenas de imitaciones `*pump`). Ese paso manual convive con el chequeo automático de abajo: el TODO-verify es el paso humano previo al primer swap real; el chequeo automático es el mecanismo continuo.

| Símbolo | Nombre | Mint | Decimals | Notas |
|---|---|---|---|---|
| USDC | USD Coin (Circle, Solana) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 | Mint canónico ampliamente conocido; TODO-verify igual que el resto |
| SPYx | SP500 xStock | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` | 8 | Token-2022, tag `xstocks`, verificado en Jupiter 2026-11-26 |
| AAPLx | Apple xStock | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` | 8 | Token-2022, tag `xstocks`, verificado en Jupiter 2026-11-26 |
| NVDAx | NVIDIA xStock | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | 8 | Token-2022, tag `xstocks`, verificado en Jupiter 2026-11-26 |

Reglas del registry: es una allowlist cerrada en config versionada en el repo (no en el prompt, **sin override por env**: cambiar un mint exige PR, sin excepción); agregar un token exige PR con mint verificado en dos fuentes (Jupiter verified + sitio del issuer xStocks/Backed). Emisores del ecosistema a considerar a futuro: xStocks, Backed, Ondo, PreStocks, Tessera.

**Integridad del registry (mecanismo, no promesa):** al boot del backend — y en CI cuando exista — un chequeo automático re-verifica cada mint del registry contra la lista verificada de Jupiter y contra la fuente del issuer, y **falla cerrado**: si algún mint no verifica, el backend no cotiza ningún activo y registra el motivo. La aceptación "imposible por construcción" significa exactamente esto: config versionada en el repo como única fuente, sin override por env, más el chequeo de boot que la contrasta contra las dos fuentes externas. Los mints son Token-2022; las extensiones concretas de cada mint y su paridad Jupiter/Phantom quedan registradas tal como se verificaron en DIN-4, sin inventar extensiones no observadas.

### Quote, slippage y minimum-out

1. Toda propuesta del gate nace de una quote fresca de Jupiter `/order` (Phantom `simulate`/`buy` solo como comparación opcional, nunca como fuente del gate): input USDC exacto (ExactIn), output estimado, `priceImpactPct` y expiración de quote de 30 segundos. La quote se persiste server-side al cotizar ([05-backend-api.md](05-backend-api.md)).
2. **Slippage: 50 bps (0,5%) por defecto, configurado solo por política del backend** (rango permitido 10–100 bps). Ni el LLM ni la propuesta del modelo eligen slippage; ningún parámetro por propuesta lo modifica. La tarjeta del gate muestra los bps y el **minimum-out** (`otherAmountThreshold`): "recibís al menos X SPYx" ([04-confirmation-gate.md](04-confirmation-gate.md)). En Track A estas reglas atan lo que muestra la propuesta y el monto simulado a quote que se acredita: no hay acreditación si la simulación no respeta el minimum-out.
3. **Price impact con techo duro:** si `priceImpactPct` supera **3% en valor absoluto, la propuesta se rechaza** antes del gate y el agente explica que el precio se mueve demasiado con ese monto (esto importa fuera de horario US, cuando la liquidez de xStocks es fina). Entre 1% y 3%, la propuesta se marca con advertencia visible y el agente debe decirlo en el chat antes del gate.
4. Si entre la confirmación y la ejecución la quote venció o el output cae por debajo del minimum-out, **no se ejecuta**: la confirmation pasa a `expired` y cualquier nuevo intento exige una quote nueva y una confirmation nueva ([04-confirmation-gate.md](04-confirmation-gate.md)).
5. Montos en unidades atómicas siempre enteros (USDC ×10⁶, xStocks ×10⁸); la conversión vive en una sola función del backend, testeada.

### Elegibilidad xStocks (punto de enforcement)

El backend **se niega a cotizar** un activo no elegible: el enforcement es en tiempo de quote, no en el confirm. Si la elegibilidad verificada ([06-roadmap-risks.md](06-roadmap-risks.md)) marca un activo o una jurisdicción como no elegible, `quote_swap` devuelve el error tipado de compliance y el agente lo explica con el flujo de [03-agent-flows.md](03-agent-flows.md); nunca llega a existir una confirmation para ese activo. Mientras la elegibilidad de Argentina siga UNVERIFIED, la demo opera interna y este enforcement se aplica en cuanto exista una determinación registrada.

## Criterios de aceptación

- [x] Fase 0: quotes reales USDC → SPYx/AAPLx/NVDAx por Jupiter `/order` con route plan no vacío para 1 USD. **Cumplido — evidencia DIN-4 (cerrada Done): quotes mainnet con `taker` = agent wallet y simulación sin fondeo; firma probada en devnet (ver [01-wallet.md](01-wallet.md)).**
- [ ] Con el flag de ejecución encendido, el primer swap real de la demo ejecuta la transacción de Jupiter (firma vía Phantom MCP `solana_send`), nunca Phantom `buy`, y la simulation previa queda registrada en el audit log.
- [ ] Ninguna ejecución ocurre con quote vencida ni por debajo del minimum-out mostrado al usuario; toda ejecución real pasa la reconciliación `actualOutAtomic >= minOutAtomic` o termina en error visible con audit.
- [ ] Una propuesta con price impact mayor a 3% en valor absoluto se rechaza antes del gate; entre 1% y 3% muestra advertencia (test).
- [ ] El slippage aplicado proviene solo de la política del backend; no existe parámetro de tool ni de propuesta que lo modifique (test).
- [ ] El registry es la única fuente de mints: cambiar un mint sin PR es imposible por construcción (config versionada, sin override por env) y el chequeo de boot/CI falla cerrado ante cualquier mint que no verifique en las dos fuentes (test).

## Preguntas abiertas

- Q5 cerrada y extendida por esta revisión: Phantom `buy` es opaco en slippage, no rutea en devnet y **ya no es ejecutor en ningún modo**; Jupiter cotiza, simula, ejecuta y reconcilia. Resolución completa en [06-roadmap-risks.md](06-roadmap-risks.md), Q5.
