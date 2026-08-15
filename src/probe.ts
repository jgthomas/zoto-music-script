import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  kind: "single" | "playlist";
  title: string;
  count: number;
}

export function parseProbeOutput(stdout: string): ProbeResult {
  const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const [playlist, playlistTitle, countStr, videoTitle] = line.split("|");
  const isPlaylist = playlist !== undefined && playlist !== "" && playlist !== "NA";

  return {
    kind: isPlaylist ? "playlist" : "single",
    title: isPlaylist ? (playlistTitle ?? "") : (videoTitle ?? ""),
    count: Number(countStr) || 0,
  };
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error.message;
}

export async function probeUrl(url: string, ytDlpBin: string): Promise<ProbeResult> {
  try {
    const { stdout } = await execFileAsync(
      ytDlpBin,
      [
        "--flat-playlist",
        "--print",
        "%(playlist)s|%(playlist_title)s|%(playlist_count)s|%(title)s",
        "--no-warnings",
        "--",
        url,
      ],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
    );

    const result = parseProbeOutput(stdout);
    if (!result.title) throw new Error("yt-dlp returned no usable metadata");
    return result;
  } catch (error) {
    throw new Error(`Could not inspect URL with yt-dlp:\n${errorText(error)}`, { cause: error });
  }
}
