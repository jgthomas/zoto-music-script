import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatBytes, parseProgressLine, renderProgressLine } from "./progress.ts";

test("formatBytes handles zero and negative", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(-1), "0 B");
});

test("formatBytes scales units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.00 KiB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.00 MiB");
  assert.equal(formatBytes(Number.NaN), "0 B");
});

test("parseProgressLine accepts a full download line", () => {
  const p = parseProgressLine("download:1048576|2097152|50.0%|1.5MiB/s|00:00:01");
  assert.ok(p);
  assert.equal(p.downloaded, 1048576);
  assert.equal(p.total, 2097152);
  assert.equal(p.percent, 50);
  assert.equal(p.speed, "1.5MiB/s");
  assert.equal(p.eta, "00:00:01");
});

test("parseProgressLine tolerates missing fields", () => {
  const p = parseProgressLine("download:100|0|||");
  assert.ok(p);
  assert.equal(p.total, 0);
  assert.equal(p.percent, null);
  assert.equal(p.speed, "");
  assert.equal(p.eta, "");
});

test("parseProgressLine returns null for non-download lines", () => {
  assert.equal(parseProgressLine("[download] 100% of 3.2MiB in 00:00:01"), null);
  assert.equal(parseProgressLine("TITLE:Hello"), null);
  assert.equal(parseProgressLine(""), null);
});

test("renderProgressLine shows a bar and percent", () => {
  const p = parseProgressLine("download:524288|1048576|50.0%|1MiB/s|00:00:01");
  assert.ok(p);
  const rendered = renderProgressLine(p, 8);
  assert.match(rendered, /\[.+\]/);
  assert.match(rendered, /50\.0%/);
  assert.match(rendered, /1MiB\/s/);
});
