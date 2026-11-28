# Onda on AKS — diseño etapa 2 (DIN-34, fase de diseño)

> Estado: **propuesta para aprobación de Dino. Nada de esto está creado en Azure.**
> En esta fase no se ejecutó ningún `az aks create`, no se creó ningún resource group y no hay ningún recurso facturable nuevo. Los YAML de esta carpeta son **draft de revisión**: no contienen secretos reales y aplicarlos hoy no funciona (falta el cluster, el secreto y la IP), que es intencional.
> Issue: DIN-34 · refs DIN-34

## La frase que decide

Hoy Onda corre en Container Apps por **≈ USD 20–30/mes**. La opción AKS recomendada acá cuesta **≈ USD 65–70/mes** (estimación con precios retail citados en §7). Es decir: **Kubernetes no abarata nada; sale ~USD 40/mes más.** Si Dino aprueba, aprueba pagar ese delta a cambio de tener Kubernetes real (manifests, `kubectl`, ingress estándar) como plataforma de aprendizaje/demo interna — no a cambio de ahorro ni de SLA (el tier recomendado no tiene SLA financiero).

```
OK needed: ~USD 40/month delta (≈ USD 65–70/mes total AKS vs ≈ USD 20–30/mes actual)
Recommended: AKS Free tier + 1 nodo Standard_B2s + NGINX ingress + Managed Disk RWO (opción A)
Container Apps queda intacto hasta que Dino diga lo contrario.
```

## 1. Estado actual verificado (2026-11-28)

Verificado, no copiado de memoria:

- Repo `main` = `e5545da7d75ea1072c84d3719c06e2e27b287485`, `VERSION` = `0.6.0`.
- Prod: Container App `onda` en `rg-agent-trading-preview` (eastus), revisión `onda--0000007`, imagen `ondaagenttrading.azurecr.io/onda:v0.6.0`, **1 réplica fija** (min=max=1), **0.5 vCPU / 1 GiB**.
- `/health` público: `version 0.6.0`, `executionEnabled:false`, `mcpEnabled:true`, `sseEnabled:true` (AGEN-41).
- DB: SQLite (`node:sqlite`) en `DATABASE_PATH=/data/app.sqlite`, sobre share Azure Files `ondaagentdata/ondata` montado en `/data` (SMB).
- `SESSION_SECRET` existe solo como secreto de Container Apps; nunca estuvo en git.
- Env de paridad (leído de `apps/api/src/config.ts` y del template vivo): `PORT=8080`, `SERVE_WEB=true`, `WEB_DIST=/app/apps/web/dist`, `DATABASE_PATH=/data/app.sqlite`, `EXECUTION_ENABLED=false`, `EXECUTION_MODE=paper`, `AGENT_MODE=parser`, `MCP_ENABLED=true`, `PUBLIC_BASE_URL=https://onda.wonderfulsky-b50ff12c.eastus.azurecontainerapps.io`, `SESSION_SECRET` (secretRef).
- Recursos vivos en el RG (lectura `az resource list`): Container Apps env `onda-env`, app `onda`, ACR `ondaagenttrading` (Basic), storage `ondaagentdata` (Standard_LRS), Log Analytics `onda-logs`, y el mockup estático `agenttradingprev6cbfcf` (no tocar).

## 2. Arquitectura propuesta (opción recomendada)

```
Internet
  │  https://onda-demo.eastus.cloudapp.azure.com   (DNS label del LB; nombre a confirmar al crear la IP)
  ▼
Azure Load Balancer (Standard, lo crea el Service de ingress-nginx) + IP pública estática
  ▼
ingress-nginx (Helm, 1 réplica) ── TLS: cert-manager + Let's Encrypt (HTTP-01)
  │  proxy-read/send-timeout 3600s  ← SSE: ver §2.3
  ▼
Service onda (ClusterIP) ──► Deployment onda — 1 réplica, strategy: Recreate
                              imagen ondaagenttrading.azurecr.io/onda:vX.Y.Z
                              requests/limits: 500m CPU / 1Gi (paridad con hoy)
                              PVC Managed Disk RWO 32 GiB montado en /data
AKS: 1 cluster, tier Free, eastus, Kubernetes 1.33, 1 node pool x 1 nodo Standard_B2s (2 vCPU/4 GiB)
```

