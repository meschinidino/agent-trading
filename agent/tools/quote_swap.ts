import { defineTool } from "eve/tools";
import { z } from "zod";
// Cotiza contra Jupiter vía el backend (que persiste la quote). Nunca ejecuta. Slippage: política del backend, no parámetro.
export default defineTool({
  description: "Pide una quote real de Jupiter al backend y la persiste server-side.",
  inputSchema: z.object({ symbol: z.enum(["SPYx", "AAPLx", "NVDAx"]), amountUsd: z.number().positive(), side: z.enum(["buy", "sell"]).default("buy") }),
  async execute(input: any) { const r = await fetch((process.env.AGENT_BACKEND_URL || "http://localhost:3001") + "/api/v1/quotes", { method: "POST", headers: { "content-type": "application/json", cookie: process.env.AGENT_SESSION_COOKIE || "", "x-csrf-token": process.env.AGENT_CSRF_TOKEN || "" }, body: JSON.stringify(input) }); return r.json(); },
});
