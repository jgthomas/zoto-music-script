import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseProbeOutput } from "./probe.ts";

test("parseProbeOutput detects a single video", () => {
  const r = parseProbeOutput("NA|NA|NA|Some Video Title\n");
  assert.equal(r.kind, "single");
  assert.equal(r.title, "Some Video Title");
  assert.equal(r.count, 0);
});

test("parseProbeOutput detects a playlist", () => {
  const r = parseProbeOutput("PL123|My Playlist|5|First Title\n");
  assert.equal(r.kind, "playlist");
  assert.equal(r.title, "My Playlist");
  assert.equal(r.count, 5);
});

test("parseProbeOutput uses the first non-empty line", () => {
  const r = parseProbeOutput("\nPL1|Second Playlist|3|T\nPL1|Ignored|9|T\n");
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
