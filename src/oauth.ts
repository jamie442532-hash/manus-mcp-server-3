import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

/**
 * Minimal OAuth 2.0 authorization server, just enough to satisfy Claude's
 * "custom connector" flow for a single-user personal MCP server:
 *
 *  - Dynamic Client Registration (RFC 7591)  -> POST /register
 *  - Authorization endpoint (with login gate) -> GET  /authorize
 *  - Token endpoint (auth code + PKCE, refresh) -> POST /token
 *  - Metadata discovery                        -> GET  /.well-known/oauth-authorization-server
 *
 * State is kept in memory. That's fine for a single Railway instance used
 * by one person; tokens are lost on redeploy/restart (you'll just reconnect
 * the connector in Claude if that happens).
 *
 * Auth gate: since there's no real user database, "login" is just typing
 * the ADMIN_PASSWORD env var into a plain form. This exists purely so a
 * stranger who finds your /authorize URL can't silently mint themselves a
 * token — not a substitute for a real identity provider.
 */

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.warn(
    "[oauth] WARNING: ADMIN_PASSWORD is not set. Set it in Railway variables, or nobody (including you) can complete the login gate."
  );
}

interface Client {
  clientId: string;
  redirectUris: string[];
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

interface AccessTokenRecord {
  clientId: string;
  expiresAt: number;
}

const clients = new Map<string, Client>();
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, AccessTokenRecord>();
const refreshTokens = new Map<string, { clientId: string }>();

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === "plain") {
    return verifier === challenge;
  }
  if (method === "S256") {
    const hash = base64url(createHash("sha256").update(verifier).digest());
    return timingSafeCompareStr(hash, challenge);
  }
  return false;
}

function timingSafeCompareStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function getBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] ?? req.protocol;
  return `${proto}://${req.get("host")}`;
}

// ---- Discovery metadata ----
export function handleMetadata(req: Request, res: Response) {
  const base = getBaseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  });
}

// ---- Dynamic client registration ----
export function handleRegister(req: Request, res: Response) {
  const body = req.body ?? {};
  const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];

  if (redirectUris.length === 0) {
    res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" });
    return;
  }

  const clientId = randomUUID();
  clients.set(clientId, { clientId, redirectUris });

  res.status(201).json({
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

// ---- Authorization endpoint ----
export function handleAuthorizeGet(req: Request, res: Response) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query as Record<
    string,
    string | undefined
  >;

  const client = client_id ? clients.get(client_id) : undefined;
  if (!client || !redirect_uri || !client.redirectUris.includes(redirect_uri)) {
    res.status(400).send("Invalid client_id or redirect_uri.");
    return;
  }

  // Simple HTML login gate.
  res.set("Content-Type", "text/html").send(`
    <html>
      <body style="font-family: sans-serif; max-width: 400px; margin: 80px auto;">
        <h2>Authorize Claude</h2>
        <p>Enter your admin password to allow this connector to access your Manus MCP server.</p>
        <form method="POST" action="/authorize">
          <input type="hidden" name="client_id" value="${escapeHtml(client_id!)}" />
          <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}" />
          <input type="hidden" name="state" value="${escapeHtml(state ?? "")}" />
          <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge ?? "")}" />
          <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method ?? "")}" />
          <input type="password" name="password" placeholder="Admin password" style="width:100%;padding:8px;margin:12px 0;" />
          <button type="submit" style="padding:8px 16px;">Authorize</button>
        </form>
      </body>
    </html>
  `);
}

export function handleAuthorizePost(req: Request, res: Response) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, password } = req.body ?? {};

  const client = client_id ? clients.get(client_id) : undefined;
  if (!client || !redirect_uri || !client.redirectUris.includes(redirect_uri)) {
    res.status(400).send("Invalid client_id or redirect_uri.");
    return;
  }

  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    res.status(401).send("Incorrect password. Go back and try again.");
    return;
  }

  const code = base64url(randomBytes(32));
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge || undefined,
    codeChallengeMethod: code_challenge_method || undefined,
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  res.redirect(redirectUrl.toString());
}

// ---- Token endpoint ----
export function handleToken(req: Request, res: Response) {
  const body = req.body ?? {};
  const grantType = body.grant_type;

  if (grantType === "authorization_code") {
    const { code, redirect_uri, client_id, code_verifier } = body;
    const record = code ? authCodes.get(code) : undefined;

    if (!record || record.expiresAt < Date.now()) {
      res.status(400).json({ error: "invalid_grant", error_description: "Code invalid or expired" });
      return;
    }
    if (record.clientId !== client_id || record.redirectUri !== redirect_uri) {
      res.status(400).json({ error: "invalid_grant", error_description: "Client/redirect mismatch" });
      return;
    }
    if (record.codeChallenge) {
      if (!code_verifier || !verifyPkce(code_verifier, record.codeChallenge, record.codeChallengeMethod ?? "S256")) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }

    authCodes.delete(code);
    issueTokenResponse(res, client_id);
    return;
  }

  if (grantType === "refresh_token") {
    const { refresh_token, client_id } = body;
    const record = refresh_token ? refreshTokens.get(refresh_token) : undefined;
    if (!record || record.clientId !== client_id) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    issueTokenResponse(res, client_id);
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
}

function issueTokenResponse(res: Response, clientId: string) {
  const accessToken = base64url(randomBytes(32));
  const refreshToken = base64url(randomBytes(32));

  accessTokens.set(accessToken, { clientId, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
  refreshTokens.set(refreshToken, { clientId });

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: refreshToken,
  });
}

// ---- Middleware used by the /mcp route ----
export function isValidAccessToken(token: string): boolean {
  const record = accessTokens.get(token);
  if (!record) return false;
  if (record.expiresAt < Date.now()) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
