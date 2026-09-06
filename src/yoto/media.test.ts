import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, stat, utimes } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { UploadJobStore } from "./job-store.ts";
import {
  buildPlaylistContent,
  buildSingleTrackContent,
  sha256File,
  uploadPlaylist,
  uploadSingleTrack,
} from "./media.ts";

test("sha256File returns a base64url SHA-256 digest", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-media-hash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "track.mp3");
  await writeFile(filePath, "hello");
  assert.equal(await sha256File(filePath), "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ");
});

test("buildSingleTrackContent creates a one-chapter music playlist", () => {
  const content = buildSingleTrackContent("Playlist title", {
    transcodedSha256: "transcoded-hash",
    transcodedInfo: {
      duration: 123,
      fileSize: 456,
      channels: "stereo",
      format: "mp3",
      metadata: { title: "Track title" },
    },
  }) as {
    title: string;
    content: { chapters: Array<{ tracks: Array<{ trackUrl: string; title: string }> }> };
    metadata: { category: string };
  };
  assert.equal(content.title, "Playlist title");
  assert.equal(content.metadata.category, "music");
  assert.equal(content.content.chapters.length, 1);
  assert.equal(content.content.chapters[0]?.tracks[0]?.title, "Playlist title");
  assert.equal(content.content.chapters[0]?.tracks[0]?.trackUrl, "yoto:#transcoded-hash");
});

test("buildPlaylistContent creates one ordered chapter per track and aggregates media", () => {
  const content = buildPlaylistContent("Album", [
    {
      track: { filePath: "/two.mp3", title: "Second", order: 2 },
      audio: {
        transcodedSha256: "hash-2",
        transcodedInfo: { duration: 20, fileSize: 200, format: "mp3" },
      },
    },
    {
      track: { filePath: "/one.mp3", title: "First", order: 1 },
      audio: {
        transcodedSha256: "hash-1",
        transcodedInfo: { duration: 10, fileSize: 100, format: "mp3" },
      },
    },
  ]) as {
    content: { chapters: Array<{ key: string; title: string }> };
    metadata: { media: { duration: number; fileSize: number } };
  };
  assert.deepEqual(content.content.chapters.map(({ key, title }) => ({ key, title })), [
    { key: "01", title: "Second" },
    { key: "02", title: "First" },
  ]);
  assert.deepEqual(content.metadata.media, { duration: 30, fileSize: 300 });
});

test("uploadSingleTrack uploads, polls, and creates content", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-media-upload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "track.mp3");
  await writeFile(filePath, "fake mp3 data");
  const requests: Array<{ url: string; method: string; body?: BodyInit | null }> = [];
  let transcodeChecks = 0;
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body });
    if (url.includes("/uploadUrl")) {
      return Response.json({ upload: { uploadUrl: "https://uploads.example/audio", uploadId: "id" } });
    }
    if (url === "https://uploads.example/audio") return new Response(null, { status: 200 });
    if (url.includes("/transcoded")) {
      transcodeChecks++;
      if (transcodeChecks === 1) return Response.json({ transcode: {} });
      return Response.json({
        transcode: {
          transcodedSha256: "media-hash",
          transcodedInfo: { duration: 10, fileSize: 20, channels: 2, format: "mp3" },
        },
      });
    }
    if (url.endsWith("/content")) {
      return Response.json({ card: { cardId: "Ab123", title: "Test playlist" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await uploadSingleTrack({
    filePath,
    title: "Test playlist",
    getAccessToken: async () => "token",
    fetch: fetchMock,
    sleep: async () => {},
    maxPollAttempts: 3,
  });

  assert.deepEqual(result, {
    cardId: "Ab123",
    title: "Test playlist",
    operation: "created",
  });
  assert.equal(requests.filter((request) => request.method === "PUT").length, 1);
  assert.equal(transcodeChecks, 2);
  const create = requests.find((request) => request.url.endsWith("/content"));
  assert.ok(create?.body);
  const body = JSON.parse(String(create.body));
  assert.equal(body.content.chapters[0].tracks[0].channels, "stereo");
});

test("uploadSingleTrack skips PUT when Yoto already has the source file", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-media-dedup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "track.mp3");
  await writeFile(filePath, "fake mp3 data");
  const methods: string[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    methods.push(init?.method ?? "GET");
    if (url.includes("/uploadUrl")) {
      return Response.json({ upload: { uploadUrl: null, uploadId: "existing" } });
    }
    if (url.includes("/transcoded")) {
      return Response.json({
        transcode: {
          transcodedSha256: "media-hash",
          transcodedInfo: { duration: 10, fileSize: 20, channels: "mono", format: "mp3" },
        },
      });
    }
    return Response.json({ card: { cardId: "Ab123", title: "Existing" } });
  };
  await uploadSingleTrack({
    filePath,
    title: "Existing",
    getAccessToken: async () => "token",
    fetch: fetchMock,
  });
  assert.ok(!methods.includes("PUT"));
});

