import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Config } from "./config.ts";
import { buildArgs, buildOutputTemplate, parseOutputLine } from "./download.ts";
import type { ProbeResult } from "./probe.ts";

const config: Config = {
  outputDir: "/tmp/music",
  quality: 3,
  embedThumbnail: true,
  archivePath: "/tmp/archive.txt",
  ytDlpBin: "yt-dlp",
};

test("buildOutputTemplate for a single video", () => {
  const probe: ProbeResult = { kind: "single", title: "T", count: 0 };
  assert.equal(buildOutputTemplate(probe, config), "/tmp/music/%(title)s.%(ext)s");
});

test("buildOutputTemplate for a playlist", () => {
  const probe: ProbeResult = { kind: "playlist", title: "P", count: 10 };
  assert.equal(
    buildOutputTemplate(probe, config),
    "/tmp/music/%(playlist_title)s/%(playlist_index)03d - %(title)s.%(ext)s",
  );
});

test("buildArgs includes download essentials", () => {
  const args = buildArgs("https://example.com/v", config, "/tmp/music/%(title)s.%(ext)s");
  assert.ok(args.includes("-x"));
  assert.ok(args.includes("--audio-format"));
  assert.ok(args.includes("mp3"));
  assert.ok(args.includes("--audio-quality"));
  assert.ok(args.includes("3"));
  assert.equal(args.at(-1), "https://example.com/v");
});

test("buildArgs configures machine-readable output and user options", () => {
  const args = buildArgs("https://example.com/v", config, "/tmp/music/%(title)s.%(ext)s");
  assert.ok(args.includes("--print"));
  assert.ok(args.includes("--no-simulate"));
  assert.ok(args.includes("--no-quiet"));
  assert.ok(args.includes("--newline"));
  assert.ok(args.includes("--progress-template"));
  assert.ok(args.includes("--download-archive"));
  assert.ok(args.includes("/tmp/archive.txt"));
  assert.ok(args.includes("--embed-metadata"));
  assert.ok(args.includes("--embed-thumbnail"));
  assert.deepEqual(args.slice(-2), ["--", "https://example.com/v"]);
});

test("buildArgs omits thumbnail embedding when disabled", () => {
  const args = buildArgs("https://example.com/v", { ...config, embedThumbnail: false }, "out");
  assert.ok(!args.includes("--embed-thumbnail"));
});

test("parseOutputLine detects a title", () => {
  assert.deepEqual(parseOutputLine("TITLE:Hello World"), {
    kind: "title",
    title: "Hello World",
  });
});

test("parseOutputLine detects progress", () => {
  const r = parseOutputLine("download:1024|2048|50.0%|1MiB/s|00:00:01");
  assert.equal(r.kind, "progress");
  if (r.kind === "progress") {
    assert.equal(r.data.downloaded, 1024);
    assert.ok(r.rendered.includes("50.0%"));
  }
});

test("parseOutputLine detects archive skip message with 'the'", () => {
  const r = parseOutputLine("[download] dQw4w9WgXcQ has already been recorded in the archive");
  assert.equal(r.kind, "skipped");
});

test("parseOutputLine detects legacy archive skip message without 'the'", () => {
  const r = parseOutputLine("[download] dQw4w9WgXcQ has already been recorded in archive");
  assert.equal(r.kind, "skipped");
});

test("parseOutputLine detects a destination", () => {
  assert.deepEqual(parseOutputLine("[download] Destination: /tmp/music/Song.mp3"), {
    kind: "destination",
    destination: "/tmp/music/Song.mp3",
  });
});

test("parseOutputLine detects the final post-processing destination", () => {
  assert.deepEqual(parseOutputLine("DESTINATION:/tmp/music/Song.mp3"), {
    kind: "destination",
    destination: "/tmp/music/Song.mp3",
  });
});

test("parseOutputLine ignores unrelated and empty lines", () => {
  assert.equal(parseOutputLine("[youtube] Extracting URL: ...").kind, "none");
  assert.equal(parseOutputLine("").kind, "none");
});
