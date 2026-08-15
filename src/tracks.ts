import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseFile } from "music-metadata";

export interface YouTubeTrackSource {
  kind: "youtube";
  id: string;
  url: string;
  requestUrl: string;
  playlistTitle?: string;
  playlistIndex?: number;
}

export interface LocalTrack {
  filePath: string;
  title: string;
  order: number;
  source?: YouTubeTrackSource;
}

const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function titleFromFilename(filePath: string): string {
  const basename = path.basename(filePath, path.extname(filePath));
  return basename.replace(/^\s*\d+\s*[-._)]\s*/, "").trim() || basename;
}

async function titleForTrack(filePath: string): Promise<string> {
  try {
    const metadata = await parseFile(filePath, { duration: false, skipCovers: true });
    const embeddedTitle = metadata.common.title?.trim();
    if (embeddedTitle) return embeddedTitle;
  } catch {
    // Invalid or incomplete metadata should not make an otherwise usable MP3
    // undiscoverable. Yoto will validate the audio during upload.
  }
  return titleFromFilename(filePath);
}

export async function discoverLocalTracks(inputs: string[]): Promise<LocalTrack[]> {
  if (inputs.length === 0) throw new Error("At least one MP3 file or directory is required");
  const files: string[] = [];

  for (const input of inputs) {
    const resolved = path.resolve(input);
    let details;
    try {
      details = await stat(resolved);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new Error(`File or directory does not exist: ${resolved}`);
      }
      throw error;
    }
    if (details.isDirectory()) {
      const entries = await readdir(resolved, { withFileTypes: true });
      const mp3s = entries
        .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp3")
        .map((entry) => path.join(resolved, entry.name))
        .sort((left, right) => naturalOrder.compare(path.basename(left), path.basename(right)));
      files.push(...mp3s);
    } else if (details.isFile() && path.extname(resolved).toLowerCase() === ".mp3") {
      files.push(resolved);
    } else {
      throw new Error(`Not an MP3 file or directory: ${resolved}`);
    }
  }

  if (files.length === 0) throw new Error("No MP3 files were found");
  return Promise.all(
    files.map(async (filePath, index) => ({
      filePath,
      title: await titleForTrack(filePath),
      order: index + 1,
    })),
  );
}