test("uploadPlaylist sorts LocalTracks and creates one multi-track content object", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-media-playlist-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, "first.mp3");
  const second = path.join(directory, "second.mp3");
  await Promise.all([writeFile(first, "first"), writeFile(second, "second")]);
  let uploadNumber = 0;
  let createdBody: { content: { chapters: Array<{ title: string }> } } | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/uploadUrl")) {
      uploadNumber++;
      return Response.json({
        upload: { uploadUrl: `https://uploads.example/${uploadNumber}`, uploadId: `id-${uploadNumber}` },
      });
    }
    if (url.startsWith("https://uploads.example/")) return new Response(null, { status: 200 });
    if (url.includes("/transcoded")) {
      const id = url.includes("id-1") ? "1" : "2";
      return Response.json({
        transcode: {
          transcodedSha256: `hash-${id}`,
          transcodedInfo: { duration: Number(id) * 10, fileSize: Number(id) * 100, format: "mp3" },
        },
      });
    }
    createdBody = JSON.parse(String(init?.body));
    return Response.json({ card: { cardId: "Multi", title: "Album" } });
  };

  await uploadPlaylist({
    tracks: [
      { filePath: second, title: "Second", order: 2 },
      { filePath: first, title: "First", order: 1 },
    ],
    title: "Album",
    getAccessToken: async () => "token",
    fetch: fetchMock,
  });
  assert.deepEqual(createdBody?.content.chapters.map((chapter) => chapter.title), ["First", "Second"]);
});