### 2.1 Cluster

| Decisión | Valor | Por qué |
|---|---|---|
| Tier de management | **Free** ($0/cluster-h) | Demo interna; el Standard suma $0.10/h ≈ $73/mes solo por SLA del API server — más que todo el resto. Sin SLA financiero, best-effort: aceptable para demo, inaceptable si esto pasa a ser prod con usuarios que importan. |
| Node pool | **1 solo pool, 1 nodo**, `Standard_B2s` (2 vCPU / 4 GiB) | Es el SKU más chico que deja aire real: system pods + ingress-nginx (~300–500 MB) + app (1 Gi pedida) no entran sanos en B1ms (1 vCPU/2 GiB). B2s verificado a $0.0416/h retail eastus ≈ $30.37/mes. |
| Autoscaling | **Apagado** (ni cluster-autoscaler ni HPA) | La app no puede escalar horizontalmente (SQLite single-writer, §2.2). Autoscalar nodos solo agregaría costo y superficie. Si el pod pide más de lo que el nodo da, se arregla subiendo el SKU, no con réplicas. |
| Kubernetes | **1.33** (la más nueva que devolvió `az aks get-versions -l eastus` hoy: 1.31/1.32/1.33) | Quedar en la versión soportada más nueva alarga la ventana antes del próximo upgrade forzado. Confirmar al crear; AKS mueve versiones rápido. |
| Región / RG | eastus, **RG nuevo propuesto** `rg-agent-trading-aks` | No mezclar con `rg-agent-trading-preview`: teardown limpio con un solo `az group delete` si Dino lo ordena después. |
| Identidad / ACR | Managed identity del cluster + rol `AcrPull` sobre `ondaagenttrading` (el ACR actual, se reusa) | Mismo registro que hoy; la imagen no se duplica. Falta verificar en la fase de ejecución si el ACR admite el attach directo (`--attach-acr`) o si va asignación de rol sobre la kubelet identity. |

### 2.2 Workload — la restricción que manda

**SQLite fuerza 1 solo escritor, y eso fuerza todo lo demás.** `node:sqlite` con un único archivo en `/data`: dos pods escribiendo el mismo archivo son exactamente el escenario de los incidentes DIN-25/DIN-30 (locks que el boot no puede robarle a un holder vivo). Por lo tanto:

- `Deployment` con `replicas: 1` y `strategy: Recreate` (nunca RollingUpdate: durante un roll quedarían dos pods montando el mismo volumen).
- Nada de HPA. Escalar = mover la DB fuera de SQLite (opción C, §3), no tocar el Deployment.
- `resources`: requests `cpu 500m, memory 1Gi`, limits `cpu 1, memory 1Gi` — espejo de los 0.5 vCPU/1 GiB actuales, con un poco de burst de CPU.
- Probes contra `GET /health` (existe, es barato y ya reporta versión/flags).
- El pod es **stateful de hecho**: si el nodo muere, el pod reprograma y el disco RWO se re-atacha (ver §3). Mientras tanto hay downtime de minutos, no pérdida de datos.

### 2.3 Ingress y HTTPS — NGINX + cert-manager, no Application Gateway

**Elegido: ingress-nginx + cert-manager con Let's Encrypt.**

