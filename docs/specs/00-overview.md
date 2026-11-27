# 00 — Overview

## Objetivo

Definir qué problema resuelve la demo, para quién, y qué significa que salga bien, de modo que el resto de las specs tenga un criterio común para recortar alcance.

## Alcance

Este documento cubre problema, usuarios, objetivo de la demo, non-goals y supuestos. No define implementación: eso vive en [01-wallet.md](01-wallet.md) a [05-backend-api.md](05-backend-api.md).

## Fuera de alcance

- Diseño visual de la UI más allá de los textos del gate ([04-confirmation-gate.md](04-confirmation-gate.md)).
- Estrategia de inversión, recomendaciones o asesoramiento financiero.
- Soporte de chains distintas de Solana para la demo.

## Detalle

### Problema

Invertir en activos tokenizados (xStocks) desde una wallet cripto exige saber qué es un mint, un swap, slippage y una firma. La barrera no es el acceso al activo — SPYx se compra como cualquier token SPL en Solana — sino la interfaz. El lenguaje natural elimina esa barrera, pero introduce un riesgo nuevo: un LLM que interpreta mal una frase puede mover plata real. La demo existe para demostrar que ambas cosas se resuelven juntas: intención en lenguaje natural, ejecución bajo permisos autorizados y confirmación humana antes de firmar.

### Usuarios

- **Usuario de la demo (MVP):** El operador del proyecto como usuario único. Escribe intenciones en español rioplatense, confirma o rechaza, y observa el resultado. En Track A el resultado es simulado a quote y queda registrado en el ledger paper ([01-wallet.md](01-wallet.md), [05-backend-api.md](05-backend-api.md)).
- **Usuario final (fase 2):** persona sin experiencia cripto que se registra con Google/Apple, recibe una embedded wallet, fondea y invierte en lenguaje natural. No ve mints ni direcciones salvo que las pida.
- **Operador del sistema:** quien audita confirmations, orders y executions cuando algo sale mal. Lo atiende el audit log de [04-confirmation-gate.md](04-confirmation-gate.md).

### Objetivo de la demo

La demo tiene dos criterios de éxito separados y no intercambiables. Confundirlos es un error de spec: una compra simulada no cumple un criterio que exige signature real.

**Demo interna Track A (paper, sin fondeo mainnet).** Saldo paper de referencia: **100 USDC paper**, acreditados solo en el ledger paper ([05-backend-api.md](05-backend-api.md)), sin relación con un saldo on-chain. En una sesión en vivo, el operador puede: (1) preguntar su saldo y posiciones, distinguiendo saldo on-chain real de posiciones paper; (2) decir "Invertí 10 USD en el S&P 500"; (3) ver la propuesta con activo, monto, quote, slippage en bps, minimum-out y vencimiento único en vivo; (4) confirmar y obtener un **monto simulado a quote** acreditado en el ledger paper solo si la simulación especificada en [01-wallet.md](01-wallet.md) pasa, con la palabra "simulado" visible y sin link a explorer; (5) rechazar otra propuesta y verificar que no se acreditó nada. Ningún paso exige ni produce una transacción real en Solana.

**Demo con firma real (flag de ejecución encendido, con fondos).** Solo aplica cuando el operador prende explícitamente el flag de ejecución y fondea la wallet ([01-wallet.md](01-wallet.md)). En ese modo, el operador confirma y obtiene una transacción ejecutada por Jupiter y confirmada en Solana con su signature verificable, con reconciliación post-fill contra el minimum-out confirmado ([02-swaps-xstocks.md](02-swaps-xstocks.md)). Este criterio no lo cumple Track A ni ninguna simulación.

### Non-goals (MVP)

- Multi-usuario, registro y login (fase 2, Phantom Connect).
- Fondeo en pesos ARS → USDC (fase 3, ramp de terceros).
- Ventas, stop-loss, DCA programado, rebalanceo de portfolio.
- Chains EVM o cross-chain, aunque Phantom MCP las soporte: la demo es Solana-only porque los xStocks del alcance son SPL.
- Asesoramiento: el agente ejecuta intenciones, no recomienda qué comprar. Si el usuario pregunta "¿qué me conviene?", responde con información, nunca con una orden propuesta.
- App móvil nativa.

### Supuestos

1. La agent wallet de la demo **no está fondeada en mainnet** y opera en modo Track A. El saldo de 100 USDC es paper, definido en el ledger paper, y ningún ejemplo de este paquete supone otro saldo. La ejecución real exige fondeo previo y decisión explícita del operador.
2. La elegibilidad para operar xStocks desde la jurisdicción del operador **no es un supuesto**: es un riesgo OPEN con responsable y verificación pendiente ([06-roadmap-risks.md](06-roadmap-risks.md)). Hasta verificarla, la demo es interna.
3. El LLM entiende español rioplatense coloquial ("invertí", "metele", "comprame") sin fine-tuning, validado por el intent parsing de [03-agent-flows.md](03-agent-flows.md). La salida del LLM es una propuesta: la validación del backend es la autoridad ([03-agent-flows.md](03-agent-flows.md)).
4. Phantom MCP, Phantom Connect, Jupiter y Eve mantienen las APIs descriptas en las fuentes del [README.md](README.md) durante el desarrollo de la demo.

## Criterios de aceptación

**Track A (paper):**

- [ ] Los cinco pasos del objetivo Track A se ejecutan en vivo sin intervención fuera del chat y el gate, y todo monto acreditado se muestra como "simulado a quote".
- [ ] Ningún monto simulado se acredita sin una confirmation en estado válido y sin la simulación aprobada de [01-wallet.md](01-wallet.md).
- [ ] Un rechazo y una expiración por vencimiento único se demuestran sin acreditación paper ni movimiento de fondos.

**Firma real (solo con flag encendido):**

- [ ] Toda ejecución queda registrada con signature de Solana verificable en un explorer tras alcanzar finalidad `finalized` ([04-confirmation-gate.md](04-confirmation-gate.md)).
- [ ] Ninguna transacción se firma sin una confirmation en estado `confirmed` ([04-confirmation-gate.md](04-confirmation-gate.md)), y la reconciliación `actualOutAtomic >= minOutAtomic` queda registrada ([02-swaps-xstocks.md](02-swaps-xstocks.md)).

## Preguntas abiertas

- ¿La demo se muestra a terceros (inversores, partners) o es interna? Cambia el nivel de pulido y el copy legal. → [06-roadmap-risks.md](06-roadmap-risks.md), Q1. Mientras la elegibilidad xStocks siga OPEN, la respuesta vigente es interna.
