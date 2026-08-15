import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { discoverLocalTracks } from "./tracks.ts";

test("discoverLocalTracks naturally orders MP3s in a directory", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-tracks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(path.join(directory, "10 - Tenth.mp3"), ""),
    writeFile(path.join(directory, "2 - Second.MP3"), ""),
    writeFile(path.join(directory, "1 - First.mp3"), ""),
    writeFile(path.join(directory, "cover.jpg"), ""),
  ]);

  const tracks = await discoverLocalTracks([directory]);
  assert.deepEqual(
    tracks.map((track) => ({ title: track.title, order: track.order })),
    [
      { title: "First", order: 1 },
      { title: "Second", order: 2 },
      { title: "Tenth", order: 3 },
    ],
  );
  assert.ok(tracks.every((track) => track.source === undefined));
});

test("discoverLocalTracks preserves explicit input order", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-track-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, "Beta.mp3");
  const second = path.join(directory, "Alpha.mp3");
  await Promise.all([writeFile(first, ""), writeFile(second, "")]);
  const tracks = await discoverLocalTracks([first, second]);
  assert.deepEqual(tracks.map((track) => track.title), ["Beta", "Alpha"]);
});

test("discoverLocalTracks prefers an embedded ID3 title", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-track-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "Filename title.mp3");
  const titleData = Buffer.concat([Buffer.from([3]), Buffer.from("Embedded title")]);
  const frameHeader = Buffer.alloc(10);
  frameHeader.write("TIT2", 0, "ascii");
  frameHeader.writeUInt32BE(titleData.length, 4);
  const body = Buffer.concat([frameHeader, titleData]);
  const tagHeader = Buffer.from([
    0x49,
    0x44,
    0x33,
    3,
    0,
    0,
    (body.length >> 21) & 0x7f,
    (body.length >> 14) & 0x7f,
    (body.length >> 7) & 0x7f,
    body.length & 0x7f,
  ]);
  await writeFile(filePath, Buffer.concat([tagHeader, body]));
  const tracks = await discoverLocalTracks([filePath]);
  assert.equal(tracks[0]?.title, "Embedded title");
});

test("discoverLocalTracks rejects empty directories and unsupported files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-track-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "nested"));
  await assert.rejects(discoverLocalTracks([directory]), /No MP3 files were found/);
  const text = path.join(directory, "notes.txt");
  await writeFile(text, "");
  await assert.rejects(discoverLocalTracks([text]), /Not an MP3 file or directory/);
});
