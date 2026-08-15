import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { buildSingleTrackContent, sha256File, uploadSingleTrack } from "./media.ts";

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
  assert.equal(content.content.chapters[0]?.tracks[0]?.title, "Track title");
  assert.equal(content.content.chapters[0]?.tracks[0]?.trackUrl, "yoto:#transcoded-hash");
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

  assert.deepEqual(result, { cardId: "Ab123", title: "Test playlist" });
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
