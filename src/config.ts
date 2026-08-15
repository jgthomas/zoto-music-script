import os from "node:os";
import path from "node:path";

export interface Config {
  outputDir: string;
  quality: number;
  embedThumbnail: boolean;
  archivePath: string;
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
    ytDlpBin: "yt-dlp",
    yotoClientId: process.env.YOTO_CLIENT_ID,
    yotoTokenPath: path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
      "zoto-music",
      "yoto-auth.json",
    ),
  };
}