- Costo: ingress-nginx corre dentro del nodo que ya pagás. Lo único facturable es el Load Balancer Standard que AKS crea solo para el Service del ingress (reglas base ≈ $18/mes según tabla pública de LB, más la IP pública ≈ $3.65/mes). Application Gateway Standard_v2 cuesta **$0.246/h ≈ $180/mes fijo** antes de capacity units (fuente: Microsoft Learn, tabla East US) — es decir, el gateway solo cuesta ~3× todo el cluster propuesto. Para una demo interna es indefendible.
- Simplicidad: los manifests de ingress-nginx son los que cualquier tutorial/LLM conoce; Application Gateway Ingress Controller (AGIC) acopla la config a anotaciones propietarias de Azure y suma un add-on que administrar.
- SSE (crítico): el stream `GET /api/v1/events` manda heartbeat cada 20 s y puede vivir indefinidamente. ingress-nginx por defecto corta proxies a los 60 s. El manifest draft ya trae `proxy-read-timeout: "3600"` y `proxy-send-timeout: "3600"`, `proxy-buffering: "off"`. **Sin esto, SSE muere al minuto en AKS aunque ande perfecto en Container Apps.** Es el riesgo de config número uno de la migración.
- FQDN: el hostname actual `onda.wonderfulsky-b50ff12c.eastus.azurecontainerapps.io` **desaparece** (es de Container Apps). En AKS la demo vive en el DNS label de la IP pública del LB: `https://<label>.eastus.cloudapp.azure.com`. Let's Encrypt emite para ese FQDN sin problema (HTTP-01). Dominio propio = Q-M3, decisión de Dino, **no se compra nada en esta etapa**. `PUBLIC_BASE_URL` cambia a ese FQDN — si no, los `signingUrl` del MCP quedan apuntando al hostname viejo.

## 3. Storage — la decisión crítica

### Evidencia propia (no teoría)

- **AGEN-28 / DIN-25:** un `app.sqlite` de 0 bytes sobre el share SMB no abre en WAL (`database is locked` en `PRAGMA journal_mode=WAL`) y cada crash-loop lo recrea vacío. Prod en 404 durante la recuperación.
- **AGEN-31:** la DB viva tiene `-wal` y `-shm` vivos en el share; el archivo principal solo no es el estado completo.
- **AGEN-34 / DIN-30:** la 0.5.2 crash-loopeó incluso booteando **sola**: forzar `journal_mode=DELETE` sobre la DB WAL existente exige un lock EXCLUSIVE que SMB no concede; locks residuales sobre SMB sobrevivieron >3 min con la revisión nueva como única activa.
- **AGEN-37/41:** el fix 0.5.4 (respetar el journal mode existente + retry de boot de 30 s) hizo los deploys sobrevivibles, pero la transición ordenada (desactivar la vieja primero) sigue siendo la secuencia recomendada en `deploy/README.md`. Traducción: sobre SMB, funcionar funciona — a fuerza de runbook cuidadoso y ventanas de ~40–60 s sin réplica sana en cada deploy.

### Opciones

| | (a) Managed Disk RWO ✅ | (b) Azure Files SMB (como hoy) | (c) Azure DB for PostgreSQL |
|---|---|---|---|
| Qué es | PVC `managed-csi` Premium SSD, 32 GiB, `ReadWriteOnce` | PVC `file.csi.azure.com`, el mismo share/clase que hoy | Flexible Server Burstable B1ms (1 vCore/2 GiB) + 32 GiB |
| Semántica SQLite | **Disco local**: WAL, locks POSIX y fsync se comportan como en un disco de verdad. La clase de falla DIN-25/DIN-30 desaparece porque no hay SMB de por medio. | La misma clase de riesgo que hoy: locks sobre SMB, sidecars `-wal/-shm` remotos, transición ordenada obligatoria en cada deploy. | SQLite desaparece; la app hablaría SQL de red. |
| Costo storage | E10 Standard SSD 128 GiB ≈ $9.60/mes publicado; 32 GiB (E4) ≈ $3–4/mes est. — Premium P10 128 GiB $17.92/mes si se quiere IOPS garantizadas (innecesario acá). | ≈ $1/mes (5 GiB a $0.06/GB + operaciones, retail verificado). | Compute $0.017/h ≈ $12.41/mes + storage 32 GiB × $0.115 = $3.68 → **≈ $16/mes**, sin contar backups. |
| Trabajo de código | **Cero.** Mismo `DATABASE_PATH=/data/app.sqlite`. | Cero. | **Grande y fuera de alcance de esta etapa:** `node:sqlite` es síncrono y local; migrar es reescribir la capa de datos (driver async, dialecto SQL, migraciones, tests de db/boot reescritos). Es una etapa propia con su propio diseño, no un ítem de esta migración. |
| Backup | Snapshot del disco (manual o Azure Backup); el archivo sigue siendo un solo `.sqlite` copiable. | El share ya es copiable, pero copiar en caliente con WAL vivo exige checkpoint (ver §4). | Backups automáticos del servicio; PITR según retención. |
| Riesgo principal | Single point of failure honesto: si el disco se corrompe no hay réplica. Mitigación: snapshot antes de cada deploy + la copia fría verificada de §4 queda en el repo de la operación, no en el disco. | Repetir DIN-25/DIN-30 con otro nombre. Cada deploy vuelve a ser un procedimiento. | Costo + reescritura; y resuelve un problema (multi-writer) que la demo no tiene. |

