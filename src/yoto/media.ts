import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

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
  options: UploadOptions,
  sourceSha256: string,
): Promise<{ uploadUrl: string | null; uploadId: string }> {
  const url = new URL("/media/transcode/audio/uploadUrl", API_URL);
  url.searchParams.set("sha256", sourceSha256);
  url.searchParams.set("filename", path.basename(options.filePath));
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

async function uploadFile(options: UploadOptions, uploadUrl: string): Promise<void> {
  const blob = await openAsBlob(options.filePath, { type: "audio/mpeg" });
  const response = await (options.fetch ?? fetch)(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "audio/mpeg" },
    body: blob,
  });
  if (!response.ok) throw await responseError(response, "Uploading audio to Yoto");
}

async function waitForTranscode(
  options: UploadOptions,
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

export function buildSingleTrackContent(title: string, audio: TranscodedAudio): object {
  const info = audio.transcodedInfo;
  const trackTitle = info.metadata?.title?.trim() || title;
  return {
    title,
    content: {
      chapters: [
        {
          key: "01",
          title: trackTitle,
          overlayLabel: "1",
          ambient: null,
          availableFrom: null,
          defaultTrackAmbient: null,
          defaultTrackDisplay: null,
          duration: info.duration,
          fileSize: info.fileSize,
          display: { icon16x16: null },
          tracks: [
            {
              key: "01",
              uid: "",
              title: trackTitle,
              trackUrl: `yoto:#${audio.transcodedSha256}`,
              duration: info.duration,
              fileSize: info.fileSize,
              channels: info.channels,
              format: info.format,
              type: "audio",
              overlayLabel: "1",
              ambient: null,
              display: null,
            },
          ],
        },
      ],
      config: { resumeTimeout: 2_592_000 },
      playbackType: "linear",
    },
    metadata: {
      category: "music",
      media: { duration: info.duration, fileSize: info.fileSize },
    },
  };
}

async function createContent(
  options: UploadOptions,
  audio: TranscodedAudio,
): Promise<CreatedContent> {
  const response = await (options.fetch ?? fetch)(new URL("/content", API_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await options.getAccessToken()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSingleTrackContent(options.title, audio)),
  });
  if (!response.ok) throw await responseError(response, "Creating Yoto content");
  const result = (await response.json()) as CreateContentResponse;
  if (!result.card?.cardId) throw new Error("Yoto did not return a content ID");
  return { cardId: result.card.cardId, title: result.card.title ?? options.title };
}

export async function uploadSingleTrack(options: UploadOptions): Promise<CreatedContent> {
  const file = await stat(options.filePath);
  if (!file.isFile()) throw new Error(`Not a file: ${options.filePath}`);
  if (path.extname(options.filePath).toLowerCase() !== ".mp3") {
    throw new Error("Phase 2 currently supports MP3 files only");
  }

  options.callbacks?.onStatus?.("hashing audio");
  const sourceSha256 = await sha256File(options.filePath);
  options.callbacks?.onStatus?.("requesting upload");
  const upload = await requestUploadUrl(options, sourceSha256);
  if (upload.uploadUrl) {
    options.callbacks?.onStatus?.("uploading audio");
    await uploadFile(options, upload.uploadUrl);
  } else {
    options.callbacks?.onStatus?.("audio already exists in Yoto media storage");
  }
  options.callbacks?.onStatus?.("waiting for transcoding");
  const transcoded = await waitForTranscode(options, upload.uploadId);
  options.callbacks?.onStatus?.("creating MYO playlist");
  return createContent(options, transcoded);
}
