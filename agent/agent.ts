import { defineAgent } from "eve";
// Eve 1.5.0 (pin exacto). AGENT_MODE=parser es el default del MVP: este agente corre solo con AGENT_MODE=eve y una key de modelo.
export default defineAgent({ model: process.env.EVE_MODEL || "openai/gpt-5.4-mini" });
