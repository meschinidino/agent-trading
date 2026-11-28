# 01 — Wallet

## Objetivo

Definir el modelo de wallet para la demo y para la escala multi-usuario, con custodia y límites explícitos, de modo que ninguna fase dependa de keypairs crudos administrados por nosotros.

## Alcance

- Demo: agent wallet de Phantom MCP sin fondeo en mainnet; operación en modo Track A (ver Detalle).
- Prep de fase 2: consultar una wallet Solana existente del usuario, sin firma.
- Fase 2: embedded wallets de Phantom Connect por usuario, con spending limits.
- Notas de custodia y seguridad aplicables a ambas.

## Fuera de alcance

- Implementación del cliente MCP ni del SDK de Connect (se consume como servicio).
- Recovery social, seed phrase UX y exportación de claves: lo resuelve Phantom, no lo tocamos.
- Wallets en BSC (Phantom MCP no lo soporta para transaction tools) y cualquier chain no-Solana en la demo.

## Detalle

### Demo — Phantom MCP agent wallet

Phantom MCP (`@phantom/mcp-server`) le da al agente una wallet **nueva y dedicada**, aislada de la wallet personal del operador: nace en cero. Ese aislamiento es la razón de usarla: si el agente se equivoca, el daño máximo es lo que haya en esa wallet.

- **Sin fondeo en mainnet (decisión del operador, validada en DIN-4):** El operador no fondea la agent wallet en mainnet. La fase 0 se validó sin mover plata real, en dos planos:
  - **Mainnet, solo lectura y cotización:** quotes reales de Jupiter Swap API v2 con `taker` = agent wallet y armado de transacción, más paths de simulación — todo con saldo cero.
  - **Devnet, firma end-to-end:** Phantom MCP firmando de punta a punta con SOL/USDC de faucet. La preview se asertó con `advancedDetails.chainId` = `solana:103`, el envío devolvió `confirmed: true` y la signature `4apFAa2mRHGKWcrsZib49yZQBKyVgPpRpzHwNq9T9cMbiMmjtWgjtet9qtR9ewHpWzU9oY9nPBZdRHwk76DevRKy` quedó finalized en devnet.
- **Modo de demo de fase 1: Track A.** Quotes reales de Jupiter (`/order` con `taker` + armado de transacción) y simulación contra mainnet según la especificación exacta de abajo; portfolio con balances on-chain reales vía RPC más posiciones paper del ledger ([05-backend-api.md](05-backend-api.md)), valuados a precios reales (Jupiter). Al confirmar, se acredita un **monto simulado a quote** solo si esa simulación pasa. Nunca se lo llama "fill": una simulación prueba ejecutabilidad en un slot, no un fill al precio cotizado. La ejecución real on-chain queda detrás de un **config flag** apagado por defecto, y encenderlo exige fondeo que hoy no existe y decisión explícita del operador.
- **Saldo paper de referencia:** 100 USDC paper por usuario en el ledger paper ([05-backend-api.md](05-backend-api.md)). Es el saldo contra el que se validan propuestas Track A y el que usan todos los ejemplos del paquete. No existe on-chain y nunca se lo presenta como saldo de wallet.
- **Sign-in:** flujo device-code en el browser; no requiere Portal App ID. La session queda **guardada localmente en la máquina donde corre el MCP** — consecuencia directa: el MCP de la demo corre en el host del operador (single-tenant dev host today) o en un host dedicado controlado, nunca como servicio compartido.
- **Signing:** OIDC stamper → KMS con policy enforcement del lado de Phantom. La clave privada nunca llega a nuestro backend ni al LLM. En devnet, la firma probada va por `transfer`/`solana_send` (ver limitaciones). **Quién firma una transacción de Jupiter con el flag prendido: la agent wallet, vía Phantom MCP `solana_send` sobre la transacción construida por Jupiter** ([02-swaps-xstocks.md](02-swaps-xstocks.md)); en fase 2 firma el usuario vía Phantom Connect. No queda ningún either/or abierto en este punto.
- **Tools que usamos:** `wallet_addresses`, `wallet_balances`, `simulate`, `buy` (solo en modo quote/comparación, nunca como ejecutor — ver [02-swaps-xstocks.md](02-swaps-xstocks.md)), `solana_send` (solo para enviar la transacción de Jupiter con el flag prendido, detrás del gate). El resto de las ~30 tools queda fuera del allowlist del agente ([03-agent-flows.md](03-agent-flows.md)). La tool `price` de Phantom **no** es nuestra fuente de precios: devuelve `Token not found` tanto para los mints de xStocks como para el USDC de Solana (probado en DIN-4); los precios salen de Jupiter.
- **Limitación probada:** Phantom `buy` **no rutea en devnet** (HTTP 400); el swap en devnet no es el camino para probar firma — para eso están `transfer`/`solana_send`. `buy` nunca es el ejecutor del path con flag prendido ([02-swaps-xstocks.md](02-swaps-xstocks.md)).
- **Regla dura:** toda tool con efecto on-chain se invoca únicamente a través del confirmation gate ([04-confirmation-gate.md](04-confirmation-gate.md)), y antes de ejecutar se corre `simulate`/quote para poblar la propuesta. En Track A, "ejecutar" significa simular según la especificación de abajo y acreditar el monto simulado a quote en el ledger paper.

