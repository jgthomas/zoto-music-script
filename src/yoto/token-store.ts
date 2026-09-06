import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { localError } from "../local-errors.ts";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface TokenStore {
  read(): Promise<StoredTokens | null>;
  write(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredTokens>;
  return (
    typeof candidate.accessToken === "string" && candidate.accessToken.length > 0 &&
    typeof candidate.refreshToken === "string" && candidate.refreshToken.length > 0 &&
    Number.isFinite(candidate.expiresAt)
  );
}

export class FileTokenStore implements TokenStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async read(): Promise<StoredTokens | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isStoredTokens(parsed)) throw new Error("stored authentication data is invalid");
      return parsed;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      if (error instanceof SyntaxError || (error instanceof Error && error.message === "stored authentication data is invalid")) {
        throw new Error(`stored authentication data is invalid: ${this.filePath}. Run npm start -- auth login to replace the session.`);
      }
      throw localError(error, "Reading authentication", this.filePath);
    }
  }

  async write(tokens: StoredTokens): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw new Error(`${localError(error, "Saving authentication", this.filePath).message} After fixing storage, run npm start -- auth login; a rotated refresh token may have been lost.`);
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true }).catch(error => { throw localError(error, "Removing authentication", this.filePath); });
  }
}
