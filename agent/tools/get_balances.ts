import { defineTool } from "eve/tools";
import { z } from "zod";
// Tool fina (spec 03): lee el backend propio. Sin efectos. AGENT_BACKEND_URL apunta a apps/api.
const base = () => process.env.AGENT_BACKEND_URL || "http://localhost:3001";
export default defineTool({
  description: "Balances paper + reales on-chain del usuario (separados por mode).",
  inputSchema: z.object({}),
  async execute() { const r = await fetch(base() + "/api/v1/portfolio", { headers: { cookie: process.env.AGENT_SESSION_COOKIE || "" } }); return r.json(); },
});