### Simulación que acredita un monto paper (especificación exacta)

Track A acredita un monto simulado a quote **solo** si pasa esta simulación, sin sustituciones no declaradas:

1. Se toma la transacción construida por Jupiter `/order` para la quote persistida ([05-backend-api.md](05-backend-api.md)), con `taker` = agent wallet.
2. Se la simula con el método RPC `simulateTransaction` de Solana, con `sigVerify: false` y `replaceRecentBlockhash: true` cuando el blockhash de la quote ya venció.
3. **"Pasa" significa:** la simulación devuelve sin error en la instrucción de swap (sin `err` en el resultado ni error de instrucción en los logs del programa de swap). Cualquier otro resultado — error, timeout del RPC, respuesta no parseable — no acredita nada y la confirmation pasa a `failed` con el motivo en lenguaje llano.
4. **Falla esperada con wallet sin fondeo:** con saldo cero, la simulación fiel falla en el transfer de entrada (fondos insuficientes). Por eso el modo paper aplica una **sustitución de saldos documentada**: la simulación corre con las cuentas de token de entrada sustituidas por saldos simulados consistentes con el saldo paper del ledger (mecanismo de sustitución de cuentas del RPC o equivalente del proveedor, registrado en el audit log como `simulationMode: paper-substituted`). Esta sustitución es parte explícita del modelo paper: prueba que la ruta y las instrucciones son ejecutables, no que existan fondos. Si el proveedor RPC no soporta la sustitución, Track A no acredita y se reporta ese bloqueo; no se relaja la simulación a un chequeo más débil sin registrarlo como cambio de spec.
5. El monto acreditado es el `outAmount` de la quote persistida, etiquetado en todo el sistema como **"simulado a quote"** (`mode: paper`, [05-backend-api.md](05-backend-api.md)). Nunca "fill", nunca con link a explorer.

### Canal backend → MCP (boundary de custodia)

El MCP es el boundary de custodia de la demo: quien puede invocarlo puede firmar. Queda especificado así:

