export function localError(error: unknown, operation: string, filePath: string): Error {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const hint =
    code === "ENOENT"
      ? "The file or directory does not exist."
      : code === "EACCES" || code === "EPERM"
        ? "Check filesystem permissions."
        : code === "ENOSPC"
          ? "Free disk space before continuing."
          : "Check the file and filesystem; preserve saved state before attempting recovery.";
  return new Error(`${operation}: ${filePath}. ${hint}`, { cause: error });
}