**Recomendación: (a) Managed Disk RWO.** Es la única opción que elimina la causa raíz documentada (SMB entre SQLite y el archivo) sin tocar una línea de código. (b) es ahorrar ~$6/mes a cambio de seguir operando con el runbook de transición ordenada para siempre. (c) es la respuesta correcta el día que Onda necesite más de una réplica o alta disponibilidad real — ese día se diseña como su propia etapa; mezclarla con "aprender Kubernetes barato" duplica el riesgo de ambas.

Nota de journal mode: sobre disco local, WAL vuelve a ser seguro y es el default histórico del archivo de prod (la DB existente ya está en WAL y el boot la respeta sin forzar switch — comportamiento 0.5.4). En el PVC nuevo la DB migrada conserva su modo; no se fuerza ningún `PRAGMA` nuevo como parte de la migración.

## 4. Migración de la DB existente (procedimiento, se ejecuta recién en la fase siguiente)

La DB viva tiene usuarios reales (AGEN-31 verificó filas reales; AGEN-34/37/41 sumaron cuentas smoke). **Perderla no es aceptable y moverla en caliente tampoco.** Procedimiento propuesto, a ensayar primero con una copia:

1. **Ensayo (rehearsal) con copia, cluster todavía sin tráfico:**
   - Con Container Apps **apagado un instante o en ventana sin escritura** (o aceptando que la copia de ensayo es descartable): copiar `app.sqlite` + `app.sqlite-wal` + `app.sqlite-shm` del share `ondata` a scratch local (`az storage file download`, credencial solo en memoria, nunca impresa — mismo método que AGEN-31).
   - En local: abrir la copia con `sqlite3`, `PRAGMA wal_checkpoint(TRUNCATE)` para consolidar el WAL en el archivo principal, `PRAGMA integrity_check` → debe decir `ok`.
   - Registrar: `sha256` del archivo consolidado, y row counts de todas las tablas (`users`, `sessions`, `wallets`, `confirmations`, `executions`, `paper_ledger`, `mcp_tokens`, …) como manifiesto de la copia.
   - Cargar esa copia en el PVC vía un pod utilitario (`kubectl cp` o Job efímero que monte el PVC), levantar Onda en AKS sobre la copia y correr el smoke completo (§6). Esta DB de ensayo se descarta.
2. **Cutover real (ventana corta, Container Apps sigue siendo el plan B):**
   - Avisar la ventana; desactivar la revisión de Container Apps (corta escrituras; es el mecanismo ya probado del runbook).
   - Repetir copia + checkpoint + `integrity_check`. Comparar row counts contra el manifiesto del ensayo (deben ser ≥, y cualquier diferencia se explica por actividad entre ensayo y cutover).
   - Subir el archivo final al PVC, verificar `sha256` **después** de la copia (el hash se calcula sobre el archivo ya montado, no sobre el local).
   - Levantar el pod de AKS, smoke (§6). Si algo falla → rollback (§6) y la DB de Container Apps nunca fue modificada: el share quedó intacto porque todo fue lectura.
