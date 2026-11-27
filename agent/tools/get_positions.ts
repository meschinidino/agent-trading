import { defineTool } from "eve/tools";
import { z } from "zod";
export default defineTool({
  description: "Posiciones paper y reales, cada una con su mode.",
  inputSchema: z.object({}),
  async execute() { const r = await fetch((process.env.AGENT_BACKEND_URL || "http://localhost:3001") + "/api/v1/portfolio", { headers: { cookie: process.env.AGENT_SESSION_COOKIE || "" } }); const j: any = await r.json(); return j.positions || []; },
});
