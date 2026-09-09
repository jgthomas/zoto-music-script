import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Config } from "./config.ts";
import {
  buildArgs,
  buildOutputTemplate,
  downloadVideo,
  parseOutputLine,
  recoverArchivedTracks,
} from "./download.ts";
import { DownloadManifest } from "./download-manifest.ts";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProbeResult } from "./probe.ts";

const config: Config = {
  outputDir: "/tmp/music",
  quality: 3,
  embedThumbnail: true,
  archivePath: "/tmp/archive.txt",
  downloadManifestPath: "/tmp/downloads.json",
  ytDlpBin: "yt-dlp",
  yotoTokenPath: "/tmp/zoto-music-test-auth.json",
  yotoJobsPath: "/tmp/zoto-music-test-jobs.json",
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

test("parseOutputLine detects structured completed tracks", () => {
  assert.deepEqual(
    parseOutputLine(
      'TRACK:{"id":"abc","title":"Song","webpageUrl":"https://youtu.be/abc","playlistTitle":"Album","playlistIndex":2,"filePath":"/tmp/02 - Song.mp3"}',
    ),
    {
      kind: "track",
      track: {
        id: "abc",
        title: "Song",
        webpageUrl: "https://youtu.be/abc",
        playlistTitle: "Album",
        playlistIndex: 2,
        filePath: "/tmp/02 - Song.mp3",
      },
    },
  );
});

test("parseOutputLine rejects malformed structured tracks", () => {
  assert.equal(parseOutputLine("TRACK:not-json").kind, "none");
  assert.equal(parseOutputLine('TRACK:{"title":"Missing fields"}').kind, "none");
});

test("parseOutputLine normalizes yt-dlp unavailable values", () => {
  const result = parseOutputLine(
    'TRACK:{"id":"abc","title":"NA is a title","webpageUrl":"https://youtu.be/abc","playlistTitle":NA,"playlistIndex":NA,"filePath":"/tmp/NA Song.mp3"}',
  );
  assert.equal(result.kind, "track");
  if (result.kind === "track") {
    assert.equal(result.track.title, "NA is a title");
    assert.equal(result.track.playlistTitle, null);
    assert.equal(result.track.playlistIndex, null);
    assert.equal(result.track.filePath, "/tmp/NA Song.mp3");
  }
});

test("parseOutputLine detects archive skip message with 'the'", () => {
  const r = parseOutputLine("[download] dQw4w9WgXcQ has already been recorded in the archive");
  assert.equal(r.kind, "skipped");
  if (r.kind === "skipped") assert.equal(r.id, "dQw4w9WgXcQ");
});

test("parseOutputLine detects legacy archive skip message without 'the'", () => {
  const r = parseOutputLine("[download] dQw4w9WgXcQ has already been recorded in archive");
  assert.equal(r.kind, "skipped");
});

test("parseOutputLine detects an explicit playlist position", () => {
  assert.deepEqual(parseOutputLine("[download] Downloading item 2 of 10"), {
    kind: "playlist-item",
    order: 2,
  });
});

test("recoverArchivedTracks reattaches archive-skipped videos to the current playlist", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-archive-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "old.mp3");
  await writeFile(filePath, "audio");
  const manifest = new DownloadManifest(path.join(directory, "downloads.json"));
  await manifest.record([
    {
      filePath,
      title: "Original",
      order: 9,
      source: {
        kind: "youtube",
        id: "video",
        url: "https://youtube.test/watch/video",
        requestUrl: "https://youtube.test/old",
      },
    },
  ]);
  const recovered = await recoverArchivedTracks(
    manifest,
    [{ id: "video", order: 2 }],
    "https://youtube.test/new",
    { kind: "playlist", title: "New playlist", count: 2 },
  );
  assert.deepEqual(
    recovered.map((track) => ({
      order: track.order,
      requestUrl: track.source?.requestUrl,
      playlistIndex: track.source?.playlistIndex,
    })),
    [{ order: 2, requestUrl: "https://youtube.test/new", playlistIndex: 2 }],
  );
});

