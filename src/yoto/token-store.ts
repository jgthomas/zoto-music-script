import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
    typeof candidate.accessToken === "string" &&
    typeof candidate.refreshToken === "string" &&
    typeof candidate.expiresAt === "number"
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
      if (error instanceof SyntaxError) throw new Error("stored authentication data is invalid");
      throw error;
    }
  }

  async write(tokens: StoredTokens): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