3. **Reglas que no se negocian:** nunca se copia solo `app.sqlite` sin sus sidecars en caliente (AGEN-31: el principal no es el estado completo); nunca se borra ni se siembra la DB de prod como "fix"; la copia descartada del ensayo y cualquier scratch con datos se borra al terminar (precedente AGEN-31).

## 5. Secrets, config e imagen

### Secrets

- `SESSION_SECRET`: se crea **fuera de git** con `kubectl create secret generic onda-secrets --from-literal=SESSION_SECRET=<valor>` (mismo valor que hoy en Container Apps — así las sesiones vivas no mueren en el cutover —, leído en el momento desde el secreto de Container Apps y nunca impreso ni persistido en archivos). El manifest solo lo *referencia* (`secretKeyRef`). En los YAML draft el valor es el placeholder `REPLACE_OUT_OF_BAND`.
- Todo lo demás no es secreto: va en un `ConfigMap` con paridad exacta del template vivo, incluyendo el cambio de `PUBLIC_BASE_URL` al FQDN de AKS (§2.3) y `SQLITE_JOURNAL_MODE` heredado (sobre disco local la DB existente conserva su modo; el valor solo aplicaría a una DB nueva).
- MCP tokens y sesiones viven en la DB, no en env: migran solos con el archivo.

### Imagen y ACR

- Reuso del ACR `ondaagenttrading` (Basic) y de la disciplina actual: imagen `ondaagenttrading.azurecr.io/onda:v0.6.0` hoy; los próximos deploys siguen el `VERSION` del repo (`onda:vX.Y.Z`, mismo tag que produce `az acr build` hoy). Nada de `latest` en el Deployment: el tag es el que dice `VERSION`.
- Pull: managed identity de la kubelet con rol `AcrPull` sobre el ACR (o `--attach-acr` al crear el cluster, a verificar en ejecución). Sin `imagePullSecrets` con credenciales en el cluster.
- Recursos del contenedor: requests `500m/1Gi`, limits `1/1Gi` (§2.2). En el nodo B2s eso deja ~3 GiB para sistema + ingress, holgado.

## 6. Plan de ejecución (fase siguiente, solo con el OK de Dino al costo)

Estimaciones de reloj de pared de un operador atento; no incluyen esperas de aprobación.

| # | Paso | Tiempo est. | Qué puede salir mal |
|---|---|---|---|
| 1 | Crear RG `rg-agent-trading-aks` + AKS Free, 1×B2s, K8s 1.33, attach ACR | 15–25 min (la creación del cluster es lo lento) | Cuota de B-series en la suscripción; versión 1.33 corrida por AKS entre diseño y ejecución (se toma la más nueva soportada). |
| 2 | `kubectl` context, instalar ingress-nginx + cert-manager (Helm), esperar IP del LB, poner el DNS label | 15–20 min | El DNS label elegido está ocupado (se ajusta el FQDN y `PUBLIC_BASE_URL`). |
| 3 | Aplicar manifests de `deploy/k8s/` (namespace, ConfigMap, PVC, Deployment, Service, Ingress); crear el Secret fuera de banda | 10 min | `AcrPull` no propagado todavía (ImagePullBackOff unos minutos: se espera, no se improvisa). |
| 4 | Ensayo con copia de la DB (§4.1) + smoke: `GET /health` (versión/flags), register+login throwaway, quote Jupiter, SSE 35 s (ready + quotes + heartbeat, 401 sin cookie), MCP probe (401 sin token, `tools/list` = 7 con token, revocar → 401) — el mismo set probado en AGEN-41 | 30–45 min | SSE cortado al minuto si faltan los timeouts (§2.3); `signingUrl` con el FQDN viejo si `PUBLIC_BASE_URL` quedó mal. |
| 5 | Certificado Let's Encrypt emitido y cadena HTTPS verde en el FQDN nuevo | 5–15 min (propagación) | HTTP-01 no llega porque el Ingress todavía no rutéa; rate-limit de LE si se reintenta en loop (no hacerlo). |
| 6 | Cutover (§4.2): copia fría final verificada (sha256 + row counts), pod arriba, smoke completo otra vez | 30–45 min | Row counts no cierran → no se sigue; se reactiva Container Apps y se investiga con prod sana. |
| 7 | Dejar Container Apps **intacto y apagado-solo-en-revisiones** como rollback; entregarle a Dino la URL nueva para su OK visual/funcional | 10 min | — |
| Total | | **≈ 2–3 h** | |

