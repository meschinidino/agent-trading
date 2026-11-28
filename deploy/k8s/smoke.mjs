import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const [kubeconfig] = process.argv.slice(2);
assert(kubeconfig, "Uso: node deploy/k8s/smoke.mjs /ruta/al/kubeconfig-dedicado");
const base = "http://127.0.0.1:18080";
const args = ["--kubeconfig", kubeconfig, "-n", "onda"];
function k(argv, input) {
  const r = spawnSync("kubectl", [...args, ...argv], { input, timeout: 155_000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error("kubectl " + argv[0] + " falló: " + (r.error?.message ?? r.stderr.toString().trim()));
  return r.stdout;
}
const json = (argv) => JSON.parse(k([...argv, "-o", "json"]));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cfg = json(["config", "view", "--minify"]);
assert.match(cfg["current-context"], /^kind-onda-/);
assert.equal(cfg.clusters.length, 1);
assert.equal(new URL(cfg.clusters[0].cluster.server).hostname, "127.0.0.1");
const nodes = json(["get", "nodes"]).items;
assert.equal(nodes.length, 1);
assert.match(nodes[0].spec.providerID, /^kind:\/\//);

function pods() { return json(["get", "pods", "-l", "app=onda"]).items; }
function oneWriter(claim) {
  k(["rollout", "status", "deployment/onda", "--timeout=140s"]);
  const deployment = json(["get", "deployment/onda"]);
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  const running = pods();
  assert.equal(running.length, 1);
  const [pod] = running;
  assert(!pod.metadata.deletionTimestamp);
  assert.equal(pod.spec.containers[0].image, "onda:kind");
  assert.equal(pod.spec.containers[0].imagePullPolicy, "Never");
  assert.equal(pod.spec.volumes.find((v) => v.name === "data").persistentVolumeClaim.claimName, claim);
  return pod;
}
function stopWriter(pod) {
  k(["scale", "deployment/onda", "--replicas=0"]);
  k(["wait", "--for=delete", "pod/" + pod.metadata.name, "--timeout=90s"]);
  assert.equal(pods().length, 0);
}

let forward;
async function openForward() {
  forward = spawn("kubectl", [...args, "port-forward", "--address", "127.0.0.1", "svc/onda", "18080:80"],
    { stdio: ["ignore", "pipe", "inherit"] });
  const child = forward;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("port-forward no abrió en 10 s")), 10_000);
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("port-forward cerró")); });
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Forwarding from 127.0.0.1:18080")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
async function closeForward() {
  if (!forward || forward.exitCode !== null || forward.signalCode !== null) return;
  const child = forward;
  await new Promise((resolve) => { child.once("close", resolve); child.kill(); });
}
let cookie, csrf;
async function api(path, { method = "GET", body, status = 200, authenticated = true } = {}) {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(15_000),
    headers: { ...(body && { "content-type": "application/json" }), ...(authenticated && cookie && { cookie, "x-csrf-token": csrf }) },
    body: body && JSON.stringify(body),
  });
  assert.equal(response.status, status, method + " " + path);
  return response;
}
async function health() {
  const health = await (await api("/health")).json();
  const version = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();
  assert(health.ok && health.sseEnabled && health.mcpEnabled && !health.executionEnabled);
  assert.equal(health.version, version);
  assert.equal(health.agentMode, "parser");
  assert.match(await (await api("/")).text(), /<title>[^<]*Onda/i);
}
async function stream(seconds, minHeartbeats) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), (seconds + 12) * 1000);
  const start = Date.now();
  const frames = new Set();
  let ready = false, quotes = false, buffer = "";
  try {
    const response = await fetch(base + "/api/v1/events", { headers: { cookie }, signal: stop.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      const complete = buffer.split("\n\n");
      buffer = complete.pop();
      for (const frame of complete) {
        ready ||= frame.startsWith("event: ready\n");
        quotes ||= frame.startsWith("event: quotes\n");
        if (frame.startsWith(": heartbeat ")) frames.add(frame);
      }
      if (ready && quotes && frames.size >= minHeartbeats && Date.now() - start >= seconds * 1000) return frames.size;
    }
    throw new Error("SSE cerró antes de satisfacer la prueba");
  } finally { stop.abort(); clearTimeout(timer); }
}

