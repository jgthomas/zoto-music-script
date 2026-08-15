import os from "node:os";
import path from "node:path";

export interface Config {
  outputDir: string;
  quality: number;
  embedThumbnail: boolean;
  archivePath: string;
  ytDlpBin: string;
}

export function defaultConfig(): Config {
  return {
    outputDir: path.join(os.homedir(), "Music"),
    quality: 0,
    embedThumbnail: true,
    archivePath: path.join(os.homedir(), ".cache", "zoto-music", "archive.txt"),
    ytDlpBin: "yt-dlp",
  };
}