**Rollback (criterios y mecanismo):** se vuelve atrás si el smoke de cutover falla, si los row counts no reconcilian, o si Dino no aprueba lo que ve. Mecanismo: reactivar la revisión `onda--0000007` de Container Apps (la DB del share nunca se modificó — todo el trabajo fue de lectura — así que prod vuelve exactamente como estaba) y borrar el RG de AKS si Dino lo ordena. Container Apps **no se toca en su template, imagen ni env en ningún paso**: el rollback es una reactivación, no una reconstrucción.

**Top 3 riesgos (honestos):**

1. **SSE a través del ingress.** Es la diferencia funcional real entre plataformas: Container Apps no nos cortaba el stream; ingress-nginx sí (60 s default). Mitigado en el manifest (timeouts 3600 + buffering off) y con smoke de 35 s mínimo — idealmente uno de 90 s en el ensayo para cruzar el umbral viejo.
2. **La copia de la DB.** El riesgo no es técnico sino de procedimiento: copiar el principal sin el WAL, o copiar con escrituras en vuelo, produce una DB que "abre" pero le faltan las últimas filas (AGEN-31 probó que el estado completo incluye sidecars). Mitigación: checkpoint + `integrity_check` + row counts + sha256 post-copia, y ensayo completo antes del cutover.
3. **Pod stateful en un solo nodo.** Si el nodo B2s muere o Azure lo mueve, hay downtime de minutos mientras el pod reprograma y el disco RWO se desatacha/reatacha (el disco sobrevive; los datos no se pierden — esa es la ventaja sobre el crash-loop de SMB: acá el lock es local y muere con el pod). Para una demo es el trato correcto; para usuarios reales sería el argumento de la opción C.

## 7. Costos

Precios retail USD, eastus, consultados el **2026-11-28** vía Azure Retail Prices API (`prices.azure.com`) y páginas oficiales de precios de Microsoft, salvo donde se marca estimación. La API retail devolvió `429` intermitente; los ítems marcados «doc» salen de la página oficial del servicio en la misma fecha. Ninguna cifra es de calculadora con descuentos de suscripción: son list price, que es el número honesto para aprobar.

### 7.1 Stack actual (lo que se deja de pagar solo si algún día se desarma — hoy NO)

| Ítem | USD/mes | Fuente |
|---|---|---|
| Container Apps Consumption 0.5 vCPU/1 GiB, 1 réplica 24/7 | ≈ 15–25 | Estimado documentado en `deploy/README.md` (la API retail no devolvió métricas de Container Apps con los filtros usados; no se inventó un unitario). |
| ACR Basic (`0.1666/día` = $5.00) | 5.00 | Retail Prices API, verificado 2026-11-28 |
| Azure Files 5 GiB ($0.06/GB + operaciones) | ≈ 1 | Retail Prices API, verificado 2026-11-28 |
| Log Analytics | ≈ 0–2 | Estimado documentado; ingestión mínima |
| **Total actual** | **≈ 20–30** | Coincide con lo documentado en el repo. |

### 7.2 Opción recomendada — AKS Free + B2s + NGINX + Managed Disk RWO

