import { spawn } from "node:child_process";
import path from "node:path";
import type { Config } from "./config.ts";
import type { ProbeResult } from "./probe.ts";
import { parseProgressLine, renderProgressLine, type ProgressData } from "./progress.ts";

export interface DownloadCallbacks {
  onTitle?: (title: string) => void;
  onProgress?: (rendered: string) => void;
  onStatus?: (text: string) => void;
  onDiagnostic?: (text: string) => void;
}

export interface DownloadResult {
  downloaded: boolean;
  skipped: boolean;
  destination: string | null;
}

export interface DownloadOptions {
  url: string;
  probe: ProbeResult;
  config: Config;
  callbacks?: DownloadCallbacks;
}

export type OutputLineResult =
  | { kind: "title"; title: string }
  | { kind: "progress"; rendered: string; data: ProgressData }
  | { kind: "skipped" }
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
    "after_move:DESTINATION:%(filepath)s",
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
    let lastDestination: string | null = null;
    let downloadedAny = false;
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
          if (result.data.downloaded > 0) downloadedAny = true;
          opts.callbacks?.onProgress?.(result.rendered);
          break;
        case "skipped":
          skippedAny = true;
          opts.callbacks?.onStatus?.("skipped (already in archive)");
          break;
        case "destination":
          lastDestination = result.destination;
          downloadedAny = true;
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
        resolve({ downloaded: downloadedAny, skipped: skippedAny, destination: lastDestination });
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