test("uploadPlaylist checkpoints tracks, resumes, and prevents duplicate content", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-media-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, "first.mp3");
  const second = path.join(directory, "second.mp3");
  await Promise.all([writeFile(first, "first"), writeFile(second, "second")]);
  const tracks = [
    { filePath: first, title: "First", order: 1 },
    { filePath: second, title: "Second", order: 2 },
  ];
  const jobStore = new UploadJobStore(path.join(directory, "jobs.json"));
  let firstRunUploadRequests = 0;
  const interruptedFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/uploadUrl")) {
      firstRunUploadRequests++;
      if (url.includes("second.mp3")) throw new Error("simulated interruption");
      return Response.json({ upload: { uploadUrl: null, uploadId: "first-id" } });
    }
    if (url.includes("/transcoded")) {
      return Response.json({
        transcode: {
          transcodedSha256: "first-hash",
          transcodedInfo: { duration: 10, fileSize: 100, format: "mp3" },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  await assert.rejects(
    uploadPlaylist({
      tracks,
      title: "Album",
      getAccessToken: async () => "token",
      fetch: interruptedFetch,
      jobStore,
      jobKey: "local:album",
    }),
    /simulated interruption/,
  );
  assert.equal(firstRunUploadRequests, 2);

  const resumedRequests: string[] = [];
  const resumedFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    resumedRequests.push(url);
    if (url.includes("/uploadUrl")) {
      assert.ok(url.includes("second.mp3"));
      return Response.json({ upload: { uploadUrl: null, uploadId: "second-id" } });
    }
    if (url.includes("/transcoded")) {
      return Response.json({
        transcode: {
          transcodedSha256: "second-hash",
          transcodedInfo: { duration: 20, fileSize: 200, format: "mp3" },
        },
      });
    }
    const body = JSON.parse(String(init?.body));
    assert.equal(body.cardId, undefined);
    return Response.json({ card: { cardId: "Card1", title: "Album" } });
  };
  const created = await uploadPlaylist({
    tracks,
    title: "Album",
    getAccessToken: async () => "token",
    fetch: resumedFetch,
    jobStore,
    jobKey: "local:album",
  });
  assert.equal(created.operation, "created");
  assert.equal(resumedRequests.filter((url) => url.includes("/uploadUrl")).length, 1);

  const unchanged = await uploadPlaylist({
    tracks,
    title: "Album",
    getAccessToken: async () => "token",
    fetch: async () => {
      throw new Error("unchanged upload must not call Yoto");
    },
    jobStore,
    jobKey: "local:album",
  });
  assert.equal(unchanged.operation, "unchanged");
  assert.equal(unchanged.cardId, "Card1");
});

test("uploadPlaylist reuses media and updates the existing card when metadata changes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-media-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "track.mp3");
  await writeFile(filePath, "track");
  const tracks = [{ filePath, title: "Track", order: 1 }];
  const jobStore = new UploadJobStore(path.join(directory, "jobs.json"));
  const firstFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/uploadUrl")) {
      return Response.json({ upload: { uploadUrl: null, uploadId: "id" } });
    }
    if (url.includes("/transcoded")) {
      return Response.json({
        transcode: {
          transcodedSha256: "hash",
          transcodedInfo: { duration: 10, fileSize: 100, format: "mp3" },
        },
      });
    }
    return Response.json({ card: { cardId: "Card1", title: "Old title" } });
  };
  await uploadPlaylist({
    tracks,
    title: "Old title",
    getAccessToken: async () => "token",
    fetch: firstFetch,
    jobStore,
    jobKey: "local:update",
  });

  let updateBody: { cardId?: string; title?: string } | undefined;
  const updated = await uploadPlaylist({
    tracks,
    title: "New title",
    getAccessToken: async () => "token",
    fetch: async (input, init) => {
      assert.ok(String(input).endsWith("/content"));
      updateBody = JSON.parse(String(init?.body));
      return Response.json({ card: { cardId: "Card1", title: "New title" } });
    },
    jobStore,
    jobKey: "local:update",
  });
  assert.equal(updateBody?.cardId, "Card1");
  assert.equal(updateBody?.title, "New title");
  assert.equal(updated.operation, "updated");
});

test("cached audio is invalidated when bytes change with identical size and timestamp", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-hash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "track.mp3");
  await writeFile(filePath, "first");
  await utimes(filePath, 1700000000, 1700000000);
  const store = new UploadJobStore(path.join(directory, "jobs"));
  const tracks = [{ filePath, title: "Track", order: 1 }];
  let uploads = 0;
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input).includes("/uploadUrl")) {
      uploads++;
      return Response.json({ upload: { uploadUrl: null, uploadId: "id" } });
    }
    if (String(input).includes("/transcoded")) {
      return Response.json({ transcode: {
        transcodedSha256: `hash-${uploads}`,
        transcodedInfo: { duration: 1, fileSize: 5, format: "mp3" },
      } });
    }
    if (uploads === 2) assert.equal(JSON.parse(String(init?.body)).cardId, "Card1");
    return Response.json({ card: { cardId: "Card1" } });
  };
  const options = { tracks, title: "Album", jobStore: store, jobKey: "job",
    getAccessToken: async () => "token", fetch: fetchMock };
  await uploadPlaylist(options);
  const before = await stat(filePath);
  await writeFile(filePath, "other");
  await utimes(filePath, 1700000000, 1700000000);
  assert.equal((await stat(filePath)).mtimeMs, before.mtimeMs);
  assert.equal((await uploadPlaylist(options)).operation, "updated");
  assert.equal(uploads, 2);
  assert.equal((await store.get("job"))?.tracks[0]?.audio?.transcodedSha256, "hash-2");
});

