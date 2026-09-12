# zoto-music-script

Download audio from YouTube and create Yoto Make Your Own playlists.

## Requirements

- Node.js 26.8.1 (run `fnm use` in this directory; `.nvmrc` selects it)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on PATH
- [ffmpeg](https://ffmpeg.org/) on PATH (used to convert to MP3)

## Install

```sh
npm install
```

## Usage

The default workflow downloads a YouTube video or playlist and uploads the
resulting MP3s as one Yoto MYO playlist:

```sh
npm start -- <youtube-url>
```

The equivalent explicit command supports a custom Yoto playlist title:

```sh
npm start -- sync --title "My playlist" <youtube-url>
```

Interrupted syncs resume automatically. Completed syncs are checked against
their saved state; unchanged content is not uploaded or created again, while
changed tracks or titles update the existing Yoto content.
Cached MP3s are hashed again before reuse, even when their size and modification
time match. This adds a local file read but avoids reusing stale audio.

Download and upload can also be run independently. To download without creating
Yoto content:

```sh
npm start -- download <youtube-url> [more-urls...]
```

The tool remembers previously downloaded videos so it can use their local MP3s
when yt-dlp skips them through its download archive.

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

## Uploading MP3s to Yoto

Upload a directory as one naturally ordered playlist:

```sh
npm start -- upload --title "My playlist" ./album/
```

You can also upload one file or an explicitly ordered list:

```sh
npm start -- upload ./track.mp3
npm start -- upload ./intro.mp3 ./chapter-1.mp3 ./outro.mp3
```

If `--title` is omitted, the directory, single-track title, or common parent
directory name is used. Once the playlist has been created, open the Yoto app
to link it to a physical Make Your Own card.

Uploads also resume automatically and update the previously created playlist.
Use `--restart` to discard cached hashing/transcoding progress while retaining
the existing Yoto content ID, or `--new-copy` to intentionally create a separate
playlist:

```sh
npm start -- upload --restart ./album/
npm start -- upload --new-copy ./album/
```

If a playlist creation request loses its response, the process exits, or the
final local save fails, the next run stops with an "outcome is unknown" message
instead of creating another playlist. Check your Yoto library. Only if the
playlist was not created, explicitly retry:

```sh
npm start -- upload --retry-create ./album/
# Also supported by sync:
npm start -- sync --retry-create <youtube-url>
```

If the playlist already exists, do not use --retry-create: doing so can create
duplicate. If the response was received but the local save failed, the error
prints the returned content ID; keep it for recovery.
For an uncertain --new-copy operation, rerun with both --new-copy
--retry-create. Do not run two uploads for the same source concurrently.

### Options

| Flag               | Default                           | Description                         |
| ------------------ | --------------------------------- | ----------------------------------- |
| `--output-dir DIR` | `~/Music`                         | MP3 destination                     |
| `--quality N`      | `0`                               | Audio quality (0 = best, 9 = worst) |
| `--no-thumbnail`   | (embed by default)                | Skip thumbnail embedding            |
| `--archive FILE`   | `~/.cache/zoto-music/archive.txt` | Skip previously downloaded videos   |
| `--yt-dlp PATH`    | `yt-dlp`                          | yt-dlp executable path              |
| `--title TITLE`    | YouTube title                     | Yoto playlist title                 |
| `--restart`        |                                   | Reprocess cached work               |
| `--new-copy`       |                                   | Create a separate content item      |
| `--retry-create`   |                                   | Retry an uncertain content creation |
| `-h, --help`       |                                   | Show help                           |

### Examples

```sh
# Seamless download and Yoto upload
npm start -- sync "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Explicit download only
npm start -- download "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"

# Seamless workflow with a custom local destination and Yoto title
npm start -- sync --output-dir ~/Music/New --title "New songs" "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

## Errors and recovery

Errors identify the failed operation and provide a next step. HTTP response
bodies, authentication tokens, and signed upload URLs are not printed.

| Failure                                   | Next step                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Missing session or rejected refresh token | Run `npm start -- auth login`, then rerun your command.                                                                                  |
| Permission denied by Yoto (403)           | Check your application's scopes and access to the content.                                                                               |
| Rate limit (429)                          | Wait for the indicated interval before resuming.                                                                                         |
| Network failure or Yoto service error     | Check connectivity or wait for the service, then resume. If creation was uncertain, check your library first.                            |
| Transcoding timeout                       | Rerun the same command later; the saved upload ID allows polling to resume.                                                              |
| Missing/deleted Yoto playlist             | Use `--new-copy` if you want to create a replacement. Other validation errors do not imply deletion.                                     |
| Empty, missing, or unreadable MP3         | Fix the named file before rerunning. Missing metadata tags are acceptable.                                                               |
| Invalid upload job                        | Preserve the named state file and restore a valid backup. Deleting it can lose the content ID and create duplicates.                     |
| Local save failure                        | Fix disk space or permissions. If token rotation could not be saved, sign in again. If content was created, keep the printed content ID. |

## Notes

- Re-running a download skips videos already in the archive (keyed by video ID).
- Age-restricted or members-only videos may not download.
- Downloads are sequential.
