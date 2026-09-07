import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseProbeOutput } from "./probe.ts";

test("parseProbeOutput detects a single video", () => {
  const r = parseProbeOutput(
    '{"playlist":NA,"playlistTitle":NA,"count":NA,"title":"Some Video Title"}\n',
  );
  assert.equal(r.kind, "single");
  assert.equal(r.title, "Some Video Title");
  assert.equal(r.count, 0);
});

test("parseProbeOutput detects a playlist", () => {
  const r = parseProbeOutput(
    '{"playlist":"PL123","playlistTitle":"My Playlist","count":5,"title":"First Title"}\n',
  );
  assert.equal(r.kind, "playlist");
  assert.equal(r.title, "My Playlist");
  assert.equal(r.count, 5);
});

test("parseProbeOutput uses the first non-empty line", () => {
  const r = parseProbeOutput(
    '\n{"playlist":"PL1","playlistTitle":"Second Playlist","count":3,"title":"T"}\n{"playlist":"PL1","playlistTitle":"Ignored","count":9,"title":"T"}\n',
  );
  assert.equal(r.kind, "playlist");
  assert.equal(r.title, "Second Playlist");
  assert.equal(r.count, 3);
});

test("parseProbeOutput handles empty output", () => {
  const r = parseProbeOutput("");
  assert.equal(r.kind, "single");
  assert.equal(r.title, "");
  assert.equal(r.count, 0);
});

test("parseProbeOutput preserves delimiters and rejects malformed metadata", () => {
  const result = parseProbeOutput(
    '{"playlist":"PL1","playlistTitle":"Songs | Sleep","count":2,"title":"Ignored"}',
  );
  assert.equal(result.title, "Songs | Sleep");
  assert.deepEqual(parseProbeOutput("not-json"), { kind: "single", title: "", count: 0 });
});
