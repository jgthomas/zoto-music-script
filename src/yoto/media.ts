import { createHash, randomUUID } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { stat, access } from "node:fs/promises";
import path from "node:path";
import type { LocalTrack } from "../tracks.ts";
import {
  type UploadJob,
  type UploadJobTrack,
  type UploadJobStore,
  uploadTrackKey,
} from "./job-store.ts";

import { request, responseError, readJson, retryAfterMs } from "./request.ts";
import { localError } from "../local-errors.ts";

import { checkUploadRecovery } from "./recovery.ts";

const API_URL = "https://api.yotoplay.com";

interface TranscodedInfo {
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
  operation?: "created" | "updated" | "unchanged";
  jobKey?: string;
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
  jobStore?: UploadJobStore;
  jobKey?: string;
  restart?: boolean;
  newCopy?: boolean;
  retryCreate?: boolean;
}

interface UploadedTrack {
  track: LocalTrack;
  audio: TranscodedAudio;
}

interface PreparedTrack extends UploadJobTrack {
  track: LocalTrack;
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

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", (error) => reject(localError(error, "Hashing MP3", filePath)));
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Yoto returned invalid transcoded media information");
  }
  if (value.transcodedSha256 === undefined || value.transcodedSha256 === null) return null;
  if (
    typeof value.transcodedSha256 !== "string" ||
    !value.transcodedSha256 ||
    !value.transcodedInfo
  ) {
    throw new Error("Yoto returned invalid transcoded media information");
  }
  const info = value.transcodedInfo;
  if (
    !Number.isFinite(info.duration) ||
    info.duration <= 0 ||
    !Number.isFinite(info.fileSize) ||
    info.fileSize <= 0 ||
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
  const response = await request(
    options.fetch ?? fetch,
    url,
    {
      headers: {
        Authorization: `Bearer ${await options.getAccessToken()}`,
        Accept: "application/json",
      },
    },
    `Requesting upload for ${path.basename(filePath)}`,
  );
  if (!response.ok)
    throw await responseError(
      response,
      `Requesting a Yoto upload URL for ${path.basename(filePath)}`,
    );
  const result = await readJson<UploadUrlResponse>(response, "Requesting upload");
  if (
    typeof result.upload?.uploadId !== "string" ||
    !result.upload.uploadId ||
    (result.upload.uploadUrl !== null &&
      (typeof result.upload.uploadUrl !== "string" || !result.upload.uploadUrl))
  ) {
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
  const response = await request(
    options.fetch ?? fetch,
    uploadUrl,
    {
      method: "PUT",
      headers: { "Content-Type": "audio/mpeg" },
      body: blob,
    },
    `Uploading ${path.basename(filePath)}`,
    10 * 60_000,
  );
  if (!response.ok)
    throw await responseError(response, `Uploading audio to Yoto: ${path.basename(filePath)}`);
}

async function waitForTranscode(
  options: PlaylistUploadOptions,
  uploadId: string,
): Promise<TranscodedAudio> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxAttempts = options.maxPollAttempts ?? 120;

  const deadline = Date.now() + 10 * 60_000;
  let lastStatus = "processing is still pending";
  for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt++) {
    const url = new URL(`/media/upload/${encodeURIComponent(uploadId)}/transcoded`, API_URL);
    url.searchParams.set("loudnorm", "false");
    const response = await request(
      fetchImpl,
      url,
      {
        headers: {
          Authorization: `Bearer ${await options.getAccessToken()}`,
          Accept: "application/json",
        },
      },
      "Checking Yoto transcoding",
      Math.min(30_000, Math.max(1, deadline - Date.now())),
    );
    lastStatus = response.ok
      ? "processing is still pending"
      : `last HTTP status was ${response.status}`;
    if (response.ok) {
      const result = await readJson<TranscodeResponse>(response, "Checking transcoding");
      const transcoded = validateTranscodedAudio(result.transcode ?? {});
      if (transcoded) return transcoded;
    } else if (response.status !== 404 && response.status !== 429 && response.status < 500) {
      throw await responseError(response, "Checking Yoto transcoding");
    }

    if (attempt + 1 < maxAttempts) {
      const delay = Math.min(500 * 1.5 ** attempt, 5_000);
      const wait = Math.max(delay, retryAfterMs(response) ?? 0);
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
    }
  }
  throw new Error(
    `Yoto transcoding timed out: ${lastStatus}. Saved upload progress is retained; rerun the same command later to resume polling.`,
  );
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
  const duration = uploadedTracks.reduce(
    (total, item) => total + item.audio.transcodedInfo.duration,
    0,
  );
  const fileSize = uploadedTracks.reduce(
    (total, item) => total + item.audio.transcodedInfo.fileSize,
    0,
  );
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
  return buildPlaylistContent(title, [{ track: { filePath: "", title, order: 1 }, audio }]);
}

