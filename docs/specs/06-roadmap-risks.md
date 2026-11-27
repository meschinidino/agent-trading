# 06 — Roadmap y riesgos

## Objetivo

Ordenar el trabajo en fases con criterio de salida, y dejar los riesgos y las decisiones que son de Dino explícitos antes de escribir código.

## Alcance

- Fases 0 a 3 con entregables y criterio de salida.
- Riesgos técnicos, de compliance y de dependencia, con mitigación.
- Preguntas abiertas consolidadas (Q1–Q6) con recomendación.

## Fuera de alcance

- Estimaciones de fechas: se estima al cerrar cada fase, con lo aprendido en la anterior.
- Go-to-market, pricing y estrategia comercial.

## Detalle

### Fases

**Fase 0 — Validación manual (sin código de producto). Cumplida (DIN-4, cerrada Done), sin fondeo de Dino en mainnet.** Se instaló `@phantom/mcp-server`, se completó el device-code sign-in y se obtuvo la agent wallet address. La salida validada tiene dos planos: (a) **mainnet** — quotes reales de Jupiter v2 con `taker` = agent wallet, armado de transacción y paths de simulación, con saldo cero; (b) **devnet** — firma de Phantom MCP probada end-to-end con SOL/USDC de faucet: preview asertada con `advancedDetails.chainId` = `solana:103`, `confirmed: true` y signature `4apFAa2mRHGKWcrsZib49yZQBKyVgPpRpzHwNq9T9cMbiMmjtWgjtet9qtR9ewHpWzU9oY9nPBZdRHwk76DevRKy` finalized. Dino no mueve fondos en ninguna fase de validación.

**Fase 1 — Demo single-wallet, modo Track A.** Backend + agente Eve + chat UI + confirmation gate según [03-agent-flows.md](03-agent-flows.md) a [05-backend-api.md](05-backend-api.md). Track A: quotes reales de Jupiter (`/order` con `taker` + armado de transacción) y simulación en mainnet, portfolio desde balances on-chain vía RPC valuados a precios reales, y **paper fill acreditado solo tras simulación aprobada**. La ejecución real (Phantom `buy`) queda detrás de un config flag apagado por defecto. *Salida:* los criterios de aceptación de [00-overview.md](00-overview.md) cumplidos en vivo, con al menos una compra simulada acreditada, un rechazo y una expiración demostrados.

**Fase 2 — Multi-usuario.** Registro con Phantom Connect, una embedded wallet por usuario, spending limits (default USD 1.000/app/día de Connect como techo, gate sigue obligatorio), portfolio e historial por usuario. *Salida:* dos usuarios reales operando wallets distintas sin compartir session ni fondos; re-evaluar Jupiter como ejecutor primario (ver [02-swaps-xstocks.md](02-swaps-xstocks.md)).

**Fase 3 — Ramp en pesos.** El usuario fondea en ARS; un ramp de terceros convierte ARS → USDC directo a su wallet; el agente opera igual que hoy. *Salida:* fondeo ARS acreditado on-chain y compra posterior con el mismo gate. La elección del ramp (proveedor, KYC, costos, settlement) es una spec propia cuando llegue.

### Riesgos

