import os from "node:os";
import path from "node:path";

export interface Config {
  outputDir: string;
  quality: number;
  embedThumbnail: boolean;
  archivePath: string;
  downloadManifestPath: string;
  ytDlpBin: string;
  yotoClientId?: string;
  yotoTokenPath: string;
}

export function defaultConfig(): Config {
  return {
    outputDir: path.join(os.homedir(), "Music"),
    quality: 0,
    embedThumbnail: true,
    archivePath: path.join(os.homedir(), ".cache", "zoto-music", "archive.txt"),
    downloadManifestPath: path.join(
      process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
      "zoto-music",
      "downloads.json",
    ),
    ytDlpBin: "yt-dlp",
    yotoClientId: process.env.YOTO_CLIENT_ID,
    yotoTokenPath: path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
      "zoto-music",
      "yoto-auth.json",
    ),
  };
}
