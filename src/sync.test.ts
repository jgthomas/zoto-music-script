import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Config } from "./config.ts";
import type { DownloadManifest } from "./download-manifest.ts";
import { syncYoutubeToYoto, type SyncDependencies } from "./sync.ts";
import type { LocalTrack } from "./tracks.ts";

const config: Config = {
  outputDir: "/music",
  quality: 0,
  embedThumbnail: true,
  archivePath: "/state/archive.txt",
  downloadManifestPath: "/state/downloads.json",
  ytDlpBin: "yt-dlp",
  yotoTokenPath: "/config/yoto-auth.json",
};

const manifest = {} as DownloadManifest;
const tracks: LocalTrack[] = [
  {
    filePath: "/music/Album/01 - First.mp3",
    title: "First",
    order: 1,
    source: {
      kind: "youtube",
      id: "one",
      url: "https://youtube.test/watch/one",
      requestUrl: "https://youtube.test/playlist",
      playlistTitle: "Album",
      playlistIndex: 1,
    },
  },
];

test("syncYoutubeToYoto composes probe, download, and upload without coupling them", async () => {
  const calls: string[] = [];
  let uploadedTracks: LocalTrack[] | undefined;
  let observedProbeTitle = "";
  const dependencies: SyncDependencies = {
    probe: async (url, binary) => {
      calls.push(`probe:${url}:${binary}`);
      return { kind: "playlist", title: "Album", count: 1 };
    },
    download: async (options) => {
      calls.push(`download:${options.url}`);
      assert.equal(options.manifest, manifest);
      return { tracks, downloadedCount: 1, skipped: false };
    },
    upload: async (options) => {
      calls.push(`upload:${options.title}`);
      uploadedTracks = options.tracks;
      return { cardId: "Ab123", title: options.title };
    },
  };

  const result = await syncYoutubeToYoto(
    {
      url: "https://youtube.test/playlist",
      config,
      manifest,
      getAccessToken: async () => "token",
      onProbe: (probe) => {
        observedProbeTitle = probe.title;
      },
    },
    dependencies,
  );

  assert.deepEqual(calls, [
    "probe:https://youtube.test/playlist:yt-dlp",
    "download:https://youtube.test/playlist",
    "upload:Album",
  ]);
  assert.equal(uploadedTracks, tracks);
  assert.equal(observedProbeTitle, "Album");
  assert.equal(result.content.cardId, "Ab123");
});

test("syncYoutubeToYoto supports an explicit playlist title", async () => {
  let uploadedTitle = "";
  const dependencies: SyncDependencies = {
    probe: async () => ({ kind: "single", title: "Video title", count: 0 }),
    download: async () => ({ tracks, downloadedCount: 0, skipped: true }),
    upload: async (options) => {
      uploadedTitle = options.title;
      return { cardId: "Ab123", title: options.title };
    },
  };
  await syncYoutubeToYoto(
    {
      url: "https://youtube.test/video",
      title: "Custom title",
      config,
      manifest,
      getAccessToken: async () => "token",
    },
    dependencies,
  );
  assert.equal(uploadedTitle, "Custom title");
});

test("syncYoutubeToYoto does not call Yoto when no local tracks are available", async () => {
  let uploadCalled = false;
  const dependencies: SyncDependencies = {
    probe: async () => ({ kind: "playlist", title: "Missing", count: 2 }),
    download: async () => ({ tracks: [], downloadedCount: 0, skipped: true }),
    upload: async () => {
      uploadCalled = true;
      return { cardId: "unused", title: "unused" };
    },
  };
  await assert.rejects(
    syncYoutubeToYoto(
      {
        url: "https://youtube.test/missing",
        config,
        manifest,
        getAccessToken: async () => "token",
      },
      dependencies,
    ),
    /No local MP3 tracks/,
  );
  assert.equal(uploadCalled, false);
});
