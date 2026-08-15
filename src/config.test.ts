import { strict as assert } from "node:assert";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "./config.ts";

test("defaultConfig returns expected defaults", () => {
  const c = defaultConfig();
  assert.equal(c.outputDir, path.join(os.homedir(), "Music"));
  assert.equal(c.quality, 0);
  assert.equal(c.embedThumbnail, true);
  assert.equal(c.archivePath, path.join(os.homedir(), ".cache", "zoto-music", "archive.txt"));
  assert.equal(c.ytDlpBin, "yt-dlp");
  assert.equal(
    c.yotoTokenPath,
    path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
      "zoto-music",
      "yoto-auth.json",
    ),
  );
});
