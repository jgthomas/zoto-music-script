import { spawn } from "node:child_process";
import path from "node:path";
import type { Config } from "./config.ts";
import type { ProbeResult } from "./probe.ts";
import { parseProgressLine, renderProgressLine, type ProgressData } from "./progress.ts";

export interface DownloadCallbacks {
  onTitle?: (title: string) => void;
  onProgress?: (rendered: string) => void;
  onStatus?: (text: string) => void;
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
  return [
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    String(config.quality),
    "--output",
    template,
    url,
  ];
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

  const dest = /Destination: (.+)$/.exec(trimmed);
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
    let lastErrorLine = "";

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
      for (const l of lines) {
        const t = l.trim();
        if (!t) continue;
        if (/^ERROR:/.test(t)) lastErrorLine = t;
        process.stderr.write(t + "\n");
      }
    });

    proc.on("error", reject);

    proc.on("close", (code) => {
      if (stdoutBuf) handleLine(stdoutBuf);
      if (stderrBuf.trim()) process.stderr.write(stderrBuf.trim() + "\n");
      if (code === 0) {
        resolve({ downloaded: downloadedAny, skipped: skippedAny, destination: lastDestination });
      } else {
        reject(new Error(lastErrorLine || `yt-dlp exited with code ${code}`));
      }
    });
  });
}
