# 01 — Wallet

## Objetivo

Definir el modelo de wallet para la demo y para la escala multi-usuario, con custodia y límites explícitos, de modo que ninguna fase dependa de keypairs crudos administrados por nosotros.

## Alcance

- Demo: agent wallet de Phantom MCP sin fondeo en mainnet; operación en modo Track A (ver Detalle).
- Fase 2: embedded wallets de Phantom Connect por usuario, con spending limits.
- Notas de custodia y seguridad aplicables a ambas.

## Fuera de alcance

- Implementación del cliente MCP ni del SDK de Connect (se consume como servicio).
- Recovery social, seed phrase UX y exportación de claves: lo resuelve Phantom, no lo tocamos.
- Wallets en BSC (Phantom MCP no lo soporta para transaction tools) y cualquier chain no-Solana en la demo.

## Detalle

### Demo — Phantom MCP agent wallet

Phantom MCP (`@phantom/mcp-server`) le da al agente una wallet **nueva y dedicada**, aislada de la wallet personal de Dino: nace en cero. Ese aislamiento es la razón de usarla: si el agente se equivoca, el daño máximo es lo que haya en esa wallet.

- **Sin fondeo en mainnet (decisión de Dino, validada en DIN-4):** Dino no fondea la agent wallet en mainnet. La fase 0 se validó sin mover plata real, en dos planos:
  - **Mainnet, solo lectura y cotización:** quotes reales de Jupiter Swap API v2 con `taker` = agent wallet y armado de transacción, más paths de simulación — todo con saldo cero.
  - **Devnet, firma end-to-end:** Phantom MCP firmando de punta a punta con SOL/USDC de faucet. La preview se asertó con `advancedDetails.chainId` = `solana:103`, el envío devolvió `confirmed: true` y la signature `4apFAa2mRHGKWcrsZib49yZQBKyVgPpRpzHwNq9T9cMbiMmjtWgjtet9qtR9ewHpWzU9oY9nPBZdRHwk76DevRKy` quedó finalized en devnet.
- **Modo de demo de fase 1: Track A.** Quotes reales de Jupiter (`/order` con `taker` + armado de transacción) y simulación contra mainnet; portfolio calculado desde balances on-chain vía RPC valuados a precios reales (Jupiter); al confirmar, se acredita un **paper fill** solo si la simulación pasa. La ejecución real on-chain queda detrás de un **config flag** apagado por defecto, y encenderlo exige fondeo que hoy no existe y decisión explícita de Dino.
- **Sign-in:** flujo device-code en el browser; no requiere Portal App ID. La session queda **guardada localmente en la máquina donde corre el MCP** — consecuencia directa: el MCP de la demo corre en la Mac de Dino o en un host controlado, nunca como servicio compartido.
- **Signing:** OIDC stamper → KMS con policy enforcement del lado de Phantom. La clave privada nunca llega a nuestro backend ni al LLM. En devnet, la firma probada va por `transfer`/`solana_send` (ver limitaciones).
- **Tools que usamos:** `wallet_addresses`, `wallet_balances`, `simulate`, `buy`, `transfer`/`solana_send`. El resto de las ~30 tools queda fuera del allowlist del agente ([03-agent-flows.md](03-agent-flows.md)). La tool `price` de Phantom **no** es nuestra fuente de precios: devuelve `Token not found` tanto para los mints de xStocks como para el USDC de Solana (probado en DIN-4); los precios salen de Jupiter.
- **Limitación probada:** Phantom `buy` **no rutea en devnet** (HTTP 400); el swap en devnet no es el camino para probar firma — para eso están `transfer`/`solana_send`. `buy` queda como ejecutor previsto solo con el flag de ejecución encendido y en mainnet.
- **Regla dura:** toda tool con efecto on-chain se invoca únicamente a través del confirmation gate ([04-confirmation-gate.md](04-confirmation-gate.md)), y antes de ejecutar se corre `simulate`/quote para poblar la propuesta. En Track A, "ejecutar" significa simular y acreditar el paper fill.

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
3. **Topes por capa:** saldo cero en mainnet + flag de ejecución apagado (demo) → confirmation gate (siempre) → spending limit de Connect (fase 2). Ninguna capa sustituye a otra.
4. **La session del MCP es un secreto operativo:** vive en la máquina del operador, no se commitea, no se sincroniza.

## Criterios de aceptación

- [ ] `wallet_addresses` devuelve la Solana address de la agent wallet y queda registrada en la config de la demo (sin secretos en el repo).
- [ ] Balance mainnet en cero verificado, y ninguna fase requiere fondeo de Dino en mainnet: la validación corre con quotes/simulación en mainnet y firma en devnet (evidencia DIN-4).
- [ ] En Track A, ningún paper fill se acredita sin simulación aprobada, y el flag de ejecución real viene apagado por defecto.
- [ ] Ningún archivo del repo contiene session data, tokens OIDC ni claves.
- [ ] La demo opera sin tocar jamás la wallet personal de Dino.

## Preguntas abiertas

- ¿El MCP de la demo corre en la Mac de Dino o en un host siempre encendido? Afecta disponibilidad de la demo. → [06-roadmap-risks.md](06-roadmap-risks.md), Q4.
