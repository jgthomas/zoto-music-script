import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UploadJobStore } from "./job-store.ts";
import { syncYoutubeToYoto } from "../sync.ts";

test("uncertain or corrupt jobs stop sync before probing or downloading", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new UploadJobStore(directory);
  await store.put({ key: "job", title: "Album", completed: false, creating: true, tracks: [], updatedAt: new Date().toISOString() });
  const options = {
    jobStore: store, jobKey: "job", url: "https://youtube.test/playlist",
    config: {} as never, manifest: {} as never, getAccessToken: async () => "token",
  };
  let calls = 0;
  const unexpected = async (): Promise<never> => { calls++; throw new Error("must not run"); };
  const dependencies = { probe: unexpected, download: unexpected, upload: unexpected };
  await assert.rejects(syncYoutubeToYoto(options, dependencies), /outcome is unknown/);
  const [file] = await readdir(directory);
  await writeFile(path.join(directory, file!), "{broken");
  await assert.rejects(syncYoutubeToYoto(options, dependencies), /Preserve this file/);
  assert.equal(calls, 0);
});