async function createContent(
  options: PlaylistUploadOptions,
  uploadedTracks: UploadedTrack[],
  cardId?: string,
): Promise<CreatedContent> {
  const content = buildPlaylistContent(options.title, uploadedTracks) as Record<string, unknown>;
  if (cardId) content.cardId = cardId;
  const response = await request(
    options.fetch ?? fetch,
    new URL("/content", API_URL),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await options.getAccessToken()}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(content),
    },
    cardId ? "Updating Yoto content" : "Creating Yoto content",
  );
  if (!response.ok) {
    const operation = cardId ? `Updating Yoto content ${cardId}` : "Creating Yoto content";
    const error = await responseError(response, operation);
    if (cardId && (response.status === 404 || error.deleted)) {
      throw new Error(
        `${error.message}. If the remote content was deleted, retry with --new-copy.`,
      );
    }
    throw error;
  }
  const result = await readJson<CreateContentResponse>(response, "Saving playlist");
  if (typeof result.card?.cardId !== "string" || !result.card.cardId)
    throw new Error(
      "Yoto did not return a content ID; check your library before retrying creation.",
    );
  return {
    cardId: result.card.cardId,
    title: result.card.title ?? options.title,
    operation: cardId ? "updated" : "created",
  };
}

export async function uploadSingleTrack(options: UploadOptions): Promise<CreatedContent> {
  return uploadPlaylist({
    ...options,
    tracks: [{ filePath: options.filePath, title: options.title, order: 1 }],
  });
}

