import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { uploadPlaylist, sha256File } from "./media.ts";
import { UploadJobStore } from "./job-store.ts";
import { getAccessToken } from "./auth.ts";
import { localError } from "../local-errors.ts";

test("rejected refresh preserves saved tokens and performs only one request", async () => {
  const tokens = { accessToken: "old", refreshToken: "secret", expiresAt: 0 };
  let calls = 0;
  await assert.rejects(getAccessToken({
    clientId: "client",
    tokenStore: {
      read: async () => tokens,
      write: async () => { assert.fail("must not overwrite tokens"); },
      clear: async () => { assert.fail("must not delete tokens"); },
    },
    fetch: async () => { calls++; return Response.json({ error: "invalid_grant" }, { status: 400 }); },
  }), /auth login/);
  assert.equal(calls, 1);
});

test("filesystem errors explain permissions and disk space without exposing raw errors", () => {
  assert.match(localError({ code: "EACCES" }, "Saving", "/state/jobs").message, /permissions/);
  assert.match(localError({ code: "ENOSPC" }, "Saving", "/state/jobs").message, /Free disk space/);
});

test("upload preflight rejects an empty later track before any remote requests", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, "first.mp3"), second = path.join(directory, "empty.mp3");
  await writeFile(first, "audio");
  await writeFile(second, "");
  await assert.rejects(uploadPlaylist({
    title: "Album",
    tracks: [{ filePath: first, title: "First", order: 1 }, { filePath: second, title: "Empty", order: 2 }],
    getAccessToken: async () => { assert.fail("must not request auth"); },
    fetch: async () => { assert.fail("must not contact Yoto"); },
  }), /MP3 file is empty:.*empty.mp3/);
});

test("transcoding respects Retry-After and stops if the wait exceeds its deadline", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-poll-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "track.mp3");
  await writeFile(filePath, "audio");
  for (const delay of ["7", "3600"]) {
    const store = new UploadJobStore(path.join(directory, delay));
    let polls = 0;
    const sleeps: number[] = [];
    const operation = uploadPlaylist({
      title: "Album", tracks: [{ filePath, title: "Track", order: 1 }],
      jobStore: store, jobKey: "job", getAccessToken: async () => "token",
      sleep: async ms => { sleeps.push(ms); },
      fetch: async input => {
        if (String(input).includes("/uploadUrl")) return Response.json({ upload: { uploadUrl: null, uploadId: "id" } });
        if (String(input).includes("/transcoded")) {
          polls++;
          if (polls === 1) return new Response(null, { status: 429, headers: { "Retry-After": delay } });
          return Response.json({ transcode: {
            transcodedSha256: "hash", transcodedInfo: { duration: 1, fileSize: 5, format: "mp3" },
          } });
        }
        return Response.json({ card: { cardId: "Card1" } });
      },
    });
    if (delay === "7") {
      await operation;
      assert.deepEqual(sleeps, [7000]);
    } else {
      await assert.rejects(operation, /Track: Yoto transcoding timed out.*429/);
      assert.equal(polls, 1);
      assert.deepEqual(sleeps, []);
      assert.equal((await store.get("job"))?.tracks[0]?.uploadId, "id");
    }
  }
});

test("invalid transcoded media stops before creating content and retains the upload ID", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-invalid-media-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "track.mp3");
  await writeFile(filePath, "audio");
  const store = new UploadJobStore(path.join(directory, "jobs"));
  await assert.rejects(uploadPlaylist({
    title: "Album", tracks: [{ filePath, title: "Track", order: 1 }],
    jobStore: store, jobKey: "job", getAccessToken: async () => "token",
    fetch: async input => {
      if (String(input).includes("/uploadUrl")) return Response.json({ upload: { uploadUrl: null, uploadId: "id" } });
      assert.ok(String(input).includes("/transcoded"));
      return Response.json({ transcode: { transcodedSha256: "hash", transcodedInfo: { duration: -1, fileSize: 5, format: "mp3" } } });
    },
  }), /Track: Yoto returned invalid transcoded media information/);
  assert.equal((await store.get("job"))?.tracks[0]?.uploadId, "id");
  assert.equal((await store.get("job"))?.cardId, undefined);
});

test("only missing or deleted content suggests new-copy; update failures retain card ID", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-deleted-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "track.mp3");
  await writeFile(filePath, "audio");
  const file = await stat(filePath);
  const store = new UploadJobStore(path.join(directory, "jobs"));
  await store.put({
    key: "job", title: "Old title", completed: true, cardId: "Card1", updatedAt: new Date().toISOString(),
    tracks: [{ key: `file:${filePath}`, filePath, title: "Track", order: 1,
      size: file.size, mtimeMs: file.mtimeMs, sourceSha256: await sha256File(filePath),
      audio: { transcodedSha256: "hash", transcodedInfo: { duration: 1, fileSize: 5, format: "mp3" } } }],
  });
  for (const [status, message, expected] of [
    [400, "Invalid title", false],
    [400, "Deleted card cannot be restored", true],
    [404, "Not found", true],
  ] as const) {
    await assert.rejects(uploadPlaylist({
      title: "New title", tracks: [{ filePath, title: "Track", order: 1 }],
      jobStore: store, jobKey: "job", getAccessToken: async () => "token",
      fetch: async input => {
        assert.ok(String(input).endsWith("/content"));
        return Response.json({ error: { message } }, { status });
      },
    }), error => {
      assert.equal(String(error).includes("--new-copy"), expected);
      return true;
    });
    assert.equal((await store.get("job"))?.cardId, "Card1");
  }
});