| Ítem | USD/mes | Fuente |
|---|---|---|
| AKS management, tier Free | 0 | Página oficial AKS (Free = sin cargo de management) |
| Nodo `Standard_B2s` Linux 24/7 ($0.0416/h × 730) | 30.37 | Retail Prices API, verificado 2026-11-28 |
| Disco OS del nodo (E10 Standard SSD 128 GiB, default típico de AKS) | ≈ 9.60 | Doc pública de Managed Disks / análisis East US (estimación: el tamaño default puede variar, P10 Premium sería $17.92) |
| PVC datos 32 GiB (Standard SSD E4 aprox.; Premium P4 si se prefiere) | ≈ 3–7 | Estimación por tabla de Managed Disks (E10 128 GiB = $9.60 doc; P10 128 GiB = $17.92 doc) |
| Load Balancer Standard (reglas base del Service del ingress) + IP pública Standard ($0.005/h ≈ $3.65) | ≈ 18–22 | Doc pública de precios de LB/IP (estimación: depende de reglas y GB procesados; tráfico demo ≈ mínimo) |
| ACR Basic (se reusa el actual) | 5.00 | Retail Prices API, verificado |
| Azure Files (queda, como respaldo/rollback durante la convivencia) | ≈ 1 | Retail Prices API, verificado |
| Log Analytics / Container Insights mínimo | ≈ 0–5 | Estimación; se puede arrancar con logs básicos de `kubectl` y $0 |
| DNS (label `cloudapp.azure.com`) | 0 | Incluido en la IP pública |
| **Total AKS recomendado** | **≈ 67–79** | |
| **Delta vs actual** | **≈ +USD 40–50/mes** | Contra el punto medio (~$25) del stack actual. |

Comparación de alternativas de la misma tabla:

| Variante | Total/mes aprox. | Lectura |
|---|---|---|
| **A (recomendada): AKS Free + B2s + NGINX + Managed Disk** | **≈ USD 67–79** | La más barata que es Kubernetes de verdad. Sin SLA. |
| B: igual que A pero nodo `Standard_B2ms` (2 vCPU/8 GiB, $0.0832/h = $60.74) | ≈ USD 97–109 | Solo si el B2s queda chico en el ensayo; no hace falta decidirlo hoy. |
| C: A + Application Gateway Standard_v2 como ingress (`$0.246/h` ≈ $180 solo el gateway) | ≈ USD 245+ | Rechazada para demo: el gateway cuesta ~3× el resto del stack junto. Revisitar solo si Dino pide WAF/dominio propio gestionado. |
| D: A + PostgreSQL Flexible B1ms (opción C de storage, $0.017/h + storage ≈ $16) | ≈ USD 83–95 + reescritura de código | No es una variante de esta etapa: exige reescribir la capa de datos. Queda como etapa futura si se necesita multi-réplica/HA. |
| AKS tier Standard (SLA) sobre la variante A (+$0.10/h) | + USD 73 sobre cualquiera | Solo si la demo pasa a tener usuarios a los que les debamos un SLA. |

Nota de honestidad de precios: los unitarios de VM, ACR y Files salieron de la Retail Prices API en vivo hoy; disco OS, PVC chico, LB e IP son estimaciones ancladas en páginas oficiales (la API devolvió `429`/sin resultados para esos filtros). Antes de crear el cluster, la fase de ejecución debe re-cotizar en la Azure Pricing Calculator con la suscripción real y mostrarle ese número a Dino si difiere >10% de esta tabla.

## 8. Qué pasa con el stack actual

Nada, hasta que Dino diga lo contrario. `rg-agent-trading-preview` queda tal cual durante el diseño, la ejecución y la convivencia: misma revisión `onda--0000007`, misma DB, mismo FQDN. Si AKS se aprueba y el cutover sale bien, Dino decide después (y por separado) si Container Apps se apaga, se borra o queda de rollback permanente por ~$25/mes. El teardown de cualquiera de los dos stacks es una decisión suya, no un paso de este plan.

## 9. Decisión que se pide

1. **Costo:** aprobar ~USD 65–70/mes (delta ≈ +USD 40/mes) para la opción A, o pedir otra variante de la tabla.
2. Con ese OK, la fase siguiente ejecuta el plan de §6 (crear cluster, rehearsal con copia, cutover con rollback listo) y le muestra a Dino la app en el FQDN de AKS antes de tocar Container Apps.

---

*Fase de diseño DIN-34. Sin recursos creados. Los manifests draft viven en esta carpeta (`deploy/k8s/`) y no contienen secretos.*
