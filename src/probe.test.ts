import { strict as assert } from "node:assert";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { parseProbeOutput, probeUrl } from "./probe.ts";

test("parseProbeOutput detects a single video", () => {
  const r = parseProbeOutput(
    '{"playlist":NA,"playlistTitle":NA,"count":NA,"title":"Some Video Title"}\n',
  );
  assert.equal(r.kind, "single");
  assert.equal(r.title, "Some Video Title");
  assert.equal(r.count, 0);
});

test("parseProbeOutput detects a playlist", () => {
  const r = parseProbeOutput(
    '{"playlist":"PL123","playlistTitle":"My Playlist","count":5,"title":"First Title"}\n',
  );
  assert.equal(r.kind, "playlist");
  assert.equal(r.title, "My Playlist");
  assert.equal(r.count, 5);
});

test("parseProbeOutput uses the first non-empty line", () => {
  const r = parseProbeOutput(
    '\n{"playlist":"PL1","playlistTitle":"Second Playlist","count":3,"title":"T"}\n{"playlist":"PL1","playlistTitle":"Ignored","count":9,"title":"T"}\n',
  );
  assert.equal(r.kind, "playlist");
  assert.equal(r.title, "Second Playlist");
  assert.equal(r.count, 3);
});

test("parseProbeOutput handles empty output", () => {
  const r = parseProbeOutput("");
  assert.equal(r.kind, "single");
  assert.equal(r.title, "");
  assert.equal(r.count, 0);
});

test("parseProbeOutput preserves delimiters and rejects malformed metadata", () => {
  const result = parseProbeOutput(
    '{"playlist":"PL1","playlistTitle":"Songs | Sleep","count":2,"title":"Ignored"}',
  );
  assert.equal(result.title, "Songs | Sleep");
  assert.deepEqual(parseProbeOutput("not-json"), { kind: "single", title: "", count: 0 });
});

test("probeUrl invokes yt-dlp with JSON metadata output", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-probe-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fake-yt-dlp");
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' "$@" > "$0.args"
printf '%s\\n' '{"playlist":"PL1","playlistTitle":"Songs | Sleep","count":2,"title":"First"}'
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);

  assert.deepEqual(await probeUrl("https://youtube.test/list", executable), {
    kind: "playlist",
    title: "Songs | Sleep",
    count: 2,
  });
  assert.deepEqual((await readFile(`${executable}.args`, "utf8")).trim().split("\n"), [
    "--flat-playlist",
    "--print",
    '{"playlist":%(playlist)j,"playlistTitle":%(playlist_title)j,"count":%(playlist_count)j,"title":%(title)j}',
    "--no-warnings",
    "--",
    "https://youtube.test/list",
  ]);
});

test("probeUrl wraps yt-dlp failures", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-probe-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fake-yt-dlp");
  await writeFile(executable, "#!/bin/sh\nprintf 'invalid URL' >&2\nexit 7\n", { mode: 0o700 });
  await chmod(executable, 0o700);

  await assert.rejects(
    probeUrl("https://youtube.test/bad", executable),
    /Could not inspect URL with yt-dlp:\ninvalid URL/,
  );
});

test("probeUrl rejects empty usable metadata", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-probe-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fake-yt-dlp");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"playlist":NA,"playlistTitle":NA,"count":NA,"title":""}\'\n',
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);

  await assert.rejects(probeUrl("https://youtube.test/empty", executable), /no usable metadata/);
});
