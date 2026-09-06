import { strict as assert } from "node:assert";
import { test } from "node:test";
import { request, readJson, responseError, retryAfterMs } from "./request.ts";

test("network errors are actionable and do not expose signed URLs", async () => {
  await assert.rejects(request(async () => {
    throw new Error("https://upload.example/?secret=token");
  }, "https://example.test", {}, "Uploading"), error => {
    assert.match(String(error), /could not reach Yoto/);
    assert.doesNotMatch(String(error), /secret|token/);
    return true;
  });
});

test("deadlines cover stalled headers and stalled response bodies without retries", async () => {
  for (const body of [false, true]) {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const mock: typeof fetch = async (_, init) => {
      calls++;
      signal = init?.signal as AbortSignal;
      return body ? new Response(new ReadableStream({ start() {} }))
        : new Promise<Response>(() => {});
    };
    await assert.rejects(request(mock, "https://example.test", {}, "Checking", 5), /timed out/);
    assert.equal(calls, 1);
    assert.equal(signal?.aborted, true);
  }
});

test("HTTP errors classify authentication, permission, rate limits and deleted content safely", async () => {
  for (const [status, payload, expected] of [
    [400, { error: "invalid_grant" }, /auth login/],
    [401, {}, /auth login/],
    [403, {}, /scopes/],
    [429, {}, /Wait at least 8 seconds/],
    [503, {}, /temporarily unavailable/],
  ] as const) {
    const error = await responseError(Response.json(payload, { status, headers: { "Retry-After": "8" } }), "Request");
    assert.match(error.message, expected);
  }
  assert.equal((await responseError(Response.json({ error: { message: "Deleted card cannot be restored" } }, { status: 400 }), "Update")).deleted, true);
  const invalid = await responseError(Response.json({ error: { message: "token=secret" } }, { status: 400 }), "Update");
  assert.equal(invalid.deleted, false);
  assert.doesNotMatch(invalid.message, /secret/);
  const html = await responseError(new Response("<html>secret</html>", { status: 500 }), "Request");
  assert.doesNotMatch(html.message, /secret|html/);
});

test("Retry-After accepts dates and seconds; malformed JSON is explained", async () => {
  assert.equal(retryAfterMs(new Response(null, { headers: { "Retry-After": "10" } })), 10000);
  assert.equal(retryAfterMs(new Response(null, { headers: { "Retry-After": "Thu, 01 Jan 1970 00:00:10 GMT" } }), 0), 10000);
  for (const body of ["null", "[]", "<html>secret</html>"]) {
    await assert.rejects(readJson(new Response(body), "Upload"), /invalid JSON response/);
  }
});