export async function uploadPlaylist(options: PlaylistUploadOptions): Promise<CreatedContent> {
  if (options.tracks.length === 0) throw new Error("At least one local track is required");
  if ((options.jobStore && !options.jobKey) || (!options.jobStore && options.jobKey)) {
    throw new Error("Upload jobStore and jobKey must be provided together");
  }
  const tracks = [...options.tracks].sort((left, right) => left.order - right.order);
  const preparedTracks: PreparedTrack[] = [];
  for (const track of tracks) {
    const file = await stat(track.filePath).catch((error) => {
      throw localError(error, "Inspecting MP3", track.filePath);
    });
    await access(track.filePath, 4).catch((error) => {
      throw localError(error, "Reading MP3", track.filePath);
    });
    if (file.size === 0) throw new Error(`MP3 file is empty: ${track.filePath}`);
    if (!file.isFile()) throw new Error(`Not a file: ${track.filePath}`);
    if (path.extname(track.filePath).toLowerCase() !== ".mp3") {
      throw new Error(`Only MP3 files are currently supported: ${track.filePath}`);
    }
    preparedTracks.push({
      key: uploadTrackKey(track),
      filePath: track.filePath,
      title: track.title,
      order: track.order,
      size: file.size,
      mtimeMs: file.mtimeMs,
      track,
    });
  }

  const incompleteCopy =
    options.newCopy && options.jobStore && options.jobKey
      ? await options.jobStore.findIncompleteCopy(options.jobKey)
      : null;
  const effectiveJobKey = options.newCopy
    ? (incompleteCopy?.key ?? `${options.jobKey ?? "upload"}#${randomUUID()}`)
    : options.jobKey;
  await checkUploadRecovery({
    jobStore: options.jobStore,
    jobKey: effectiveJobKey,
    retryCreate: options.retryCreate,
  });
  let existingJob =
    options.jobStore && effectiveJobKey ? await options.jobStore.get(effectiveJobKey) : null;
  if (options.restart && existingJob) {
    options.callbacks?.onStatus?.("restarting cached upload work");
    existingJob = { ...existingJob, completed: false, tracks: [] };
  }
  const cachedByKey = new Map(existingJob?.tracks.map((track) => [track.key, track]) ?? []);
  for (const prepared of preparedTracks) {
    const cached = cachedByKey.get(prepared.key);
    if (cached && cached.size === prepared.size && cached.mtimeMs === prepared.mtimeMs) {
      options.callbacks?.onStatus?.(`${prepared.title}: verifying cached audio hash`);
      prepared.sourceSha256 = await sha256File(prepared.filePath);
      if (cached.sourceSha256 === prepared.sourceSha256) {
        prepared.uploadId = cached.uploadId;
        prepared.audio = cached.audio;
      }
    }
  }

  const unchanged =
    existingJob?.completed === true &&
    existingJob.cardId !== undefined &&
    existingJob.title === options.title &&
    existingJob.tracks.length === preparedTracks.length &&
    preparedTracks.every((track, index) => {
      const previous = existingJob?.tracks[index];
      return (
        previous?.key === track.key &&
        previous.title === track.title &&
        previous.order === track.order &&
        previous.size === track.size &&
        previous.mtimeMs === track.mtimeMs &&
        track.sourceSha256 === previous.sourceSha256 &&
        track.audio !== undefined &&
        previous.audio !== undefined
      );
    });
  if (unchanged && existingJob?.cardId) {
    options.callbacks?.onStatus?.("playlist is already up to date");
    return {
      cardId: existingJob.cardId,
      title: existingJob.title,
      operation: "unchanged",
      ...(effectiveJobKey ? { jobKey: effectiveJobKey } : {}),
    };
  }

  let creating = existingJob?.creating ?? false;
  const checkpoint = async (completed: boolean, cardId = existingJob?.cardId) => {
    if (!options.jobStore || !effectiveJobKey) return;
    const job: UploadJob = {
      key: effectiveJobKey,
      title: options.title,
      ...(cardId ? { cardId } : {}),
      ...(options.newCopy && options.jobKey ? { copyOf: options.jobKey } : {}),
      completed,
      creating: completed ? false : creating,
      tracks: preparedTracks.map((prepared) => ({
        key: prepared.key,
        filePath: prepared.filePath,
        title: prepared.title,
        order: prepared.order,
        size: prepared.size,
        mtimeMs: prepared.mtimeMs,
        ...(prepared.sourceSha256 ? { sourceSha256: prepared.sourceSha256 } : {}),
        ...(prepared.uploadId ? { uploadId: prepared.uploadId } : {}),
        ...(prepared.audio ? { audio: prepared.audio } : {}),
      })),
      updatedAt: new Date().toISOString(),
    };
    await options.jobStore.put(job);
  };

  const uploadedTracks: UploadedTrack[] = [];
  for (const [index, prepared] of preparedTracks.entries()) {
    const { track } = prepared;
    const prefix = `[${index + 1}/${tracks.length}] ${track.title}:`;
    if (prepared.audio) {
      options.callbacks?.onStatus?.(`${prefix} reusing completed transcode`);
      uploadedTracks.push({ track, audio: prepared.audio });
      continue;
    }
    if (!prepared.sourceSha256) {
      options.callbacks?.onStatus?.(`${prefix} hashing audio`);
      prepared.sourceSha256 = await sha256File(track.filePath);
      await checkpoint(false);
    } else {
      options.callbacks?.onStatus?.(`${prefix} reusing cached source hash`);
    }
    if (!prepared.uploadId) {
      options.callbacks?.onStatus?.(`${prefix} requesting upload`);
      const upload = await requestUploadUrl(options, track.filePath, prepared.sourceSha256);
      if (upload.uploadUrl) {
        options.callbacks?.onStatus?.(`${prefix} uploading audio`);
        await uploadFile(options, track.filePath, upload.uploadUrl);
      } else {
        options.callbacks?.onStatus?.(`${prefix} already exists in Yoto media storage`);
      }
      prepared.uploadId = upload.uploadId;
      await checkpoint(false);
    } else {
      options.callbacks?.onStatus?.(`${prefix} resuming pending transcode`);
    }
    options.callbacks?.onStatus?.(`${prefix} waiting for transcoding`);
    const audio = await waitForTranscode(options, prepared.uploadId).catch((error) => {
      throw new Error(`${prefix} ${error instanceof Error ? error.message : "Transcoding failed"}`);
    });
    prepared.audio = audio;
    uploadedTracks.push({ track, audio });
    await checkpoint(false);
  }
  const existingCardId = options.newCopy ? undefined : existingJob?.cardId;
  options.callbacks?.onStatus?.(existingCardId ? "updating MYO playlist" : "creating MYO playlist");
  if (!existingCardId) {
    creating = true;
    await checkpoint(false);
  }
  const result = await createContent(options, uploadedTracks, existingCardId);
  try {
    await checkpoint(true, result.cardId);
  } catch (error) {
    throw new Error(
      `Yoto content ${result.cardId} was saved, but its local checkpoint failed. Keep this content ID; ` +
        "do not retry creation. " +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  return { ...result, ...(effectiveJobKey ? { jobKey: effectiveJobKey } : {}) };
}
