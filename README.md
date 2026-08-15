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

## Yoto authentication

Create a public application in the [Yoto developer dashboard](https://dashboard.yoto.dev/)
and register `http://127.0.0.1:8787/callback` as a redirect URL. Copy the example
environment file, add your client ID, and sign in:

```sh
cp .env.example .env
# Edit .env and replace the placeholder client ID.
npm start -- auth login
```

Local `.env` files are ignored by Git. An already-exported `YOTO_CLIENT_ID`
takes precedence over the value in `.env`.

The command prints a Yoto login URL and briefly listens on `127.0.0.1:8787` for
the browser callback. The resulting session is stored with user-only permissions
under `~/.config/zoto-music/` (or `$XDG_CONFIG_HOME/zoto-music/`).

```sh
npm start -- auth status
npm start -- auth logout
```

## Uploading an MP3 to Yoto

Upload one local MP3 and create a single-track playlist in your MYO library:

```sh
npm start -- upload --title "My playlist" ./track.mp3
```

If `--title` is omitted, the filename is used. Once the playlist has been
created, open the Yoto app to link it to a physical Make Your Own card.

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
