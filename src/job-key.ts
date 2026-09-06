import { createHash } from "node:crypto";
import path from "node:path";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function syncJobKey(url: string): string {
  return `sync:${digest(url)}`;
}

export function localUploadJobKey(inputs: string[]): string {
  const resolved = inputs.map((input) => path.resolve(input));
  return `local:${digest(resolved.join("\0"))}`;
}
