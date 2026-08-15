#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultConfig } from "./config.ts";
import { downloadVideo } from "./download.ts";
import { DownloadManifest } from "./download-manifest.ts";
import { probeUrl } from "./probe.ts";
import { discoverLocalTracks } from "./tracks.ts";
import { getAccessToken, login } from "./yoto/auth.ts";
import { uploadPlaylist } from "./yoto/media.ts";
import { FileTokenStore } from "./yoto/token-store.ts";

const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const HELP = `${BOLD}Usage:${RESET} node src/cli.ts download [options] <url> [more-urls...]
       node src/cli.ts [options] <url> [more-urls...]
       node src/cli.ts auth <login|status|logout>
       node src/cli.ts upload [--title TITLE] <file-or-directory> [...]

${BOLD}Options:${RESET}
  --output-dir DIR    Where MP3s are saved (default: ~/Music)
  --quality N         Audio quality, 0 (best) - 9 (worst) (default: 0)
  --no-thumbnail      Do not embed the video thumbnail
  --archive FILE      Skip videos already downloaded (default: ~/.cache/zoto-music/archive.txt)
  --yt-dlp PATH       Path to the yt-dlp binary (default: yt-dlp)
  -h, --help          Show this help

${BOLD}Examples:${RESET}
  node src/cli.ts download "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  node src/cli.ts "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"
`;

const UPLOAD_HELP = `${BOLD}Usage:${RESET} node src/cli.ts upload [--title TITLE] <file-or-directory> [...]

Upload MP3 files and create one playlist in your Yoto MYO library.
Directory contents are naturally ordered; explicit file arguments retain their order.
`;

const AUTH_HELP = `${BOLD}Usage:${RESET} node src/cli.ts auth <login|status|logout>

${BOLD}Commands:${RESET}
  login     Sign in to Yoto using your browser
  status    Check the saved session, refreshing it if necessary
  logout    Remove the saved Yoto session

Set your public application client ID in the YOTO_CLIENT_ID environment variable.
`;

export interface CliValues {
  "output-dir"?: string;
  quality?: string;
  thumbnail: boolean;
  archive?: string;
  "yt-dlp"?: string;
  help: boolean;
}

