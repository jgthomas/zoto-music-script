import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createPkceRequest,
  exchangeAuthorizationCode,
  getAccessToken,
  refreshAccessToken,
  YOTO_SCOPES,
} from "./auth.ts";
import type { StoredTokens, TokenStore } from "./token-store.ts";

class MemoryTokenStore implements TokenStore {
  tokens: StoredTokens | null = null;
  async read(): Promise<StoredTokens | null> {
    return this.tokens;
  }
  async write(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
  }
  async clear(): Promise<void> {
    this.tokens = null;
  }
}

function tokenResponse(accessToken = "access", refreshToken = "refresh"): Response {
  return Response.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
  });
}

test("createPkceRequest builds a state-protected authorization URL", () => {
  const request = createPkceRequest("client-123");
  const url = new URL(request.authorizationUrl);
  assert.equal(url.origin, "https://login.yotoplay.com");
  assert.equal(url.pathname, "/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("scope"), YOTO_SCOPES);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), request.state);
  assert.ok(request.verifier.length >= 43);
  assert.ok(url.searchParams.get("code_challenge"));
});

test("exchangeAuthorizationCode saves returned tokens", async () => {
  const store = new MemoryTokenStore();
  let requestBody = "";
  const fetchMock: typeof fetch = async (_input, init) => {
    requestBody = String(init?.body);
    return tokenResponse();
  };

  const tokens = await exchangeAuthorizationCode(
    { clientId: "client-123", tokenStore: store, fetch: fetchMock },
    "authorization-code",
    "verifier",
  );
  const body = new URLSearchParams(requestBody);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "authorization-code");
  assert.equal(body.get("code_verifier"), "verifier");
  assert.equal(tokens.refreshToken, "refresh");
  assert.deepEqual(store.tokens, tokens);
});

test("refreshAccessToken atomically replaces the single-use refresh token", async () => {
  const store = new MemoryTokenStore();
  let requestBody = "";
  const fetchMock: typeof fetch = async (_input, init) => {
    requestBody = String(init?.body);
    return tokenResponse("new-access", "new-refresh");
  };

  await refreshAccessToken(
    { clientId: "client-123", tokenStore: store, fetch: fetchMock },
    "old-refresh",
  );
  const body = new URLSearchParams(requestBody);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "old-refresh");
  assert.equal(store.tokens?.accessToken, "new-access");
  assert.equal(store.tokens?.refreshToken, "new-refresh");
});

test("getAccessToken reuses a valid token without a request", async () => {
  const store = new MemoryTokenStore();
  store.tokens = {
    accessToken: "still-valid",
    refreshToken: "refresh",
    expiresAt: Date.now() + 60_000,
  };
  const fetchMock: typeof fetch = async () => {
    throw new Error("fetch should not be called");
  };
  assert.equal(
    await getAccessToken({ clientId: "client-123", tokenStore: store, fetch: fetchMock }),
    "still-valid",
  );
});

test("getAccessToken refreshes an expiring token", async () => {
  const store = new MemoryTokenStore();
  store.tokens = { accessToken: "old", refreshToken: "refresh", expiresAt: Date.now() + 1_000 };
  const fetchMock: typeof fetch = async () => tokenResponse("new", "replacement");
  assert.equal(
    await getAccessToken({ clientId: "client-123", tokenStore: store, fetch: fetchMock }),
    "new",
  );
  assert.equal(store.tokens.refreshToken, "replacement");
});

test("getAccessToken rejects when no session exists", async () => {
  const store = new MemoryTokenStore();
  await assert.rejects(
    getAccessToken({ clientId: "client-123", tokenStore: store }),
    /Not signed in to Yoto/,
  );
});