- **Fases 0–1:** Eve y el backend corren en el **mismo host** que el Phantom MCP (host del operador — single-tenant dev host today — o un host dedicado controlado). El MCP escucha solo por stdio o loopback; nunca se expone en una interfaz de red, ni directa ni por túnel público.
- **Si Eve pasa a correr en Vercel (o cualquier host remoto):** el MCP se mueve a un host dedicado y el backend lo alcanza solo por un canal privado autenticado (red privada con autenticación mutua o equivalente; el requisito es canal privado + autenticación de ambos extremos, no un proveedor concreto). Nunca MCP sobre internet pública.
- **Allowlist enforceada en el adapter del backend**, no en el prompt: solo `wallet_addresses`, `wallet_balances`, `simulate`, `buy` en modo quote/comparación, y los flujos `solana_send`/`simulate` que necesita el path de la demo. `transfer` y cualquier `solana_send` que no sea el envío de la transacción de Jupiter detrás del gate quedan **bloqueados por config fuera del gate** en mainnet.
- **Policy de Phantom KMS como control nombrado (checklist):** antes de prender el flag de ejecución, el operador verifica y registra en el audit operativo: (a) policy de la agent wallet limitada a la app/dominio de la demo; (b) techos de monto por transacción y por día en la policy, si Phantom los expone; (c) denegación de destinos fuera del registry de [02-swaps-xstocks.md](02-swaps-xstocks.md) cuando la policy lo permita expresar; (d) fecha y operador de la última revisión de la policy. Sin este checklist completo, el flag no se prende.

### Límites (regla canónica)

**Los límites nunca saltean el gate; solo agregan fricción sobre umbrales.** Esta oración es la regla canónica y vive también en [04-confirmation-gate.md](04-confirmation-gate.md): ningún límite, en ninguna fase, convierte una propuesta en auto-aprobada. En Track A rigen además topes de hábito, aunque el dinero sea paper: **tope por propuesta de 25 USDC paper y tope de 50 USDC paper por día por usuario**; superarlos rechaza la propuesta antes del gate con el motivo en lenguaje llano. Son config del backend, no del prompt.

### Prep de fase 2 — Phantom inyectado, solo lectura (DIN-36)

