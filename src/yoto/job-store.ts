import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalTrack } from "../tracks.ts";
import type { TranscodedAudio } from "./media.ts";

export interface UploadJobTrack {
  key: string;
  filePath: string;
  title: string;
  order: number;
  size: number;
  mtimeMs: number;
  sourceSha256?: string;
  uploadId?: string;
  audio?: TranscodedAudio;
}

export interface UploadJob {
  key: string;
  title: string;
  cardId?: string;
  completed: boolean;
  creating?: boolean;
  tracks: UploadJobTrack[];
  updatedAt: string;
}

interface StoredJob {
  version: 1;
  job: UploadJob;
}

function isJobTrack(value: unknown): value is UploadJobTrack {
  if (!value || typeof value !== "object") return false;
  const track = value as Partial<UploadJobTrack>;
  return (
    typeof track.key === "string" &&
    typeof track.filePath === "string" &&
    typeof track.title === "string" &&
    typeof track.order === "number" &&
    typeof track.size === "number" &&
    typeof track.mtimeMs === "number"
  );
}

function isJob(value: unknown): value is UploadJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<UploadJob>;
  return (
    typeof job.key === "string" &&
    typeof job.title === "string" &&
    typeof job.completed === "boolean" &&
    (job.creating === undefined || typeof job.creating === "boolean") &&
    Array.isArray(job.tracks) &&
    job.tracks.every(isJobTrack) &&
    typeof job.updatedAt === "string"
  );
}

export function uploadTrackKey(track: LocalTrack): string {
  return track.source?.kind === "youtube"
    ? `youtube:${track.source.id}`
    : `file:${path.resolve(track.filePath)}`;
}

export class UploadJobStore {
  readonly directoryPath: string;

  constructor(directoryPath: string) {
    this.directoryPath = directoryPath;
  }

  private jobPath(key: string): string {
    const fileName = createHash("sha256").update(key).digest("base64url");
    return path.join(this.directoryPath, `${fileName}.json`);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
    await chmod(this.directoryPath, 0o700);
  }

  async get(key: string): Promise<UploadJob | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.jobPath(key), "utf8"));
      if (!value || typeof value !== "object") throw new Error("upload job is invalid");
      const stored = value as Partial<StoredJob>;
      if (stored.version !== 1 || !isJob(stored.job) || stored.job.key !== key) {
        throw new Error("upload job is invalid");
      }
      return stored.job;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      if (error instanceof SyntaxError) throw new Error("upload job is invalid");
      throw error;
    }
  }

  async put(job: UploadJob): Promise<void> {
    await this.ensureDirectory();
    const destinationPath = this.jobPath(job.key);
    const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const stored: StoredJob = { version: 1, job };
      await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, destinationPath);
      await chmod(destinationPath, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.jobPath(key), { force: true });
  }
}