async function mcp(token, method, params, status = 200) {
  const res = await fetch(base + "/mcp", {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26", ...(token && { Authorization: "Bearer " + token }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(method !== "notifications/initialized" && { id: 1 }), method, params }),
  });
  assert.equal(res.status, status, "MCP " + method);
  if (status !== 200) { await res.body?.cancel(); return; }
  const data = await res.json();
  assert(data.result && !data.error && !data.result.isError, "MCP " + method);
  return data.result;
}

const checkSql = (path) =>
  "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(" + JSON.stringify(path) + ",{readOnly:true});" +
  "console.log(JSON.stringify({integrity:db.prepare('PRAGMA integrity_check').all().map(r=>r.integrity_check)," +
  "counts:Object.fromEntries(['users','wallets','paper_ledger','mcp_tokens','executions'].map(t=>[t,db.prepare('SELECT COUNT(*) AS n FROM '+t).get().n]))," +
  "ledger:db.prepare('SELECT kind,amount_atomic FROM paper_ledger ORDER BY rowid').all()})); db.close();";
const execNode = (target, code, input) => k(["exec", ...(input ? ["-i"] : []), target, "--", "node", "-e", code], input);
const dbPath = "/data/app.sqlite";
const counts = (target, path = dbPath) => JSON.parse(execNode(target, checkSql(path)));
const empty = { users: 0, wallets: 0, paper_ledger: 0, mcp_tokens: 0, executions: 0 };