for (const failure of ["response", "checkpoint", "before-request"] as const) {
  test(`creation recovery protects against ${failure} failure`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-create-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "track.mp3");
    await writeFile(filePath, "audio");
    const store = new UploadJobStore(path.join(directory, "jobs"));
    const details = await stat(filePath);
    await store.put({
      key: "job", title: "Album", completed: false, updatedAt: new Date().toISOString(),
      tracks: [{
        key: `file:${filePath}`, filePath, title: "Track", order: 1,
        size: details.size, mtimeMs: details.mtimeMs, sourceSha256: await sha256File(filePath),
        audio: { transcodedSha256: "hash", transcodedInfo: { duration: 1, fileSize: 5, format: "mp3" } },
      }],
    });
    const put = store.put.bind(store);
    store.put = async (job) => {
      if ((failure === "checkpoint" && job.completed) ||
          (failure === "before-request" && job.creating)) throw new Error("disk failure");
      await put(job);
    };
    let requests = 0;
    const options = {
      tracks: [{ filePath, title: "Track", order: 1 }], title: "Album",
      jobStore: store, jobKey: "job", getAccessToken: async () => "token",
      fetch: (async (input) => {
        requests++;
        assert.ok(String(input).endsWith("/content"));
        assert.equal((await store.get("job"))?.creating, true);
        if (failure === "response") throw new Error("lost response");
        return Response.json({ card: { cardId: "Card1" } });
      }) as typeof fetch,
    };
    await assert.rejects(uploadPlaylist(options),
      failure === "checkpoint" ? /Card1.*local checkpoint failed/ : /disk failure|lost response/);
    store.put = put;
    if (failure === "before-request") {
      assert.equal(requests, 0);
      assert.notEqual((await store.get("job"))?.creating, true);
      return;
    }
    for (const restart of [false, true]) {
      await assert.rejects(uploadPlaylist({ ...options, restart }), /outcome is unknown/);
    }
    assert.equal(requests, 1);
    const result = await uploadPlaylist({
      ...options, retryCreate: true,
      fetch: async () => Response.json({ card: { cardId: "Recovered" } }),
    });
    assert.equal(result.cardId, "Recovered");
    assert.equal((await store.get("job"))?.creating, false);
    assert.equal((await store.get("job"))?.completed, true);
  });
}

test("uploadPlaylist resumes polling a checkpointed upload ID", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-media-upload-id-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "track.mp3");
  await writeFile(filePath, "track");
  const tracks = [{ filePath, title: "Track", order: 1 }];
  const jobStore = new UploadJobStore(path.join(directory, "jobs.json"));
  await assert.rejects(
    uploadPlaylist({
      tracks,
      title: "Pending",
      getAccessToken: async () => "token",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/uploadUrl")) {
          return Response.json({ upload: { uploadUrl: null, uploadId: "pending-id" } });
        }
        return Response.json({ transcode: {} });
      },
      maxPollAttempts: 1,
      jobStore,
      jobKey: "local:pending",
    }),
    /transcoding timed out/,
  );

  const requests: string[] = [];
  const result = await uploadPlaylist({
    tracks,
    title: "Pending",
    getAccessToken: async () => "token",
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/transcoded")) {
        return Response.json({
          transcode: {
            transcodedSha256: "hash",
            transcodedInfo: { duration: 10, fileSize: 100, format: "mp3" },
          },
        });
      }
      return Response.json({ card: { cardId: "Card1", title: "Pending" } });
    },
    jobStore,
    jobKey: "local:pending",
  });
  assert.ok(!requests.some((url) => url.includes("/uploadUrl")));
  assert.equal(result.operation, "created");
});