export function parseCli(argv: string[]): { values: CliValues; urls: string[] } {
  let noThumbnail = false;
  const args = argv.filter((a) => {
    if (a === "--no-thumbnail") {
      noThumbnail = true;
      return false;
    }
    return true;
  });

  const { values: raw, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "output-dir": { type: "string" },
      quality: { type: "string" },
      thumbnail: { type: "boolean", default: true },
      archive: { type: "string" },
      "yt-dlp": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const values = {
    ...(raw as CliValues),
    thumbnail: noThumbnail ? false : (raw.thumbnail ?? true),
  };
  return { values, urls: positionals };
}

function clearProgressLine(): void {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
}

function loadLocalEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw new Error(`Could not load .env: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runAuthCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(AUTH_HELP);
    return;
  }

  const config = defaultConfig();
  const tokenStore = new FileTokenStore(config.yotoTokenPath);

  if (command === "logout") {
    await tokenStore.clear();
    process.stdout.write(`${GREEN}Signed out of Yoto.${RESET}\n`);
    return;
  }
  if (command !== "login" && command !== "status") {
    throw new Error(`Unknown auth command: ${command}`);
  }
  if (!config.yotoClientId) {
    throw new Error("YOTO_CLIENT_ID is required for Yoto authentication");
  }

  const authOptions = { clientId: config.yotoClientId, tokenStore };
  if (command === "login") {
    await login(authOptions, (url) => {
      process.stdout.write(`${BOLD}Open this URL to sign in to Yoto:${RESET}\n${url}\n`);
    });
    process.stdout.write(`${GREEN}Signed in to Yoto.${RESET}\n`);
  } else {
    await getAccessToken(authOptions);
    process.stdout.write(`${GREEN}Signed in to Yoto.${RESET}\n`);
  }
}

async function runUploadCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(UPLOAD_HELP);
    return;
  }
  if (positionals.length === 0) throw new Error("upload requires an MP3 file or directory");

  const config = defaultConfig();
  if (!config.yotoClientId) throw new Error("YOTO_CLIENT_ID is required for Yoto uploads");
  const tracks = await discoverLocalTracks(positionals);
  const firstInput = path.resolve(positionals[0]);
  const firstDetails = await stat(firstInput);
  const defaultTitle = firstDetails.isDirectory()
    ? path.basename(firstInput)
    : positionals.length === 1
      ? tracks[0]?.title
      : path.basename(path.dirname(firstInput));
  const title = values.title?.trim() || defaultTitle || "My Playlist";
  const tokenStore = new FileTokenStore(config.yotoTokenPath);
  const authOptions = { clientId: config.yotoClientId, tokenStore };

  process.stdout.write(`${BOLD}${title}${RESET} (${tracks.length} track${tracks.length === 1 ? "" : "s"})\n`);
  const result = await uploadPlaylist({
    tracks,
    title,
    getAccessToken: () => getAccessToken(authOptions),
    callbacks: {
      onStatus: (status) => process.stdout.write(`  ${DIM}${status}${RESET}\n`),
    },
  });
  process.stdout.write(`${GREEN}Yoto playlist created:${RESET} ${result.title}\n`);
  process.stdout.write(`Content ID: ${result.cardId}\n`);
  process.stdout.write("Open the Yoto app to link this playlist to a Make Your Own card.\n");
}

async function main(): Promise<void> {
  loadLocalEnv();
  if (process.argv[2] === "auth") {
    await runAuthCommand(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "upload") {
    await runUploadCommand(process.argv.slice(3));
    return;
  }
  const downloadArgs = process.argv[2] === "download" ? process.argv.slice(3) : process.argv.slice(2);
  const { values, urls } = parseCli(downloadArgs);

  if (values.help || urls.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  const config = defaultConfig();
  if (values["output-dir"]) config.outputDir = values["output-dir"];
  if (values.quality !== undefined) {
    const q = Number(values.quality);
    if (!Number.isInteger(q) || q < 0 || q > 9) {
      process.stderr.write(`${RED}error:${RESET} --quality must be an integer 0-9\n`);
      process.exit(1);
    }
    config.quality = q;
  }
  config.embedThumbnail = values.thumbnail;
  if (values.archive) config.archivePath = values.archive;
  if (values["yt-dlp"]) config.ytDlpBin = values["yt-dlp"];

  await mkdir(path.dirname(config.archivePath), { recursive: true });
  const manifest = new DownloadManifest(config.downloadManifestPath);

  let failed = false;

  for (const url of urls) {
    try {
      process.stdout.write(`\n${BOLD}${url}${RESET}\n`);

      const probe = await probeUrl(url, config.ytDlpBin);
      if (probe.kind === "playlist") {
        const count = probe.count > 0 ? ` (${probe.count} videos)` : "";
        process.stdout.write(`  ${CYAN}Playlist:${RESET} ${probe.title}${count}\n`);
      } else {
        process.stdout.write(`  ${CYAN}Single video:${RESET} ${probe.title}\n`);
      }

      const callbacks = {
        onTitle: (title: string) => {
          clearProgressLine();
          process.stdout.write(`  ${BOLD}${title}${RESET}\n`);
        },
        onProgress: (rendered: string) => {
          if (process.stdout.isTTY) {
            process.stdout.write(`\r  ${rendered}   `);
          } else {
            process.stdout.write(`  ${rendered}\n`);
          }
        },
        onStatus: (text: string) => {
          clearProgressLine();
          process.stdout.write(`  ${DIM}${text}${RESET}\n`);
        },
        onDiagnostic: (text: string) => {
          clearProgressLine();
          process.stderr.write(`  ${DIM}${text}${RESET}\n`);
        },
      };

      const result = await downloadVideo({ url, probe, config, manifest, callbacks });
      clearProgressLine();

      if (result.downloadedCount > 0) {
        process.stdout.write(
          `  ${GREEN}done${RESET} ${result.downloadedCount} downloaded, ${result.tracks.length} local track(s) available\n`,
        );
      } else if (result.tracks.length > 0) {
        process.stdout.write(`  ${DIM}${result.tracks.length} archived local track(s) recovered${RESET}\n`);
      } else if (result.skipped) {
        process.stdout.write(`  ${DIM}already in archive, but no local files were found${RESET}\n`);
      } else {
        process.stdout.write(`  ${DIM}no download performed${RESET}\n`);
      }
    } catch (err) {
      failed = true;
      clearProgressLine();
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ${RED}error:${RESET} ${message}\n`);
    }
  }

  process.stdout.write("\n");
  if (failed) process.exit(1);
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${RED}error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
