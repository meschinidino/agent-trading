# Ensayo de transferencia en Solana devnet (DIN-40)

Herramienta independiente de Onda para ensayar una transferencia de **0,001 SOL de prueba** (1.000.000 lamports). No modifica el ledger paper, no inicia la app y no usa Phantom, Connect, Jupiter ni xStocks. No valida firma humana de wallet, multiusuario ni ejecución del producto.

## Prueba reproducible sin red

Desde la raíz del repo, con Node 24:

```sh
cd tools/devnet-rehearsal
npm ci --ignore-scripts
npm test
```

Una vez instaladas las dependencias, los tests no necesitan red. La fixture decodifica y verifica la firma Ed25519 de la transacción de prueba, comprueba la instrucción y simula las respuestas del RPC. Los slots, firmas y balances de la fixture **no son evidencia on-chain**.

## Intento contra devnet

```sh
node rehearsal.mjs --live --automated
```

Al 28 de noviembre de 2026, el RPC público responde **HTTP 410** al fondeo: [Solana retiró `requestAirdrop` de devnet](https://solana.com/docs/rpc/http/requestairdrop). El comando comprueba primero el genesis y luego se detiene si no puede verificar un depósito finalizado. No hay fallback a un proveedor externo, una clave persistida ni otra red. El [faucet web de Solana](https://faucet.solana.com/) indica que no lo usen agentes; el CLI de PoW que enlaza necesita un pagador con SOL de prueba para el primer reclamo.

El modo `--automated` identifica explícitamente tanto la aprobación de test como la firma automática. Sin esa opción, el ensayo exige una terminal interactiva y, después del fondeo, muestra red, activo, importe, emisor, destino, vencimiento e ID; el operador tiene 60 segundos para escribir el desafío exacto. Eso aprueba una propuesta, no demuestra identidad ni constituye una firma humana de wallet: ambos modos usan una clave de prueba generada en memoria y descartada al salir.

El único endpoint es `https://api.devnet.solana.com`, con redirects rechazados y genesis exacto `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` comprobado antes de fondear y de firmar. No se aceptan endpoints, wallets ni transacciones como entrada. Cada proceso genera su propio emisor y destino; la aprobación es de un solo uso, incluso ante un envío incierto.

El CLI imprime la signature local antes de enviar y no reenvía ante un timeout. Solo genera recibo si el RPC devuelve la transacción como `finalized`, con los mismos bytes, `meta.err = null`, delta exacto del destino y débito del emisor igual al monto más fee. Si la finalidad no se observa, consultar la signature registrada en el [explorador devnet](https://explorer.solana.com/?cluster=devnet); no dar por hecho el éxito ni reintentar esa aprobación.
