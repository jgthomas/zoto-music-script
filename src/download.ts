import { spawn } from "node:child_process";
import path from "node:path";
import type { Config } from "./config.ts";
import type { DownloadManifest } from "./download-manifest.ts";
import type { ProbeResult } from "./probe.ts";
import { parseProgressLine, renderProgressLine, type ProgressData } from "./progress.ts";
import type { LocalTrack } from "./tracks.ts";

export interface DownloadCallbacks {
  onTitle?: (title: string) => void;
  onProgress?: (rendered: string) => void;
  onStatus?: (text: string) => void;
  onDiagnostic?: (text: string) => void;
}

export interface DownloadResult {
  tracks: LocalTrack[];
  downloadedCount: number;
  skipped: boolean;
}

export interface DownloadOptions {
  url: string;
  probe: ProbeResult;
  config: Config;
  manifest?: DownloadManifest;
  callbacks?: DownloadCallbacks;
}

interface DownloadedTrackData {
  id: string;
  title: string;
  webpageUrl?: string | null;
  playlistTitle?: string | null;
  playlistIndex?: number | null;
  filePath: string;
}

export type OutputLineResult =
  | { kind: "title"; title: string }
  | { kind: "progress"; rendered: string; data: ProgressData }
  | { kind: "skipped" }
  | { kind: "track"; track: DownloadedTrackData }
  | { kind: "destination"; destination: string }
  | { kind: "none" };

export function buildOutputTemplate(probe: ProbeResult, config: Config): string {
  if (probe.kind === "playlist") {
    return path.join(
      config.outputDir,
      "%(playlist_title)s",
      "%(playlist_index)03d - %(title)s.%(ext)s",
    );
  }
  return path.join(config.outputDir, "%(title)s.%(ext)s");
}

export function buildArgs(url: string, config: Config, template: string): string[] {
  const args = [
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    String(config.quality),
    "--output",
    template,
    "--download-archive",
    config.archivePath,
    "--embed-metadata",
    // --print can otherwise imply quiet or simulated operation in yt-dlp.
    "--no-simulate",
    "--no-quiet",
    "--newline",
    "--progress-template",
    "download:download:%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "--print",
    "before_dl:TITLE:%(title)s",
    "--print",
    'after_move:TRACK:{"id":%(id)j,"title":%(title)j,"webpageUrl":%(webpage_url)j,"playlistTitle":%(playlist_title)j,"playlistIndex":%(playlist_index)j,"filePath":%(filepath)j}',
  ];
  if (config.embedThumbnail) args.push("--embed-thumbnail");
  args.push("--", url);
  return args;
}

export function parseOutputLine(line: string): OutputLineResult {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "none" };

  if (trimmed.startsWith("TITLE:")) {
    return { kind: "title", title: trimmed.slice("TITLE:".length) };
  }

  if (trimmed.startsWith("TRACK:")) {
    try {
      // yt-dlp's `j` conversion renders unavailable values as bare `NA` rather
      // than JSON null. Only normalize NA tokens in value positions; quoted
      // occurrences in titles and paths remain unchanged.
      const json = trimmed
        .slice("TRACK:".length)
        .replace(/([:,])NA(?=,|})/g, "$1null");
      const value: unknown = JSON.parse(json);
      if (!value || typeof value !== "object") throw new Error("not an object");
      const track = value as Partial<DownloadedTrackData>;
      if (
        typeof track.id !== "string" ||
        typeof track.title !== "string" ||
        typeof track.filePath !== "string"
      ) {
        throw new Error("missing required fields");
      }
      return { kind: "track", track: track as DownloadedTrackData };
    } catch {
      return { kind: "none" };
    }
  }

  const progress = parseProgressLine(trimmed);
  if (progress) {
    return { kind: "progress", rendered: renderProgressLine(progress), data: progress };
  }

  if (
    trimmed.includes("has already been recorded in the archive") ||
    trimmed.includes("has already been recorded in archive")
  ) {
    return { kind: "skipped" };
  }

  const dest = /(?:DESTINATION:|Destination: )(.+)$/.exec(trimmed);
  if (dest) {
    return { kind: "destination", destination: dest[1] };
  }

  return { kind: "none" };
}

export function downloadVideo(opts: DownloadOptions): Promise<DownloadResult> {
  const template = buildOutputTemplate(opts.probe, opts.config);
  const args = buildArgs(opts.url, opts.config, template);

  return new Promise((resolve, reject) => {
    const proc = spawn(opts.config.ytDlpBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuf = "";
    let stderrBuf = "";
    const downloadedTracks: LocalTrack[] = [];
    let skippedAny = false;
    const diagnostics: string[] = [];
    let settled = false;

    const handleLine = (line: string) => {
      const result = parseOutputLine(line);
      switch (result.kind) {
        case "title":
          opts.callbacks?.onTitle?.(result.title);
          break;
        case "progress":
          opts.callbacks?.onProgress?.(result.rendered);
          break;
        case "skipped":
          skippedAny = true;
          opts.callbacks?.onStatus?.("skipped (already in archive)");
          break;
        case "track": {
          const data = result.track;
          const playlistIndex =
            typeof data.playlistIndex === "number" && data.playlistIndex > 0
              ? data.playlistIndex
              : undefined;
          const track: LocalTrack = {
            filePath: data.filePath,
            title: data.title,
            order: playlistIndex ?? downloadedTracks.length + 1,
            source: {
              kind: "youtube",
              id: data.id,
              url: data.webpageUrl || `https://www.youtube.com/watch?v=${data.id}`,
              requestUrl: opts.url,
              ...(data.playlistTitle ? { playlistTitle: data.playlistTitle } : {}),
              ...(playlistIndex ? { playlistIndex } : {}),
            },
          };
          downloadedTracks.push(track);
          opts.callbacks?.onStatus?.(`-> ${track.filePath}`);
          break;
        }
        case "destination":
          opts.callbacks?.onStatus?.(`-> ${result.destination}`);
          break;
        case "none":
          if (line.trim()) {
            diagnostics.push(line.trim());
            // stdout contains normal yt-dlp status messages; stderr contains
            // warnings and errors. Expose both instead of silently discarding them.
            opts.callbacks?.onDiagnostic?.(line.trim());
          }
          break;
      }
    };

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      for (const l of lines) handleLine(l);
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop() ?? "";
      for (const l of lines) handleLine(l);
    });

    proc.on("error", (error) => {
      settled = true;
      reject(new Error(`Could not start ${opts.config.ytDlpBin}: ${error.message}`, { cause: error }));
    });

    proc.on("close", (code) => {
      if (settled) return;
      if (stdoutBuf) handleLine(stdoutBuf);
      if (stderrBuf) handleLine(stderrBuf);
      if (code === 0) {
        void (async () => {
          await opts.manifest?.record(downloadedTracks);
          const recovered = (await opts.manifest?.tracksForRequest(opts.url)) ?? [];
          const bySourceId = new Map<string, LocalTrack>();
          for (const track of [...recovered, ...downloadedTracks]) {
            bySourceId.set(track.source?.id ?? track.filePath, track);
          }
          const tracks = [...bySourceId.values()].sort((left, right) => left.order - right.order);
          resolve({ tracks, downloadedCount: downloadedTracks.length, skipped: skippedAny });
        })().catch(reject);
      } else {
        const detail = diagnostics.slice(-12).join("\n");
        const signal = proc.signalCode ? ` (signal ${proc.signalCode})` : "";
        reject(
          new Error(
            `yt-dlp exited with code ${code ?? "unknown"}${signal}${detail ? `\n${detail}` : ""}`,
          ),
        );
      }
    });
  });
}