| Riesgo | Impacto | Mitigación / estado |
|---|---|---|
| **xStocks: restricciones geográficas y KYC.** xStocks no está disponible en algunas jurisdicciones (incl. EE. UU. en algunos casos) y el issuer puede exigir KYC. | La demo o la fase 2 pueden ser inviables para ciertos usuarios sin aviso previo del proveedor. | **Abierto, no resuelto por esta spec.** Verificar términos del issuer y jurisdicción del operador antes de fase 1 pública. El agente debe responder con el motivo si un swap es rechazado por compliance, no con un error genérico. |
| **Phantom MCP no es multi-tenant.** Session local por máquina, una agent wallet por instalación. | Bloquea escalar la demo tal cual. | Asumido por diseño: MCP es solo fase 0–1; la escala va por Phantom Connect ([01-wallet.md](01-wallet.md)). |
| **Spending limits mal calibrados (fase 2).** El default de Connect (USD 1.000/día) es un techo operativo, no una política de producto. | Un límite alto sin gate reforzado amplifica errores del agente; uno bajo rompe la UX. | Gate obligatorio siempre; límites por usuario configurables y auditados; re-autenticación sobre el límite. |
| **Slippage y liquidez de xStocks.** Pools más finos que los de cripto majors; fuera de horario de mercado US la liquidez empeora. | El usuario recibe menos de lo cotizado o el swap falla. | Slippage 50 bps default, minimum-out visible y bloqueante, advertencia por price impact ([02-swaps-xstocks.md](02-swaps-xstocks.md)); montos de demo pequeños. |
| **Custodia y claves.** Dependemos del signing de Phantom (KMS + policies) en ambos paths. | Si Phantom cambia políticas, precios o disponibilidad, la ejecución se detiene. | Aceptado por no custodiar keypairs propios ([01-wallet.md](01-wallet.md)); Jupiter + firma propia queda como plan B documentado, no implementado. |
| **Madurez de Eve (vercel/eve).** Framework nuevo, APIs en evolución. | Churn de API entre la spec y la implementación. | Pinear versión, aislar Eve detrás del endpoint `/chat/message`: si Eve se reemplaza, el contrato de [05-backend-api.md](05-backend-api.md) no cambia. |
| **Error de interpretación del LLM.** Parsea mal un monto o un activo. | Plata real en el activo equivocado. | Esa es exactamente la razón del gate: la propuesta muestra activo, monto y minimum-out en lenguaje humano antes de firmar. El LLM propone; el humano confirma; el backend verifica. |

### Preguntas abiertas para Dino (con recomendación)

- **Q1 — Audiencia de la demo.** ¿Interna o se muestra a terceros? *Recomendación:* interna primero; si se muestra, agregar disclaimer y subir el TTL (Q2). Impacta copy legal y pulido.
- **Q2 — TTL del gate.** 60 s estándar vs 120 s en modo demo. *Recomendación:* 120 s configurable por env; la quote se refresca sola al vencer sin perder la intención.
- **Q3 — Estado en vivo.** Polling vs SSE tras confirmar. *Recomendación:* polling cada 2 s en la demo; SSE cuando haya canales de Eve en producción.
- **Q4 — Dónde corre el MCP.** Mac de Dino vs host dedicado. *Recomendación:* Mac de Dino para fase 0–1 (la session ya vive ahí); host dedicado recién si la demo necesita uptime sin Dino presente.
- **Q5 — Control de slippage en Phantom `buy`. CERRADA (evidencia DIN-4).** Respuesta probada: `buy` es **opaco en slippage** (no acepta minimum-out explícito) y además **no rutea en devnet** (HTTP 400), mientras que Jupiter cotiza, arma y simula sin fondeo. La propuesta del gate muestra por lo tanto la quote de Jupiter con su minimum-out, y se mantiene la recomendación: **Jupiter como ejecutor en cuanto necesitemos garantías duras** de minimum-out; `buy` queda relegado a ejecutor opcional con el flag de ejecución encendido.
- **Q6 — Entrada por voz.** ¿El chat acepta dictado? *Recomendación:* fuera de la demo; el texto alcanza para probar la tesis y la voz suma errores de transcripción sobre montos, el dato más sensible.

## Criterios de aceptación

- [ ] Dino responde o difiere explícitamente Q1–Q4 y Q6 antes de iniciar fase 1 (Q5 ya cerrada con evidencia DIN-4).
- [x] La fase 0 produce evidencia (address + quotes mainnet + firma devnet) antes de cualquier línea de código de producto. **Cumplido — DIN-4, cerrada Done, sin fondeo en mainnet.**
- [ ] El riesgo de jurisdicción de xStocks tiene un responsable y una verificación concreta asignada antes de mostrar la demo a terceros.

## Preguntas abiertas

Este documento *es* el registro de preguntas abiertas del paquete; las nuevas se agregan acá y se cierran con decisión y fecha.
