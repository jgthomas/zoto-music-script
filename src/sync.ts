import type { Config } from "./config.ts";
import { downloadVideo, type DownloadCallbacks, type DownloadResult } from "./download.ts";
import type { DownloadManifest } from "./download-manifest.ts";
import type { UploadJobStore } from "./yoto/job-store.ts";
import { probeUrl, type ProbeResult } from "./probe.ts";
import {
  uploadPlaylist,
  type CreatedContent,
  type UploadCallbacks,
} from "./yoto/media.ts";

export interface SyncOptions {
  url: string;
  title?: string;
  config: Config;
  manifest: DownloadManifest;
  getAccessToken: () => Promise<string>;
  downloadCallbacks?: DownloadCallbacks;
  uploadCallbacks?: UploadCallbacks;
  onProbe?: (probe: ProbeResult) => void;
  jobStore?: UploadJobStore;
  jobKey?: string;
  restart?: boolean;
  newCopy?: boolean;
  retryCreate?: boolean;
}

export interface SyncResult {
  probe: ProbeResult;
  download: DownloadResult;
  content: CreatedContent;
}

export interface SyncDependencies {
  probe: typeof probeUrl;
  download: typeof downloadVideo;
  upload: typeof uploadPlaylist;
}

const defaultDependencies: SyncDependencies = {
  probe: probeUrl,
  download: downloadVideo,
  upload: uploadPlaylist,
};

export async function syncYoutubeToYoto(
  options: SyncOptions,
  dependencies: SyncDependencies = defaultDependencies,
): Promise<SyncResult> {
  const probe = await dependencies.probe(options.url, options.config.ytDlpBin);
  options.onProbe?.(probe);
  const download = await dependencies.download({
    url: options.url,
    probe,
    config: options.config,
    manifest: options.manifest,
    callbacks: options.downloadCallbacks,
  });
  if (download.tracks.length === 0) {
    throw new Error("No local MP3 tracks are available to upload to Yoto");
  }

  const content = await dependencies.upload({
    tracks: download.tracks,
    title: options.title?.trim() || probe.title,
    getAccessToken: options.getAccessToken,
    callbacks: options.uploadCallbacks,
    jobStore: options.jobStore,
    jobKey: options.jobKey,
    restart: options.restart,
    newCopy: options.newCopy,
    retryCreate: options.retryCreate,
  });
  return { probe, download, content };
}
