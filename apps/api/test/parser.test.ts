import { describe, it, expect } from "vitest";
import { parseIntent, parseAmountEsAr } from "../src/parser.js";
describe("parser es-AR (fixtures locales)", () => {
  it("1.000 = mil", () => { expect(parseAmountEsAr("Invertí 1.000 USD en Apple")).toBe(1000); });
  it("10,50 coma decimal", () => { expect(parseAmountEsAr("compra 10,50 de Apple")).toBe(10.5); });
  it("rechaza 3 decimales", () => { expect(() => parseAmountEsAr("compra 10,505")).toThrow(); });
  it("alias S&P 500", () => { const i = parseIntent("Inverti 100 USD en el S&P 500"); expect(i).toMatchObject({ kind: "buy", symbol: "SPYx", amountUsd: 100 }); });
  it("alias Apple y Nvidia, venta", () => { expect(parseIntent("vende 10 USD de Nvidia")).toMatchObject({ kind: "sell", symbol: "NVDAx" }); expect(parseIntent("compra 50 de Apple")).toMatchObject({ symbol: "AAPLx", amountUsd: 50 }); });
  it("sin monto pide aclaración", () => { expect(parseIntent("Invertí en Apple").kind).toBe("clarify"); });
  it("Tesla fuera de registry", () => { expect(parseIntent("Invertí 100 USD en Tesla").kind).toBe("out_of_registry"); });
  it("saldo no crea orden", () => { expect(parseIntent("cuanto tengo").kind).toBe("balance"); });
});
