import { defineTool } from "eve/tools";
import { z } from "zod";
// Crea la confirmation contra una quote persistida. NO ejecuta: la ejecución ocurre en el backend tras el confirm del usuario (spec 04).
export default defineTool({
  description: "Crea la confirmation del gate para una quote. Devuelve pending; nunca ejecuta un swap.",
  inputSchema: z.object({ quoteId: z.string(), rawIntent: z.string(), symbol: z.enum(["SPYx", "AAPLx", "NVDAx"]), side: z.enum(["buy", "sell"]).default("buy") }),
  async execute() { throw new Error("En el MVP el chat crea la confirmation server-side vía POST /api/v1/chat/message (AGENT_MODE=parser). Esta tool queda como contrato Eve para AGENT_MODE=eve."); },
});
