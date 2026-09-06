import { strict as assert } from "node:assert";
import { test } from "node:test";
import path from "node:path";
import { localUploadJobKey, syncJobKey } from "./job-key.ts";

test("syncJobKey is stable and source-specific", () => {
  assert.equal(syncJobKey("https://example.test/a"), syncJobKey("https://example.test/a"));
  assert.notEqual(syncJobKey("https://example.test/a"), syncJobKey("https://example.test/b"));
});

test("localUploadJobKey uses resolved inputs and preserves their order", () => {
  assert.equal(localUploadJobKey(["music"]), localUploadJobKey([path.resolve("music")]));
  assert.notEqual(localUploadJobKey(["a.mp3", "b.mp3"]), localUploadJobKey(["b.mp3", "a.mp3"]));
});
