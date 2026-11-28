import { createHash, randomBytes } from "node:crypto";
import { appendAudit, id, nowIso, type DB } from "./db.js";
import { config } from "./config.js";
import { err } from "./services.js";
import { hub } from "./events.js";

export const MCP_SCOPES = ["read:portfolio", "quote", "propose"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export type McpTokenRow = { id: string; user_id: string; name: string; token_hash: string; scopes: string; created_at: string; expires_at: string; last_used_at: string | null; revoked_at: string | null };

export function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
export function parseScopes(raw: unknown): McpScope[] {
  if (!Array.isArray(raw) || raw.length === 0) throw err("VALIDATION", "Elegí al menos un scope para el token", 422);
  const scopes = [...new Set(raw.map((s) => String(s)))];
  for (const s of scopes) if (!(MCP_SCOPES as readonly string[]).includes(s)) throw err("VALIDATION", `Scope no permitido: ${s}. No existe scope execute ni confirm.`, 422);
  return scopes as McpScope[];
}
export function tokenScopes(row: { scopes: string }): McpScope[] { try { return JSON.parse(row.scopes); } catch { return []; } }
export function publicToken(row: McpTokenRow) {
  return { id: row.id, name: row.name, scopes: tokenScopes(row), createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at };
}
export function issueToken(db: DB, userId: string, name: string, rawScopes: unknown) {
  const scopes = parseScopes(rawScopes);
  const cleanName = String(name || "").trim().slice(0, 80);
  if (!cleanName) throw err("VALIDATION", "El token necesita un nombre (ej: ChatGPT, Cursor laptop)", 422);
  const secret = "onda_mcp_" + randomBytes(32).toString("base64url");
  const row: McpTokenRow = { id: id(), user_id: userId, name: cleanName, token_hash: hashToken(secret), scopes: JSON.stringify(scopes), created_at: nowIso(), expires_at: new Date(Date.now() + config.mcpTokenTtlDays * 86400000).toISOString(), last_used_at: null, revoked_at: null };
  db.prepare("INSERT INTO mcp_tokens VALUES(?,?,?,?,?,?,?,?,?)").run(row.id, row.user_id, row.name, row.token_hash, row.scopes, row.created_at, row.expires_at, row.last_used_at, row.revoked_at);
  appendAudit(db, null, userId, "mcp_token_created", { tokenId: row.id, name: row.name, scopes, expiresAt: row.expires_at });
  return { token: publicToken(row), secret };
}
export function listTokens(db: DB, userId: string) {
  const rows = db.prepare("SELECT * FROM mcp_tokens WHERE user_id=? ORDER BY created_at DESC").all(userId) as McpTokenRow[];
  return rows.map(publicToken);
}

export function expirePendingForToken(db: DB, tokenId: string, userId: string, reason: "revoked" | "expired") {
  const rows = db.prepare("SELECT id FROM confirmations WHERE user_id=? AND status IN ('proposed','pending_confirmation')").all(userId) as any[];
  let expired = 0;
  for (const r of rows) {
    let via: any = null; try { via = JSON.parse(String((db.prepare("SELECT proposed_via FROM confirmations WHERE id=?").get(r.id) as any)?.proposed_via || "null")); } catch {}
    if (via?.tokenId !== tokenId) continue;
    db.prepare("UPDATE confirmations SET status='expired' WHERE id=?").run(r.id);
    appendAudit(db, r.id, userId, "expired", { reason: `mcp_token_${reason}`, tokenId, decidedBy: userId });
    hub.confirmation(userId, db.prepare("SELECT * FROM confirmations WHERE id=?").get(r.id));
    expired++;
  }
  return expired;
}

export function revokeToken(db: DB, userId: string, tokenId: string) {
  const row = db.prepare("SELECT * FROM mcp_tokens WHERE id=?").get(tokenId) as McpTokenRow | undefined;
  if (!row || row.user_id !== userId) throw err("NOT_FOUND", "Token no encontrado", 404);
  if (!row.revoked_at) {
    db.prepare("UPDATE mcp_tokens SET revoked_at=? WHERE id=?").run(nowIso(), tokenId);
    appendAudit(db, null, userId, "mcp_token_revoked", { tokenId, decidedBy: userId });
  }
  const expiredConfirmations = expirePendingForToken(db, tokenId, userId, "revoked");
  return { ...publicToken(db.prepare("SELECT * FROM mcp_tokens WHERE id=?").get(tokenId) as McpTokenRow), expiredConfirmations };
}

export type TokenAuth = { tokenId: string; userId: string; scopes: McpScope[]; name: string };
export function authenticateToken(db: DB, authorization: string | undefined): TokenAuth {
  const token = String(authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw err("UNAUTHORIZED", "Falta el token de agente (Authorization: Bearer)", 401);
  const row = db.prepare("SELECT * FROM mcp_tokens WHERE token_hash=?").get(hashToken(token)) as McpTokenRow | undefined;
  if (!row || row.revoked_at) throw err("UNAUTHORIZED", "Token inválido o revocado", 401);
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    expirePendingForToken(db, row.id, row.user_id, "expired");
    throw err("UNAUTHORIZED", "Token vencido (90 días). Creá uno nuevo en Settings de Onda.", 401);
  }
  db.prepare("UPDATE mcp_tokens SET last_used_at=? WHERE id=?").run(nowIso(), row.id);
  return { tokenId: row.id, userId: row.user_id, scopes: tokenScopes(row), name: row.name };
}
export function requireScope(auth: TokenAuth, scope: McpScope) {
  if (!auth.scopes.includes(scope)) throw err("FORBIDDEN_SCOPE", `Este token no tiene el scope ${scope}`, 403);
}
