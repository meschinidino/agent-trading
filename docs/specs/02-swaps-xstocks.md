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
| Signing | Firma Phantom vía KMS con policies; nuestro backend nunca toca la transacción | `/order` devuelve transacción lista para firmar: la firma la hace la wallet (en la práctica, la agent wallet firma vía MCP o se descarta este path para ejecución) |
| Control | Bajo: una tool opaca, simulation-first disponible vía `simulate` | Alto: `/build` devuelve instructions componibles, amounts y route plan inspeccionables |
| Quote para el gate | `simulate` antes de `buy`; la tool `price` de Phantom no sirve: devuelve `Token not found` para xStocks y para el USDC de Solana (probado en DIN-4) | `/order` con `taker` devuelve `outAmount`, `otherAmountThreshold`, `priceImpactPct` y route plan exactos, y es la fuente de precios |
| Integración demo | Nativa con la agent wallet del MCP, pero `buy` no rutea en devnet (HTTP 400, probado en DIN-4) y su control de slippage es opaco | Sin fondeo alcanza para cotizar y simular end-to-end; la firma solo hace falta con el flag de ejecución encendido |

**Decisión (Track A):** el path primario de quote y armado de la demo es **Jupiter `/order` con `taker` = agent wallet**, porque funciona sin fondeo, expone minimum-out y route plan, y es la única fuente de precios que reconoce los mints del registry. Sin flag de ejecución, la demo llega hasta la simulación y acredita un **paper fill** ([01-wallet.md](01-wallet.md)). **Phantom `buy` queda como el ejecutor previsto solo cuando el flag de ejecución está encendido** (mainnet fondeada, decisión futura de Dino), aceptando que su slippage es opaco. En fase 2 (Phantom Connect), la evaluación se reabre: Connect firma para el usuario y Jupiter `/order` + firma vía Connect pasa a ser candidato primario.

### Token registry (Solana mainnet)

Verificado contra la token API de Jupiter (`api.jup.ag/tokens/v2/search`, flag `isVerified`, tag `xstocks`) el 2026-11-26. Aun verificado, **re-confirmar mint y decimals contra Jupiter antes del primer swap real** — es el TODO-verify permanente de esta tabla, porque un mint equivocado compra un token falso con el mismo símbolo (existen decenas de imitaciones `*pump`).

| Símbolo | Nombre | Mint | Decimals | Notas |
|---|---|---|---|---|
| USDC | USD Coin (Circle, Solana) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 | Mint canónico ampliamente conocido; TODO-verify igual que el resto |
| SPYx | SP500 xStock | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` | 8 | Token-2022, tag `xstocks`, verificado en Jupiter 2026-11-26 |
| AAPLx | Apple xStock | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` | 8 | Token-2022, tag `xstocks`, verificado en Jupiter 2026-11-26 |
| NVDAx | NVIDIA xStock | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | 8 | Token-2022, tag `xstocks`, verificado en Jupiter 2026-11-26 |

Reglas del registry: es una allowlist cerrada en config (no en el prompt); agregar un token exige PR con mint verificado en dos fuentes (Jupiter verified + sitio del issuer xStocks/Backed). Emisores del ecosistema a considerar a futuro: xStocks, Backed, Ondo, PreStocks, Tessera.

### Quote, slippage y minimum-out

1. Toda propuesta del gate nace de una quote fresca (Jupiter `/order`; Phantom `simulate` solo como chequeo previo a un `buy` con flag encendido): input USDC exacto (ExactIn), output estimado, `priceImpactPct` y expiración de quote de 30 segundos.
2. **Slippage default: 50 bps (0,5%)**, configurable por propuesta entre 10 y 100 bps. La UI muestra el **minimum-out** (`otherAmountThreshold`): "recibís al menos X SPYx". En Track A estas reglas atan lo que muestra la propuesta simulada y el paper fill que se acredita: no hay fill si la simulación no respeta el minimum-out.
3. Si `priceImpactPct` supera 1% en valor absoluto, la propuesta se marca con advertencia visible y el agente debe decirlo en el chat antes del gate; con los montos chicos de la demo no debería ocurrir nunca.
4. Si entre la confirmación y la ejecución la quote venció o el output cae por debajo del minimum-out, **no se ejecuta**: la confirmation pasa a `expired` y el agente re-cotiza y propone de nuevo ([04-confirmation-gate.md](04-confirmation-gate.md)).
5. Montos en unidades atómicas siempre enteros (USDC ×10⁶, xStocks ×10⁸); la conversión vive en una sola función del backend, testeada.

## Criterios de aceptación

- [x] Fase 0: quotes reales USDC → SPYx/AAPLx/NVDAx por Jupiter `/order` con route plan no vacío para 1 USD. **Cumplido — evidencia DIN-4 (cerrada Done): quotes mainnet con `taker` = agent wallet y simulación sin fondeo; firma probada en devnet (ver [01-wallet.md](01-wallet.md)).**
- [ ] Con el flag de ejecución encendido, el primer swap real de la demo usa Phantom `buy` con simulation previa registrada en el audit log.
- [ ] Ninguna ejecución ocurre con quote vencida ni por debajo del minimum-out mostrado al usuario.
- [ ] El registry es la única fuente de mints: cambiar un mint sin PR es imposible por construcción (config versionada).

## Preguntas abiertas

- Q5 cerrada: Phantom `buy` es opaco en slippage y no rutea en devnet; Jupiter cotiza y simula sin fondeo. Resolución completa en [06-roadmap-risks.md](06-roadmap-risks.md), Q5.
