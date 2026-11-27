import { buildApp } from "./app.js";
import { config } from "./config.js";
const { app, bootCheck } = await buildApp();
await bootCheck();
console.log("Registry boot check OK (Jupiter verified, fail-closed)");
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`API v${config.serverVersion} en :${config.port} mode=${config.executionMode} executionEnabled=${config.executionEnabled} agentMode=${config.agentMode} mcpEnabled=${config.mcpEnabled}`);
