#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultConfig } from "./config.ts";
import { downloadVideo } from "./download.ts";
import { probeUrl } from "./probe.ts";

const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const HELP = `${BOLD}Usage:${RESET} node src/cli.ts [options] <url> [more-urls...]

${BOLD}Options:${RESET}
  --output-dir DIR    Where MP3s are saved (default: ~/Music)
  --quality N         Audio quality, 0 (best) - 9 (worst) (default: 0)
  --no-thumbnail      Do not embed the video thumbnail
  --archive FILE      Skip videos already downloaded (default: ~/.cache/zoto-music/archive.txt)
  --yt-dlp PATH       Path to the yt-dlp binary (default: yt-dlp)
  -h, --help          Show this help

${BOLD}Examples:${RESET}
  node src/cli.ts "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  node src/cli.ts "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"
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

async function main(): Promise<void> {
  const { values, urls } = parseCli(process.argv.slice(2));

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
      };

      const result = await downloadVideo({ url, probe, config, callbacks });
      clearProgressLine();

      if (result.downloaded) {
        const dest = result.destination ? ` ${result.destination}` : "";
        process.stdout.write(`  ${GREEN}done${RESET}${dest}\n`);
      } else if (result.skipped) {
        process.stdout.write(`  ${DIM}already in archive, nothing to do${RESET}\n`);
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
