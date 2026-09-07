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
  try {
    const value: unknown = JSON.parse(line.replace(/([:,])NA(?=,|})/g, "$1null"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const fields = value as {
      playlist?: unknown;
      playlistTitle?: unknown;
      count?: unknown;
      title?: unknown;
    };
    const isPlaylist = typeof fields.playlist === "string" && fields.playlist.length > 0;

    return {
      kind: isPlaylist ? "playlist" : "single",
      title: isPlaylist
        ? typeof fields.playlistTitle === "string"
          ? fields.playlistTitle
          : ""
        : typeof fields.title === "string"
          ? fields.title
          : "",
      count: typeof fields.count === "number" && Number.isFinite(fields.count) ? fields.count : 0,
    };
  } catch {
    return { kind: "single", title: "", count: 0 };
  }
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
        '{"playlist":%(playlist)j,"playlistTitle":%(playlist_title)j,"count":%(playlist_count)j,"title":%(title)j}',
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