test("downloadVideo recovers archive-skipped playlist tracks from yt-dlp output", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-download-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archivedPath = path.join(directory, "archived.mp3");
  const downloadedPath = path.join(directory, "downloaded.mp3");
  await Promise.all([writeFile(archivedPath, "old audio"), writeFile(downloadedPath, "new audio")]);
  const executable = path.join(directory, "fake-yt-dlp");
  await writeFile(
    executable,
    `#!/bin/sh
printf '[download] Downloading item 1'
printf ' of 2\\n'
printf '[download] archived-id has already '
printf 'been recorded in the archive\\n'
printf '[download] Downloading item 2 of 2\\n'
printf 'TRACK:{"id":"new-id","title":"New","webpageUrl":"https://youtube.test/new-id","playlistTitle":"Current","playlistIndex":2,"filePath":"${downloadedPath}"}\\n'
printf 'a diagnostic split' >&2
printf ' across chunks\\n' >&2
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const manifest = new DownloadManifest(path.join(directory, "downloads.json"));
  await manifest.record([
    {
      filePath: archivedPath,
      title: "Archived",
      order: 8,
      source: {
        kind: "youtube",
        id: "archived-id",
        url: "https://youtube.test/archived-id",
        requestUrl: "https://youtube.test/previous",
      },
    },
  ]);

  const result = await downloadVideo({
    url: "https://youtube.test/current",
    probe: { kind: "playlist", title: "Current", count: 2 },
    config: {
      ...config,
      ytDlpBin: executable,
      outputDir: directory,
      archivePath: path.join(directory, "archive.txt"),
      downloadManifestPath: manifest.filePath,
    },
    manifest,
  });

  assert.equal(result.downloadedCount, 1);
  assert.equal(result.skipped, true);
  assert.deepEqual(
    result.tracks.map((track) => [track.source?.id, track.order]),
    [
      ["archived-id", 1],
      ["new-id", 2],
    ],
  );
  assert.deepEqual(
    (await manifest.tracksForRequest("https://youtube.test/current")).map((track) => [
      track.source?.id,
      track.order,
    ]),
    [
      ["archived-id", 1],
      ["new-id", 2],
    ],
  );
});

test("downloadVideo reports a missing yt-dlp executable", async () => {
  await assert.rejects(
    downloadVideo({
      url: "https://youtube.test/video",
      probe: { kind: "single", title: "Video", count: 0 },
      config: { ...config, ytDlpBin: "/tmp/zoto-missing-yt-dlp" },
    }),
    /Could not start .*zoto-missing-yt-dlp/,
  );
});

test("downloadVideo includes diagnostics from a failed yt-dlp process and does not persist tracks", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-download-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trackPath = path.join(directory, "track.mp3");
  await writeFile(trackPath, "audio");
  const executable = path.join(directory, "fake-yt-dlp");
  await writeFile(
    executable,
    `#!/bin/sh
printf 'TRACK:{"id":"video","title":"Video","filePath":"${trackPath}"}\\n'
printf 'the downloader failed\\n' >&2
exit 7
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const manifest = new DownloadManifest(path.join(directory, "downloads.json"));

  await assert.rejects(
    downloadVideo({
      url: "https://youtube.test/video",
      probe: { kind: "single", title: "Video", count: 0 },
      config: { ...config, ytDlpBin: executable },
      manifest,
    }),
    /yt-dlp exited with code 7\nthe downloader failed/,
  );
  assert.deepEqual(await manifest.tracksForRequest("https://youtube.test/video"), []);
});

test("downloadVideo propagates manifest checkpoint failures", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-download-manifest-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trackPath = path.join(directory, "track.mp3");
  await writeFile(trackPath, "audio");
  const executable = path.join(directory, "fake-yt-dlp");
  await writeFile(
    executable,
    `#!/bin/sh
printf 'TRACK:{"id":"video","title":"Video","filePath":"${trackPath}"}\\n'
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const manifest = new DownloadManifest(path.join(directory, "downloads.json"));
  manifest.record = async () => {
    throw new Error("simulated manifest failure");
  };

  await assert.rejects(
    downloadVideo({
      url: "https://youtube.test/video",
      probe: { kind: "single", title: "Video", count: 0 },
      config: { ...config, ytDlpBin: executable },
      manifest,
    }),
    /simulated manifest failure/,
  );
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
