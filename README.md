# zoto-music-script

Download audio from YouTube URLs (single videos or playlists) as MP3.

## Requirements

- Node.js >= 26
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on PATH
- [ffmpeg](https://ffmpeg.org/) on PATH (used to convert to MP3)

## Usage

```sh
node src/cli.ts <url> [more-urls...]
```

or with npm:

```sh
npm start -- <url>
```

### Options

| Flag                 | Default                        | Description                              |
| -------------------- | ------------------------------ | ---------------------------------------- |
| `--output-dir DIR`   | `~/Music`                      | Where MP3s are saved                     |
| `--quality N`        | `0`                            | Audio quality (0 = best, 9 = worst)      |
| `--no-thumbnail`     | (embed by default)             | Skip embedding the video thumbnail       |
| `--archive FILE`     | `~/.cache/zoto-music/archive.txt` | Skip videos already downloaded       |
| `--yt-dlp PATH`      | `yt-dlp`                       | Path to the yt-dlp binary                |
| `-h, --help`         |                                | Show help                                |

### Examples

```sh
# Single video -> ~/Music/Title.mp3
node src/cli.ts "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Playlist -> ~/Music/<Playlist Name>/001 - Title.mp3
node src/cli.ts "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"

# Custom destination
node src/cli.ts --output-dir ~/Music/New "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

## Development

```sh
npm install        # install dev dependencies
npm run typecheck  # type-check with tsc --noEmit
npm start -- <url> # run
```

## Notes

- Re-running a download skips videos already in the archive (keyed by video ID).
- Age-restricted or members-only videos may require a cookies file; pass a custom
  yt-dlp via `--yt-dlp` or add cookies support later.
- Downloads are sequential.
