import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCli } from "./cli.ts";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(directory: string, args: string[]): Promise<CliResult> {
  const stdoutPath = path.join(directory, "stdout.txt");
  const stderrPath = path.join(directory, "stderr.txt");
  const [stdout, stderr] = await Promise.all([open(stdoutPath, "w"), open(stderrPath, "w")]);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: directory,
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_STATE_HOME: path.join(directory, "state"),
        },
        stdio: ["ignore", stdout.fd, stderr.fd],
      });
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    });
    await Promise.all([stdout.close(), stderr.close()]);
    return {
      code,
      stdout: await readFile(stdoutPath, "utf8"),
      stderr: await readFile(stderrPath, "utf8"),
    };
  } finally {
    await Promise.all([stdout.close().catch(() => {}), stderr.close().catch(() => {})]);
  }
}

test("parseCli extracts urls and applies defaults", () => {
  const { values, urls } = parseCli(["https://example.com/watch?v=1"]);
  assert.deepEqual(urls, ["https://example.com/watch?v=1"]);
  assert.equal(values.thumbnail, true);
  assert.equal(values.help, false);
  assert.equal(values["output-dir"], undefined);
});

test("parseCli parses options", () => {
  const { values, urls } = parseCli([
    "--output-dir",
    "/tmp/music",
    "--quality",
    "5",
    "--archive",
    "/tmp/a.txt",
    "--yt-dlp",
    "/usr/bin/yt-dlp",
    "--no-thumbnail",
    "https://example.com/watch?v=1",
  ]);
  assert.equal(values["output-dir"], "/tmp/music");
  assert.equal(values.quality, "5");
  assert.equal(values.archive, "/tmp/a.txt");
  assert.equal(values["yt-dlp"], "/usr/bin/yt-dlp");
  assert.equal(values.thumbnail, false);
  assert.deepEqual(urls, ["https://example.com/watch?v=1"]);
});

test("parseCli keeps thumbnail enabled when --no-thumbnail is absent", () => {
  const { values } = parseCli(["https://example.com"]);
  assert.equal(values.thumbnail, true);
});

test("parseCli recognizes the help flag", () => {
  const { values, urls } = parseCli(["-h"]);
  assert.equal(values.help, true);
  assert.deepEqual(urls, []);
});

test("parseCli accepts multiple urls", () => {
  const { urls } = parseCli(["https://a.com/1", "https://a.com/2"]);
  assert.deepEqual(urls, ["https://a.com/1", "https://a.com/2"]);
});

test("parseCli accepts a sync playlist title only when enabled", () => {
  const { values, urls } = parseCli(["--title", "Bedtime songs", "https://example.com/playlist"], {
    allowTitle: true,
  });
  assert.equal(values.title, "Bedtime songs");
  assert.deepEqual(urls, ["https://example.com/playlist"]);
});

test("parseCli accepts explicit creation recovery when enabled", () => {
  const result = parseCli(["--retry-create", "https://example.test/video"], {
    allowUploadState: true,
  });
  assert.equal(result.values["retry-create"], true);
  assert.throws(() => parseCli(["--retry-create"]));
});

test("parseCli accepts sync upload-state controls when enabled", () => {
  const { values } = parseCli(["--restart", "--title", "Updated", "https://example.com/playlist"], {
    allowTitle: true,
    allowUploadState: true,
  });
  assert.equal(values.restart, true);
  assert.equal(values["new-copy"], false);
});

test("CLI help paths run without external services", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-cli-help-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const args of [["--help"], ["download", "--help"]]) {
    const result = await runCli(directory, args);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, "");
  }
});

test("CLI rejects invalid arguments before any external operation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-cli-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runCli(directory, [
    "sync",
    "--restart",
    "--new-copy",
    "https://youtube.test/video",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--restart and --new-copy cannot be used together/);
});

test("CLI command preflights fail locally without credentials or input", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-cli-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    { args: ["download", "--quality", "10", "https://youtube.test/video"], message: /0-9/ },
    { args: ["upload"], message: /upload requires an MP3 file or directory/ },
    { args: ["sync", "https://youtube.test/video"], message: /YOTO_CLIENT_ID is required/ },
    { args: ["auth", "login"], message: /YOTO_CLIENT_ID is required/ },
  ];

  for (const { args, message } of cases) {
    const result = await runCli(directory, args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, message);
  }
});
