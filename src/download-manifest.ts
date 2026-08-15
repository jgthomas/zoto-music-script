import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalTrack } from "./tracks.ts";

interface ManifestData {
  version: 1;
  tracks: LocalTrack[];
}

function isLocalTrack(value: unknown): value is LocalTrack {
  if (!value || typeof value !== "object") return false;
  const track = value as Partial<LocalTrack>;
  return (
    typeof track.filePath === "string" &&
    typeof track.title === "string" &&
    typeof track.order === "number"
  );
}

export class DownloadManifest {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async read(): Promise<ManifestData> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        (value as { version?: unknown }).version !== 1 ||
        !Array.isArray((value as { tracks?: unknown }).tracks) ||
        !(value as { tracks: unknown[] }).tracks.every(isLocalTrack)
      ) {
        throw new Error("download manifest is invalid");
      }
      return value as ManifestData;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { version: 1, tracks: [] };
      }
      if (error instanceof SyntaxError) throw new Error("download manifest is invalid");
      throw error;
    }
  }

  async tracksForRequest(requestUrl: string): Promise<LocalTrack[]> {
    const data = await this.read();
    const candidates = data.tracks.filter(
      (track) => track.source?.kind === "youtube" && track.source.requestUrl === requestUrl,
    );
    const existing: LocalTrack[] = [];
    for (const track of candidates) {
      try {
        await access(track.filePath);
        existing.push(track);
      } catch {
        // A manifest entry is only useful while its local MP3 still exists.
      }
    }
    return existing.sort((left, right) => left.order - right.order);
  }

  async record(tracks: LocalTrack[]): Promise<void> {
    if (tracks.length === 0) return;
    const data = await this.read();
    const replacements = new Map(
      tracks
        .filter((track) => track.source?.kind === "youtube")
        .map((track) => [`${track.source?.requestUrl}\0${track.source?.id}`, track]),
    );
    const retained = data.tracks.filter((track) => {
      if (track.source?.kind !== "youtube") return true;
      return !replacements.has(`${track.source.requestUrl}\0${track.source.id}`);
    });
    const next: ManifestData = { version: 1, tracks: [...retained, ...tracks] };
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
