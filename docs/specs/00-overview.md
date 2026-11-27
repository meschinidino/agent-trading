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

- **Usuario de la demo (MVP):** Dino como operador único. Escribe intenciones en español rioplatense, confirma o rechaza, y observa el resultado on-chain.
- **Usuario final (fase 2):** persona sin experiencia cripto que se registra con Google/Apple, recibe una embedded wallet, fondea y invierte en lenguaje natural. No ve mints ni direcciones salvo que las pida.
- **Operador del sistema:** quien audita confirmations, orders y executions cuando algo sale mal. Lo atiende el audit log de [04-confirmation-gate.md](04-confirmation-gate.md).

### Objetivo de la demo

En una sesión en vivo, el operador puede: (1) preguntar su saldo y posiciones; (2) decir "Invertí 3 USD en el S&P 500" (monto acotado al fondeo de ~3 USD USDC); (3) ver la propuesta con activo, monto y quote; (4) confirmar y obtener una transacción confirmada en Solana con su signature; (5) rechazar otra propuesta y verificar que no se ejecutó nada. Si esos cinco pasos funcionan de punta a punta con plata real pequeña, la demo cumplió.

### Non-goals (MVP)

- Multi-usuario, registro y login (fase 2, Phantom Connect).
- Fondeo en pesos ARS → USDC (fase 3, ramp de terceros).
- Ventas, stop-loss, DCA programado, rebalanceo de portfolio.
- Chains EVM o cross-chain, aunque Phantom MCP las soporte: la demo es Solana-only porque los xStocks del alcance son SPL.
- Asesoramiento: el agente ejecuta intenciones, no recomienda qué comprar. Si el usuario pregunta "¿qué me conviene?", responde con información, nunca con una orden propuesta.
- App móvil nativa.

### Supuestos

1. La wallet de la demo se fondea manualmente con ~3 USD en USDC (más una fracción de SOL si el path elegido lo requiere para fees/rent; Phantom `buy` puede abstraerlo — verificar en fase 0).
2. Existe al menos un usuario autorizado en la jurisdicción desde la que opera la demo para operar xStocks. Las restricciones geográficas de xStocks son un riesgo abierto, no un supuesto resuelto ([06-roadmap-risks.md](06-roadmap-risks.md)).
3. El LLM entiende español rioplatense coloquial ("invertí", "metele", "comprame") sin fine-tuning, validado por el intent parsing de [03-agent-flows.md](03-agent-flows.md).
4. Phantom MCP, Phantom Connect, Jupiter y Eve mantienen las APIs descriptas en las fuentes del [README.md](README.md) durante el desarrollo de la demo.

## Criterios de aceptación

- [ ] Los cinco pasos del objetivo se ejecutan en vivo sin intervención fuera del chat y el gate.
- [ ] Ninguna transacción se firma sin una confirmation en estado `confirmed` ([04-confirmation-gate.md](04-confirmation-gate.md)).
- [ ] Toda ejecución queda registrada con signature de Solana verificable en un explorer.
- [ ] Un rechazo y una expiración por TTL se demuestran sin movimiento de fondos.

## Preguntas abiertas

- ¿La demo se muestra a terceros (inversores, partners) o es interna? Cambia el nivel de pulido y el copy legal. → [06-roadmap-risks.md](06-roadmap-risks.md), Q1.
