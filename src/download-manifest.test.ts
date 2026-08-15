import { strict as assert } from "node:assert";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { DownloadManifest } from "./download-manifest.ts";
import type { LocalTrack } from "./tracks.ts";

function youtubeTrack(filePath: string, id: string, requestUrl = "https://youtube.test/list"): LocalTrack {
  return {
    filePath,
    title: `Track ${id}`,
    order: Number(id),
    source: {
      kind: "youtube",
      id,
      url: `https://youtube.test/watch/${id}`,
      requestUrl,
      playlistTitle: "Test playlist",
      playlistIndex: Number(id),
    },
  };
}

test("DownloadManifest records and recovers existing tracks in order", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "state", "downloads.json");
  const second = path.join(directory, "2.mp3");
  const first = path.join(directory, "1.mp3");
  await Promise.all([writeFile(second, ""), writeFile(first, "")]);
  const manifest = new DownloadManifest(manifestPath);
  await manifest.record([youtubeTrack(second, "2"), youtubeTrack(first, "1")]);

  const recovered = await manifest.tracksForRequest("https://youtube.test/list");
  assert.deepEqual(recovered.map((track) => track.source?.id), ["1", "2"]);
  assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
});

test("DownloadManifest replaces entries and excludes missing files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-manifest-replace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = new DownloadManifest(path.join(directory, "downloads.json"));
  const oldPath = path.join(directory, "old.mp3");
  const newPath = path.join(directory, "new.mp3");
  await writeFile(newPath, "");
  await manifest.record([youtubeTrack(oldPath, "1")]);
  await manifest.record([{ ...youtubeTrack(newPath, "1"), title: "Replacement" }]);
  const recovered = await manifest.tracksForRequest("https://youtube.test/list");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.filePath, newPath);
  assert.equal(recovered[0]?.title, "Replacement");
});
