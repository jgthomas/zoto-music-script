import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseCli } from "./cli.ts";

test("parseCli extracts urls and applies defaults", () => {
  const { values, urls } = parseCli(["https://example.com/watch?v=1"]);
  assert.deepEqual(urls, ["https://example.com/watch?v=1"]);
  assert.equal(values.thumbnail, true);
  assert.equal(values.help, false);
  assert.equal(values["output-dir"], undefined);
});

test("parseCli parses options", () => {
  const { values, urls } = parseCli([
    "--output-dir",
    "/tmp/music",
    "--quality",
    "5",
    "--archive",
    "/tmp/a.txt",
    "--yt-dlp",
    "/usr/bin/yt-dlp",
    "--no-thumbnail",
    "https://example.com/watch?v=1",
  ]);
  assert.equal(values["output-dir"], "/tmp/music");
  assert.equal(values.quality, "5");
  assert.equal(values.archive, "/tmp/a.txt");
  assert.equal(values["yt-dlp"], "/usr/bin/yt-dlp");
  assert.equal(values.thumbnail, false);
  assert.deepEqual(urls, ["https://example.com/watch?v=1"]);
});

test("parseCli keeps thumbnail enabled when --no-thumbnail is absent", () => {
  const { values } = parseCli(["https://example.com"]);
  assert.equal(values.thumbnail, true);
});

test("parseCli recognizes the help flag", () => {
  const { values, urls } = parseCli(["-h"]);
  assert.equal(values.help, true);
  assert.deepEqual(urls, []);
});

test("parseCli accepts multiple urls", () => {
  const { urls } = parseCli(["https://a.com/1", "https://a.com/2"]);
  assert.deepEqual(urls, ["https://a.com/1", "https://a.com/2"]);
});
