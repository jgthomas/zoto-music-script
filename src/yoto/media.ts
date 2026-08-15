import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { LocalTrack } from "../tracks.ts";

const API_URL = "https://api.yotoplay.com";

export interface TranscodedInfo {
  duration: number;
  fileSize: number;
  channels?: "stereo" | "mono";
  format: string;
  metadata?: { title?: string };
}

export interface TranscodedAudio {
  transcodedSha256: string;
  transcodedInfo: TranscodedInfo;
}

export interface CreatedContent {
  cardId: string;
  title: string;
}

export interface UploadCallbacks {
  onStatus?: (status: string) => void;
}

export interface UploadOptions {
  filePath: string;
  title: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxPollAttempts?: number;
  callbacks?: UploadCallbacks;
}

export interface PlaylistUploadOptions {
  tracks: LocalTrack[];
  title: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxPollAttempts?: number;
  callbacks?: UploadCallbacks;
}

interface UploadedTrack {
  track: LocalTrack;
  audio: TranscodedAudio;
}

interface UploadUrlResponse {
  upload?: { uploadUrl?: string | null; uploadId?: string };
}

interface TranscodeResponse {
  transcode?: Partial<TranscodedAudio>;
}

interface CreateContentResponse {
  card?: { cardId?: string; title?: string };
}

async function responseError(response: Response, operation: string): Promise<Error> {
  const detail = (await response.text()).trim();
  return new Error(`${operation} failed (${response.status})${detail ? `: ${detail}` : ""}`);
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("base64url")));
  });
}

function normalizeChannels(value: unknown): "stereo" | "mono" | undefined {
  if (value === "stereo" || value === 2) return "stereo";
  if (value === "mono" || value === 1) return "mono";
  return undefined;
}

function validateTranscodedAudio(value: Partial<TranscodedAudio>): TranscodedAudio | null {
  if (!value.transcodedSha256 || !value.transcodedInfo) return null;
  const info = value.transcodedInfo;
  if (
    typeof info.duration !== "number" ||
    typeof info.fileSize !== "number" ||
    typeof info.format !== "string"
  ) {
    throw new Error("Yoto returned invalid transcoded media information");
  }
  return {
    transcodedSha256: value.transcodedSha256,
    transcodedInfo: { ...info, channels: normalizeChannels(info.channels) },
  };
}

async function requestUploadUrl(
  options: PlaylistUploadOptions,
  filePath: string,
  sourceSha256: string,
): Promise<{ uploadUrl: string | null; uploadId: string }> {
  const url = new URL("/media/transcode/audio/uploadUrl", API_URL);
  url.searchParams.set("sha256", sourceSha256);
  url.searchParams.set("filename", path.basename(filePath));
  const response = await (options.fetch ?? fetch)(url, {
    headers: {
      Authorization: `Bearer ${await options.getAccessToken()}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) throw await responseError(response, "Requesting a Yoto upload URL");
  const result = (await response.json()) as UploadUrlResponse;
  if (!result.upload?.uploadId || result.upload.uploadUrl === undefined) {
    throw new Error("Yoto did not return a usable upload destination");
  }
  return { uploadUrl: result.upload.uploadUrl, uploadId: result.upload.uploadId };
}

async function uploadFile(
  options: PlaylistUploadOptions,
  filePath: string,
  uploadUrl: string,
): Promise<void> {
  const blob = await openAsBlob(filePath, { type: "audio/mpeg" });
  const response = await (options.fetch ?? fetch)(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "audio/mpeg" },
    body: blob,
  });
  if (!response.ok) throw await responseError(response, "Uploading audio to Yoto");
}

async function waitForTranscode(
  options: PlaylistUploadOptions,
  uploadId: string,
): Promise<TranscodedAudio> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxAttempts = options.maxPollAttempts ?? 120;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = new URL(`/media/upload/${encodeURIComponent(uploadId)}/transcoded`, API_URL);
    url.searchParams.set("loudnorm", "false");
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${await options.getAccessToken()}`,
        Accept: "application/json",
      },
    });
    if (response.ok) {
      const result = (await response.json()) as TranscodeResponse;
      const transcoded = validateTranscodedAudio(result.transcode ?? {});
      if (transcoded) return transcoded;
    } else if (response.status !== 404 && response.status !== 429 && response.status < 500) {
      throw await responseError(response, "Checking Yoto transcoding");
    }

    if (attempt + 1 < maxAttempts) {
      const delay = Math.min(500 * 1.5 ** attempt, 5_000);
      await sleep(delay);
    }
  }
  throw new Error("Yoto transcoding timed out");
}

