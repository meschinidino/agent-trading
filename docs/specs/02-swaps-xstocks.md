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
| Quote para el gate | Tool `price` + `simulate` antes de `buy` | `/order` con `taker` nulo devuelve `outAmount`, `otherAmountThreshold`, `priceImpactPct` y route plan exactos |
| Integración demo | Nativa con la agent wallet del MCP | Requiere puente de firma; más piezas móviles para el mismo resultado |

**Decisión:** la demo ejecuta con **Phantom `buy`** (menos superficie, firma delegada, simulation-first). **Jupiter v2 es el path de control**: se usa en fase 0 para validar mints, liquidez y precios de referencia, y queda como fallback si Phantom routing no rutea un par del registry o si necesitamos el detalle de ruta que `buy` no expone. En fase 2 (Phantom Connect), la evaluación se reabre: Connect firma para el usuario y Jupiter `/order` + firma vía Connect pasa a ser candidato primario.

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

1. Toda propuesta del gate nace de una quote fresca (Phantom `simulate`/`price` o Jupiter `/order`): input USDC exacto (ExactIn), output estimado, `priceImpactPct` y expiración de quote de 30 segundos.
2. **Slippage default: 50 bps (0,5%)**, configurable por propuesta entre 10 y 100 bps. La UI muestra el **minimum-out** (`otherAmountThreshold`): "recibís al menos X SPYx".
3. Si `priceImpactPct` supera 1% en valor absoluto, la propuesta se marca con advertencia visible y el agente debe decirlo en el chat antes del gate; con el fondeo de la demo (~3 USD) no debería ocurrir nunca.
4. Si entre la confirmación y la ejecución la quote venció o el output cae por debajo del minimum-out, **no se ejecuta**: la confirmation pasa a `expired` y el agente re-cotiza y propone de nuevo ([04-confirmation-gate.md](04-confirmation-gate.md)).
5. Montos en unidades atómicas siempre enteros (USDC ×10⁶, xStocks ×10⁸); la conversión vive en una sola función del backend, testeada.

## Criterios de aceptación

- [ ] Fase 0: quotes reales USDC → SPYx/AAPLx/NVDAx por Jupiter `/order` con route plan no vacío para 1 USD.
- [ ] Primer swap real de la demo usa Phantom `buy` con simulation previa registrada en el audit log.
- [ ] Ninguna ejecución ocurre con quote vencida ni por debajo del minimum-out mostrado al usuario.
- [ ] El registry es la única fuente de mints: cambiar un mint sin PR es imposible por construcción (config versionada).

## Preguntas abiertas

- ¿Phantom `buy` acepta un minimum-out/slippage explícito o usa el suyo? Si es opaco, el gate muestra el estimado de `simulate` y la regla 4 se aplica post-simulación. Verificar en fase 0. → [06-roadmap-risks.md](06-roadmap-risks.md), Q5.