try {
  const original = oneWriter("onda-data");
  const source = "pod/" + original.metadata.name;
  await openForward();
  await health();
  assert.deepEqual(counts(source), { integrity: ["ok"], counts: empty, ledger: [] });
  await api("/api/v1/events", { authenticated: false, status: 401 });
  const credentials = { email: "kind-smoke@example.invalid", password: randomBytes(24).toString("hex") };
  await api("/api/v1/auth/register", { method: "POST", body: credentials, status: 201 });
  const login = await api("/api/v1/auth/login", { method: "POST", body: credentials });
  cookie = login.headers.get("set-cookie").split(";")[0];
  csrf = (await login.json()).csrfToken;
  const wallet = await (await api("/api/v1/wallets", { method: "POST", body: {}, status: 201 })).json();
  assert.equal(wallet.mode, "paper");
  const deposit = async (amountUsd, expected) => {
    const path = "/api/v1/wallets/" + wallet.id + "/deposit";
    const result = await (await api(path, { method: "POST", body: { amountUsd } })).json();
    assert.deepEqual(result, { paperUsdc: expected, mode: "paper" });
  };
  await deposit(42, 42);

  await mcp(null, "initialize", {}, 401);
  const { secret, id } = await (await api("/api/v1/settings/mcp-tokens", { method: "POST", status: 201,
    body: { name: "kind-smoke", scopes: ["read:portfolio"] } })).json();
  const init = await mcp(secret, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "kind-smoke", version: "1" } });
  assert(init.serverInfo?.name);
  await mcp(secret, "notifications/initialized", {}, 202);
  const { tools } = await mcp(secret, "tools/list", {});
  assert.equal(tools.length, 7);
  assert(!tools.some(({ name }) => /execute|sign|^onda_confirm/.test(name)));
  const result = await mcp(secret, "tools/call", { name: "onda_get_limits", arguments: {} });
  const limits = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.equal(limits.mode, "paper");
  assert.equal(limits.executionEnabled, false);
  await api("/api/v1/settings/mcp-tokens/" + id, { method: "DELETE" });
  await mcp(secret, "tools/list", {}, 401);
  console.log("Fresh health y DB vacía; MCP Streamable HTTP: init, 7 tools, límites paper y 401 tras revocar");

  const heartbeats = await stream(90, 4);
  await stream(0, 0);
  console.log("SSE: 401 anónimo, 90 s autenticados con " + heartbeats + " heartbeats, ready/quotes al reconectar");

  const actual = counts(source);
  assert.deepEqual(actual, { integrity: ["ok"], counts: { ...empty, users: 1, wallets: 1, paper_ledger: 1, mcp_tokens: 1 },
    ledger: [{ kind: "paper_faucet", amount_atomic: "42000000" }] });
  await closeForward();
  stopWriter(original);
  k(["scale", "deployment/onda", "--replicas=1"]);
  const replacement = oneWriter("onda-data");
  assert.notEqual(replacement.metadata.uid, original.metadata.uid);
  const replacementTarget = "pod/" + replacement.metadata.name;
  assert.deepEqual(counts(replacementTarget), actual);
  await openForward();
  await health();
  assert.equal((await (await api("/api/v1/wallets")).json()).items[0].id, wallet.id);
  console.log("Recreación: cambió UID con el mismo PVC; sesión, wallet, ledger e integridad persisten");

  const snapshotPath = "/tmp/onda-kind-backup.sqlite";
  const bytes = execNode(replacementTarget,
    "const {DatabaseSync,backup}=require('node:sqlite');const fs=require('node:fs');" +
    "const source=new DatabaseSync('/data/app.sqlite',{readOnly:true});" +
    "backup(source,'" + snapshotPath + "').then(()=>{source.close();process.stdout.write(fs.readFileSync('" + snapshotPath + "'));})");
  assert.deepEqual(counts(replacementTarget, snapshotPath), actual);
  await deposit(7, 49);
  await closeForward();
  stopWriter(replacement);

  const kind = "PersistentVolumeClaim";
  const originalClaim = json(["get", "pvc/onda-data"]);
  k(["create", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind, metadata: { name: "onda-data-restored" }, spec: {
    accessModes: originalClaim.spec.accessModes, storageClassName: originalClaim.spec.storageClassName, resources: originalClaim.spec.resources,
  } }));
  k(["create", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "Pod", metadata: { name: "onda-restore" }, spec: {
    restartPolicy: "Never", containers: [{ name: "restore", image: "onda:kind", imagePullPolicy: "Never",
      command: ["sleep", "600"], volumeMounts: [{ name: "data", mountPath: "/data" }] }],
    volumes: [{ name: "data", persistentVolumeClaim: { claimName: "onda-data-restored" } }],
  } }));
  const helper = "pod/onda-restore";
  k(["wait", "--for=condition=Ready", helper, "--timeout=90s"]);
  const received = execNode(helper, "const fs=require('node:fs');const b=fs.readFileSync(0);fs.writeFileSync('/data/app.sqlite',b,{flag:'wx',mode:0o600});" +
    "console.log(require('node:crypto').createHash('sha256').update(fs.readFileSync('/data/app.sqlite')).digest('hex'));", bytes);
  assert.equal(received.toString().trim(), hash(bytes));
  assert.deepEqual(counts(helper), actual);
  k(["delete", helper, "--wait=true", "--timeout=90s"]);
  assert.equal(pods().length, 0);
  k(["patch", "deployment/onda", "--type=strategic", "-p", JSON.stringify({ spec: { template: { spec: {
    volumes: [{ name: "data", persistentVolumeClaim: { claimName: "onda-data-restored" } }],
  } } } })]);
  k(["scale", "deployment/onda", "--replicas=1"]);
  const restored = oneWriter("onda-data-restored");
  assert.notEqual(restored.metadata.uid, replacement.metadata.uid);
  assert.deepEqual(counts("pod/" + restored.metadata.name), actual);
  await openForward();
  await health();
  await deposit(1, 43);
  console.log("Restore: otro PVC, SHA-256 y PRAGMA integrity_check OK; mismos conteos/filas y escritura paper sobre el saldo original");
} finally { await closeForward(); }
