# Onda en Kubernetes local (kind)

Container Apps sigue siendo el entorno del preview. Este ensayo usa un clúster descartable de un nodo, el mismo [Dockerfile](../Dockerfile) y datos sintéticos. No requiere Azure, ACR, cuentas de la app en producción ni fondos. Sí requiere salida a internet para bajar las imágenes/dependencias y para el boot check de Jupiter.

## Arranque desde cero

Desde la raíz del repo, con un motor Docker local (Docker Desktop o Colima, por ejemplo), kind v0.33.0, kubectl compatible con Kubernetes 1.36, OpenSSL y Node.js 24 o superior. Usá el mismo contexto Docker local para los tres comandos de kind/Docker. Comprobá que el nombre del clúster no esté ya en uso.

```bash
umask 077
work="$(mktemp -d)"
cluster=onda-local
kcfg="$work/kubeconfig"
kind create cluster --name "$cluster" --kubeconfig "$kcfg" --wait 120s \
  --image kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed
docker build -f deploy/Dockerfile -t onda:kind .
kind load docker-image onda:kind --name "$cluster"

kubectl --kubeconfig "$kcfg" create namespace onda
openssl rand -hex 32 | tr -d '\n' |
  kubectl --kubeconfig "$kcfg" -n onda create secret generic onda-secrets --from-file=SESSION_SECRET=/dev/stdin
kubectl --kubeconfig "$kcfg" apply -k deploy/k8s/overlays/kind
kubectl --kubeconfig "$kcfg" -n onda rollout status deployment/onda --timeout=140s
```

La carpeta `base/` es un componente de Kustomize, no un destino de despliegue. El overlay usa el PVC local del StorageClass `standard` de kind y una sola réplica con estrategia `Recreate`. `ReadWriteOnce` restringe el montaje por nodo, no por pod: no escales la app ni montes el mismo volumen desde otra carga para escribir. WAL se configura solo para bases nuevas. No reuses un clúster ni un PVC con datos que quieras conservar.

## Ensayo reproducible

En el clúster recién creado, sin registrar usuarios antes ni abrir otro port-forward:

```bash
node deploy/k8s/smoke.mjs "$kcfg"
```

El script abre y cierra el port-forward en **127.0.0.1:18080**. Verifica health y la web con la base inicialmente vacía; registra una cuenta descartable, escribe en el ledger paper, prueba SSE sin sesión (401), sostiene un stream con sesión durante más de 90 segundos con heartbeats y reconecta para recibir ready y quotes nuevos. Prueba MCP Streamable HTTP sin token (401), inicialización, listado de tools, lectura de límites paper y 401 tras revocación. No propone ni firma operaciones.

El script detiene la única réplica antes de recrearla y verifica que la sesión y las filas persisten con un UID de pod nuevo. Toma un backup SQLite consistente con la API de backup, escribe una segunda carga sintética para diferenciar el origen del snapshot, detiene nuevamente la app y restaura en otro PVC. Compara SHA-256, PRAGMA integrity_check, conteos y filas del ledger antes de levantar la app con el PVC restaurado y verificar una nueva escritura. No sobrescribe el PVC de origen: la segunda carga queda ahí y no aparece en la copia restaurada. El ensayo modifica el entorno local y no es idempotente; para repetirlo, eliminá y recreá el clúster descartable.

Para explorar manualmente en vez de correr el smoke, o después de que termine:

```bash
kubectl --kubeconfig "$kcfg" -n onda port-forward --address 127.0.0.1 svc/onda 18080:80
```

Abrí http://127.0.0.1:18080/ o consultá /health. Al terminar, cerrá el port-forward con Ctrl+C y eliminá **solo el clúster descartable** y su kubeconfig:

```bash
kind delete cluster --name "$cluster" --kubeconfig "$kcfg"
rm -f "$kcfg"
rmdir "$work"
```

## Alcance

El ensayo usa HTTP sobre localhost y almacenamiento local al nodo kind. Prueba recreación de pods, no pérdida del nodo, ingress, DNS, TLS, Azure Disk CSI ni comportamiento de streaming a través de un proxy.

AKS queda diferido (DIN-29); no hay overlay AKS aplicable ni cutover solicitado. El diseño de PR #26 quedó reemplazado: [AKS no admite B-series en el system pool y requiere al menos dos nodos](https://learn.microsoft.com/en-us/azure/aks/use-system-pools). [Ingress NGINX se retiró](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/). [Application Routing con Gateway API administrada](https://learn.microsoft.com/en-us/azure/aks/app-routing-gateway-api) y Azure Disk CSI son opciones futuras, no probadas por este ensayo.