export function buildPlaylistContent(title: string, uploadedTracks: UploadedTrack[]): object {
  if (uploadedTracks.length === 0) throw new Error("Cannot build an empty Yoto playlist");
  const keyWidth = Math.max(2, String(uploadedTracks.length).length);
  const chapters = uploadedTracks.map(({ track, audio }, index) => {
    const info = audio.transcodedInfo;
    const key = String(index + 1).padStart(keyWidth, "0");
    const overlayLabel = String(index + 1);
    return {
      key,
      title: track.title,
      overlayLabel,
      ambient: null,
      availableFrom: null,
      defaultTrackAmbient: null,
      defaultTrackDisplay: null,
      duration: info.duration,
      fileSize: info.fileSize,
      display: { icon16x16: null },
      tracks: [
        {
          key,
          uid: "",
          title: track.title,
          trackUrl: `yoto:#${audio.transcodedSha256}`,
          duration: info.duration,
          fileSize: info.fileSize,
          channels: info.channels,
          format: info.format,
          type: "audio",
          overlayLabel,
          ambient: null,
          display: null,
        },
      ],
    };
  });
  const duration = uploadedTracks.reduce((total, item) => total + item.audio.transcodedInfo.duration, 0);
  const fileSize = uploadedTracks.reduce((total, item) => total + item.audio.transcodedInfo.fileSize, 0);
  return {
    title,
    content: {
      chapters,
      config: { resumeTimeout: 2_592_000 },
      playbackType: "linear",
    },
    metadata: {
      category: "music",
      media: { duration, fileSize },
    },
  };
}

export function buildSingleTrackContent(title: string, audio: TranscodedAudio): object {
  return buildPlaylistContent(title, [
    { track: { filePath: "", title, order: 1 }, audio },
  ]);
}

async function createContent(
  options: PlaylistUploadOptions,
  uploadedTracks: UploadedTrack[],
): Promise<CreatedContent> {
  const response = await (options.fetch ?? fetch)(new URL("/content", API_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await options.getAccessToken()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildPlaylistContent(options.title, uploadedTracks)),
  });
  if (!response.ok) throw await responseError(response, "Creating Yoto content");
  const result = (await response.json()) as CreateContentResponse;
  if (!result.card?.cardId) throw new Error("Yoto did not return a content ID");
  return { cardId: result.card.cardId, title: result.card.title ?? options.title };
}

export async function uploadSingleTrack(options: UploadOptions): Promise<CreatedContent> {
  return uploadPlaylist({
    ...options,
    tracks: [{ filePath: options.filePath, title: options.title, order: 1 }],
  });
}

export async function uploadPlaylist(options: PlaylistUploadOptions): Promise<CreatedContent> {
  if (options.tracks.length === 0) throw new Error("At least one local track is required");
  const tracks = [...options.tracks].sort((left, right) => left.order - right.order);
  for (const track of tracks) {
    const file = await stat(track.filePath);
    if (!file.isFile()) throw new Error(`Not a file: ${track.filePath}`);
    if (path.extname(track.filePath).toLowerCase() !== ".mp3") {
      throw new Error(`Only MP3 files are currently supported: ${track.filePath}`);
    }
  }

  const uploadedTracks: UploadedTrack[] = [];
  for (const [index, track] of tracks.entries()) {
    const prefix = `[${index + 1}/${tracks.length}] ${track.title}:`;
    options.callbacks?.onStatus?.(`${prefix} hashing audio`);
    const sourceSha256 = await sha256File(track.filePath);
    options.callbacks?.onStatus?.(`${prefix} requesting upload`);
    const upload = await requestUploadUrl(options, track.filePath, sourceSha256);
    if (upload.uploadUrl) {
      options.callbacks?.onStatus?.(`${prefix} uploading audio`);
      await uploadFile(options, track.filePath, upload.uploadUrl);
    } else {
      options.callbacks?.onStatus?.(`${prefix} already exists in Yoto media storage`);
    }
    options.callbacks?.onStatus?.(`${prefix} waiting for transcoding`);
    const audio = await waitForTranscode(options, upload.uploadId);
    uploadedTracks.push({ track, audio });
  }
  options.callbacks?.onStatus?.("creating MYO playlist");
  return createContent(options, uploadedTracks);
}
