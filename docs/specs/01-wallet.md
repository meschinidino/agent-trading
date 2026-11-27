# 01 — Wallet

## Objetivo

Definir el modelo de wallet para la demo y para la escala multi-usuario, con custodia y límites explícitos, de modo que ninguna fase dependa de keypairs crudos administrados por nosotros.

## Alcance

- Demo: agent wallet de Phantom MCP, fondeo y operación.
- Fase 2: embedded wallets de Phantom Connect por usuario, con spending limits.
- Notas de custodia y seguridad aplicables a ambas.

## Fuera de alcance

- Implementación del cliente MCP ni del SDK de Connect (se consume como servicio).
- Recovery social, seed phrase UX y exportación de claves: lo resuelve Phantom, no lo tocamos.
- Wallets en BSC (Phantom MCP no lo soporta para transaction tools) y cualquier chain no-Solana en la demo.

## Detalle

### Demo — Phantom MCP agent wallet

Phantom MCP (`@phantom/mcp-server`) le da al agente una wallet **nueva y dedicada**, aislada de la wallet personal de Dino: nace en cero y hay que fondearla. Ese aislamiento es la razón de usarla: si el agente se equivoca, el daño máximo es el fondeo de la demo.

- **Fondeo:** ~3 USD en USDC (token program SPL, mint en [02-swaps-xstocks.md](02-swaps-xstocks.md)) enviados manualmente a la address que devuelve la tool `wallet_addresses`. Paso a cargo de Dino en fase 0; el agente nunca se auto-fondea.
- **Sign-in:** flujo device-code en el browser; no requiere Portal App ID. La session queda **guardada localmente en la máquina donde corre el MCP** — consecuencia directa: el MCP de la demo corre en la Mac de Dino o en un host controlado, nunca como servicio compartido.
- **Signing:** OIDC stamper → KMS con policy enforcement del lado de Phantom. La clave privada nunca llega a nuestro backend ni al LLM.
- **Tools que usamos:** `wallet_addresses`, `wallet_balances`, `price`, `simulate`, `buy`, `transfer` (solo si hace falta mover fondos entre addresses propias). El resto de las ~30 tools queda fuera del allowlist del agente ([03-agent-flows.md](03-agent-flows.md)).
- **Regla dura:** toda tool con efecto on-chain se invoca únicamente a través del confirmation gate ([04-confirmation-gate.md](04-confirmation-gate.md)), y antes de ejecutar se corre `simulate`/quote para poblar la propuesta.

### Fase 2 — Phantom Connect embedded wallets

Cuando haya muchos usuarios, el patrón MCP no escala: una session local por agente no es multi-tenant. El path de escala es Phantom Connect, un producto separado:

- Cada usuario obtiene una embedded wallet al registrarse con Google/Apple (social login), **non-custodial**, sin seed phrase visible.
- **Spending limits:** default de USD 1.000 por app/día por usuario, configurable. Es el límite que autoriza al agente a operar sin fricción adicional; por encima, la fase 2 debe exigir re-autenticación o confirmación reforzada (definir en su momento).
- **Domain binding y sesiones de ~31 días:** la session se ata al dominio de la app; vencida, el usuario re-ingresa con social login.
- El backend guarda `user_id → wallet_address` (Solana) y nunca claves. La firma sigue ocurriendo del lado de Phantom.

### Por qué no raw keypairs

Administrar keypairs propios (guardar seeds en un KMS propio, firmar transacciones a mano) nos convierte en custodios de facto: responsabilidad legal, superficie de ataque y trabajo de signing que Phantom ya resuelve con policy enforcement. Para una demo cuyo diferencial es el agente y el gate, la custodia es commodity: se delega. El costo es dependencia de Phantom, aceptado y registrado como riesgo en [06-roadmap-risks.md](06-roadmap-risks.md).

### Custodia y seguridad — notas

1. **El LLM nunca ve credenciales.** Ve addresses, balances y resultados de tools.
2. **Allowlist de tools y de mints:** el agente solo puede operar los tokens del registry de [02-swaps-xstocks.md](02-swaps-xstocks.md).
3. **Topes por capa:** fondeo acotado (demo) → confirmation gate (siempre) → spending limit de Connect (fase 2). Ninguna capa sustituye a otra.
4. **La session del MCP es un secreto operativo:** vive en la máquina del operador, no se commitea, no se sincroniza.

## Criterios de aceptación

- [ ] `wallet_addresses` devuelve la Solana address de la agent wallet y queda registrada en la config de la demo (sin secretos en el repo).
- [ ] Balance inicial 0 verificado; tras el fondeo manual, `wallet_balances` refleja ~3 USD USDC.
- [ ] Ningún archivo del repo contiene session data, tokens OIDC ni claves.
- [ ] La demo opera sin tocar jamás la wallet personal de Dino.

## Preguntas abiertas

- ¿El MCP de la demo corre en la Mac de Dino o en un host siempre encendido? Afecta disponibilidad de la demo. → [06-roadmap-risks.md](06-roadmap-risks.md), Q4.
