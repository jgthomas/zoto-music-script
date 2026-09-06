# zoto-music-script

Download audio from YouTube and create Yoto Make Your Own playlists.

## Requirements

- Node.js >= 26
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on PATH
- [ffmpeg](https://ffmpeg.org/) on PATH (used to convert to MP3)

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

Downloads produce structured local track records containing the source video ID,
title, URL, playlist position, and final MP3 path. These are retained in
`~/.local/state/zoto-music/downloads.json` (or beneath `$XDG_STATE_HOME`) so a
later run can recover local files skipped by yt-dlp's download archive.

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

Before creating a new playlist, the tool saves a pending creation marker. If
the request loses its response, the process exits, or the final local save fails,
the next run stops with an "outcome is unknown" message instead of creating again.
Check your Yoto library. Only if the playlist was not created, explicitly retry:

```sh
npm start -- upload --retry-create ./album/
# Also supported by sync:
npm start -- sync --retry-create <youtube-url>
```

If the playlist already exists, do not use --retry-create: doing so can create
a duplicate. Keep its content ID for recovery; automatic attachment to an existing
playlist is not currently implemented. When the response was received but the
local save failed, the error prints the returned content ID.
--restart preserves an uncertain creation marker. --retry-create cannot be
combined with --new-copy, which intentionally starts a separate job.
An interruption immediately before the creation request can also leave this
marker; checking the library is still required. This protection applies to jobs
created with this version; it cannot detect uncertain requests from older versions.

Upload jobs are stored with user-only permissions in
`~/.local/state/zoto-music/yoto-jobs/` (or beneath `$XDG_STATE_HOME`). Each job
is stored in its own atomic JSON file, so concurrent uploads for different
sources cannot overwrite one another. Jobs record local file fingerprints,
source and transcoded hashes, pending upload IDs, and created Yoto content IDs.
Do not run two uploads for the same source concurrently.

The download and upload layers share a source-neutral local track model. Local
MP3 directories are naturally ordered and use embedded titles when available.

### Options

| Flag               | Default                           | Description                                         |
| ------------------ | --------------------------------- | --------------------------------------------------- |
| `--output-dir DIR` | `~/Music`                         | Where MP3s are saved                                |
| `--quality N`      | `0`                               | Audio quality (0 = best, 9 = worst)                 |
| `--no-thumbnail`   | (embed by default)                | Skip embedding the video thumbnail                  |
| `--archive FILE`   | `~/.cache/zoto-music/archive.txt` | Skip videos already downloaded                      |
| `--yt-dlp PATH`    | `yt-dlp`                          | Path to the yt-dlp binary                           |
| `--title TITLE`    | YouTube title                     | Yoto playlist title (`sync` only)                   |
| `--restart`        |                                   | Reprocess cached work and update content            |
| `--new-copy`       |                                   | Intentionally create separate content               |
| `--retry-create`   |                                   | Retry uncertain creation after checking the library |
| `-h, --help`       |                                   | Show help                                           |

### Examples

```sh
# Seamless download and Yoto upload
node src/cli.ts sync "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Explicit download only
node src/cli.ts download "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"

# Seamless workflow with a custom local destination and Yoto title
node src/cli.ts sync --output-dir ~/Music/New --title "New songs" "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
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

API and authentication requests have a 30-second deadline, including reading
the response. Audio uploads have a ten-minute deadline. Transcoding polls are
bounded by 120 attempts and ten minutes, honoring `Retry-After` when it fits
within that window. Creation and token refresh requests are never automatically
retried. Uncertain or corrupt job state stops sync before YouTube inspection
or downloading begins.

## Development commands

```sh
npm install        # install dev dependencies
npm run typecheck  # type-check with tsc --noEmit
npm start -- <url> # download and upload to Yoto
```

## Notes

- Re-running a download skips videos already in the archive (keyed by video ID).
- Age-restricted or members-only videos may require a cookies file; pass a custom
  yt-dlp via `--yt-dlp` or add cookies support later.
- Downloads are sequential.
