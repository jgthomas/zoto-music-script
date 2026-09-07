import { strict as assert } from "node:assert";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { UploadJobStore, uploadTrackKey } from "./job-store.ts";

test("UploadJobStore persists, replaces, and removes jobs securely", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-job-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, "state", "jobs");
  const store = new UploadJobStore(storePath);
  assert.equal(await store.get("job"), null);
  await store.put({
    key: "job",
    title: "Playlist",
    completed: false,
    tracks: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal((await store.get("job"))?.title, "Playlist");
  assert.equal((await stat(storePath)).mode & 0o777, 0o700);
  const [jobFile] = await readdir(storePath);
  assert.ok(jobFile);
  assert.equal((await stat(path.join(storePath, jobFile))).mode & 0o777, 0o600);
  await store.put({
    key: "job",
    title: "Updated",
    cardId: "Ab123",
    completed: true,
    tracks: [],
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal((await store.get("job"))?.cardId, "Ab123");
  await store.remove("job");
  assert.equal(await store.get("job"), null);
});

test("UploadJobStore preserves concurrent updates to different jobs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-job-store-concurrent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new UploadJobStore(path.join(directory, "jobs"));
  const jobs = Array.from({ length: 20 }, (_, index) => ({
    key: `job-${index}`,
    title: `Playlist ${index}`,
    completed: false,
    tracks: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));

  await Promise.all(jobs.map((job) => store.put(job)));

  assert.deepEqual(
    await Promise.all(jobs.map(async (job) => (await store.get(job.key))?.title)),
    jobs.map((job) => job.title),
  );
  assert.equal((await readdir(store.directoryPath)).length, jobs.length);
});

test("UploadJobStore finds one unfinished copy job by its stable source key", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-job-store-copy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new UploadJobStore(path.join(directory, "jobs"));
  await store.put({
    key: "source#copy",
    copyOf: "source",
    title: "Copy",
    completed: false,
    tracks: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.put({
    key: "source#complete",
    copyOf: "source",
    title: "Complete",
    completed: true,
    cardId: "Ab123",
    tracks: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal((await store.findIncompleteCopy("source"))?.key, "source#copy");
});

test("uploadTrackKey uses YouTube identity when present and local path otherwise", () => {
  assert.equal(
    uploadTrackKey({
      filePath: "/tmp/video.mp3",
      title: "Video",
      order: 1,
      source: {
        kind: "youtube",
        id: "video-id",
        url: "https://example.test/video",
        requestUrl: "https://example.test/playlist",
      },
    }),
    "youtube:video-id",
  );
  assert.equal(
    uploadTrackKey({ filePath: "/tmp/local.mp3", title: "Local", order: 1 }),
    "file:/tmp/local.mp3",
  );
});
