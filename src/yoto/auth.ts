import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { StoredTokens, TokenStore } from "./token-store.ts";

const AUTHORIZE_URL = "https://login.yotoplay.com/authorize";
const TOKEN_URL = "https://login.yotoplay.com/oauth/token";
const AUDIENCE = "https://api.yotoplay.com";
export const YOTO_SCOPES = "user:content:manage offline_access";
export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8787/callback";
const EXPIRY_BUFFER_MS = 30_000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export interface PkceRequest {
  verifier: string;
  state: string;
  authorizationUrl: string;
}

export interface AuthOptions {
  clientId: string;
  tokenStore: TokenStore;
  fetch?: typeof fetch;
  redirectUri?: string;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function jwtExpiry(token: string): number | null {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    const payload: unknown = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || !("exp" in payload)) return null;
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function toStoredTokens(response: TokenResponse): StoredTokens {
  if (!response.access_token || !response.refresh_token) {
    throw new Error("Yoto token response did not contain the required tokens");
  }
  const expiresAt =
    jwtExpiry(response.access_token) ?? Date.now() + (response.expires_in ?? 3600) * 1000;
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt,
  };
}

async function requestTokens(fetchImpl: typeof fetch, body: URLSearchParams): Promise<StoredTokens> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(`Yoto authentication failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return toStoredTokens((await response.json()) as TokenResponse);
}

export function createPkceRequest(
  clientId: string,
  redirectUri = DEFAULT_REDIRECT_URI,
): PkceRequest {
  const verifier = base64Url(randomBytes(32));
  const state = base64Url(randomBytes(24));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizationUrl = new URL(AUTHORIZE_URL);
  authorizationUrl.search = new URLSearchParams({
    audience: AUDIENCE,
    scope: YOTO_SCOPES,
    response_type: "code",
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    state,
  }).toString();
  return { verifier, state, authorizationUrl: authorizationUrl.toString() };
}

export async function exchangeAuthorizationCode(
  options: AuthOptions,
  code: string,
  verifier: string,
): Promise<StoredTokens> {
  const tokens = await requestTokens(
    options.fetch ?? fetch,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: options.clientId,
      code_verifier: verifier,
      code,
      redirect_uri: options.redirectUri ?? DEFAULT_REDIRECT_URI,
    }),
  );
  await options.tokenStore.write(tokens);
  return tokens;
}

export async function refreshAccessToken(
  options: AuthOptions,
  refreshToken: string,
): Promise<StoredTokens> {
  const tokens = await requestTokens(
    options.fetch ?? fetch,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: options.clientId,
      refresh_token: refreshToken,
    }),
  );
  // Yoto refresh tokens are single-use, so persist the replacement atomically
  // before returning it to callers.
  await options.tokenStore.write(tokens);
  return tokens;
}

export async function getAccessToken(options: AuthOptions): Promise<string> {
  const tokens = await options.tokenStore.read();
  if (!tokens) throw new Error("Not signed in to Yoto. Run `zoto-music auth login` first.");
  if (tokens.expiresAt > Date.now() + EXPIRY_BUFFER_MS) return tokens.accessToken;
  return (await refreshAccessToken(options, tokens.refreshToken)).accessToken;
}

function waitForAuthorizationCode(
  redirectUri: string,
  expectedState: string,
  timeoutMs = 5 * 60_000,
): Promise<string> {
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1") {
    throw new Error("Yoto CLI redirect URI must use http://127.0.0.1");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(code ?? "");
    };
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", redirect.origin);
      if (requestUrl.pathname !== redirect.pathname) {
        response.writeHead(404).end("Not found");
        return;
      }
      const error = requestUrl.searchParams.get("error");
      const errorDescription = requestUrl.searchParams.get("error_description");
      const state = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      if (state !== expectedState) {
        response.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid login callback.");
        finish(new Error("Yoto returned an invalid authorization callback"));
      } else if (error) {
        response.writeHead(400, { "Content-Type": "text/plain" }).end("Yoto login was cancelled.");
        finish(
          new Error(
            `Yoto authorization failed: ${error}${errorDescription ? ` (${errorDescription})` : ""}`,
          ),
        );
      } else if (!code) {
        response.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid login callback.");
        finish(new Error("Yoto returned an invalid authorization callback"));
      } else {
        response
          .writeHead(200, { "Content-Type": "text/plain" })
          .end("Login complete. You can close this tab and return to the terminal.");
        finish(undefined, code);
      }
    });
    const timer = setTimeout(() => finish(new Error("Timed out waiting for Yoto login")), timeoutMs);
    server.once("error", (error) => finish(new Error(`Could not start login callback server: ${error.message}`)));
    server.listen(Number(redirect.port), redirect.hostname);
  });
}

export async function login(
  options: AuthOptions,
  onAuthorizationUrl: (url: string) => void,
): Promise<StoredTokens> {
  const redirectUri = options.redirectUri ?? DEFAULT_REDIRECT_URI;
  const request = createPkceRequest(options.clientId, redirectUri);
  const codePromise = waitForAuthorizationCode(redirectUri, request.state);
  onAuthorizationUrl(request.authorizationUrl);
  const code = await codePromise;
  return exchangeAuthorizationCode(options, code, request.verifier);
}