- La web usa el [provider de Solana inyectado por Phantom](https://docs.phantom.com/solana/establishing-a-connection): `window.phantom.solana` y `isPhantom`. La persona inicia la conexión y puede desconectarse. Ante un cambio autorizado de cuenta se consulta la nueva dirección; ante una desconexión o una cuenta sin permiso se borran dirección y saldos sin reconectar. La conexión queda en memoria de la página: recargar no la reanuda. No se piden firmas, claves ni permisos para operar, ni se usa la wallet como credencial de Onda.
- En el panel **Wallet Solana**, la red es la red de consulta de Onda, no una lectura ni un cambio de la configuración de Phantom. Mainnet muestra SOL, USDC oficial y solo los xStocks del registry (SPYx, AAPLx, NVDAx). Devnet muestra SOL y [USDC de prueba de Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses), sin xStocks. El panel muestra la hora de la última consulta exitosa y permite actualizar a mano. Un cambio de cuenta, red o una nueva consulta invalida la respuesta anterior.
- `GET /api/v1/connected-wallet/balances?address=…&network=mainnet|devnet` exige sesión web y valida la dirección pública. La dirección se envía al backend y al RPC, sin guardarla en el perfil, el ledger, el historial, el agente ni MCP. El servidor verifica `getGenesisHash` antes de consultar cada endpoint y no mezcla clusters ni devuelve ceros parciales si el RPC falla. Lee cuentas SPL del propietario y, en Mainnet, Token-2022 con [los montos escalados del RPC](https://solana.com/docs/tokens/extensions/scaled-ui-amount/integration-guide) para xStocks, suma cuentas del mismo mint y devuelve montos como decimales exactos del snapshot. No usa los saldos para proponer ni ejecutar.

### Fase 2 — Phantom Connect embedded wallets

**Prerequisito de implementación:** según la [documentación oficial del Browser SDK](https://docs.phantom.com/sdks/browser-sdk), el alta embebida con Google/Apple necesita una app existente de Phantom Portal, su App ID y los orígenes y redirects autorizados. Phantom informa que no acepta nuevas aplicaciones de Connect; los App IDs existentes no están afectados. Confirmar disponibilidad de una app autorizada y las políticas vigentes antes de diseñar contra ese SDK (DIN-39). El provider inyectado de esta etapa no necesita App ID: en Devnet, con una extensión compatible instalada en un navegador de prueba, permite validar conexión y lectura de SOL/USDC de prueba sin cuenta de Portal. Eso no prueba onboarding social, creación de wallets embebidas, políticas del proveedor, firma, ejecución ni swaps de xStocks.

Cuando haya muchos usuarios, el patrón MCP no escala: una session local por agente no es multi-tenant. El path de escala es Phantom Connect, un producto separado:

- Cada usuario obtiene una embedded wallet al registrarse con Google/Apple (social login), **non-custodial**, sin seed phrase visible.
- **Spending limits:** default de USD 1.000 por app/día por usuario, configurable. Es un techo operativo que **agrega fricción sobre el umbral** (re-autenticación o confirmación reforzada por encima de él); nunca autoriza a operar sin gate. Por debajo del límite, el gate se aplica igual, sin excepción.
- **Domain binding y sesiones de ~31 días:** la session se ata al dominio de la app; vencida, el usuario re-ingresa con social login.
- El backend guarda `user_id → wallet_address` (Solana) y nunca claves. La firma sigue ocurriendo del lado de Phantom.

### Por qué no raw keypairs

Administrar keypairs propios (guardar seeds en un KMS propio, firmar transacciones a mano) nos convierte en custodios de facto: responsabilidad legal, superficie de ataque y trabajo de signing que Phantom ya resuelve con policy enforcement. Para una demo cuyo diferencial es el agente y el gate, la custodia es commodity: se delega. El costo es dependencia de Phantom, aceptado y registrado como riesgo en [06-roadmap-risks.md](06-roadmap-risks.md).

### Custodia y seguridad — notas

1. **El LLM nunca ve credenciales.** Ve addresses, balances y resultados de tools.
2. **Allowlist de tools y de mints:** el agente solo puede operar los tokens del registry de [02-swaps-xstocks.md](02-swaps-xstocks.md). La allowlist se enforcea en el adapter del backend (ver arriba), no en el prompt.
3. **Topes por capa:** saldo cero en mainnet + flag de ejecución apagado (demo) → confirmation gate (siempre) → spending limit de Connect (fase 2). Ninguna capa sustituye a otra.
4. **La session del MCP es un secreto operativo:** vive en la máquina del operador, no se commitea, no se sincroniza.

## Criterios de aceptación

- [ ] `wallet_addresses` devuelve la Solana address de la agent wallet y queda registrada en la config de la demo (sin secretos en el repo).
- [ ] Balance mainnet en cero verificado, y ninguna fase requiere fondeo del operador en mainnet: la validación corre con quotes/simulación en mainnet y firma en devnet (evidencia DIN-4).
- [ ] En Track A, ningún monto simulado a quote se acredita sin la simulación aprobada según la especificación exacta de este documento, y el flag de ejecución real viene apagado por defecto.
- [ ] El saldo paper inicial es 100 USDC por usuario en el ledger paper y todo ejemplo del paquete es consistente con ese saldo.
- [ ] El adapter del backend rechaza cualquier tool del MCP fuera de la allowlist, y `transfer`/`solana_send` mainnet fuera del envío de Jupiter detrás del gate están bloqueados por config (test).
- [ ] Ningún archivo del repo contiene session data, tokens OIDC ni claves.
- [ ] La demo opera sin tocar jamás la wallet personal del operador.

## Preguntas abiertas

- ¿El MCP de la demo corre en el host del operador (single-tenant dev host today) o en un host siempre encendido? Afecta disponibilidad de la demo. → [06-roadmap-risks.md](06-roadmap-risks.md), Q4. En ambos casos rigen las reglas del canal backend → MCP de este documento.
