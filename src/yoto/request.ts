export class YotoHttpError extends Error {
  readonly status: number;
  readonly deleted: boolean;
  constructor(status: number, message: string, deleted = false) {
    super(message);
    this.status = status;
    this.deleted = deleted;
  }
}

export function retryAfterMs(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const milliseconds = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

// Keep the deadline active until the response body is consumed. Do not expose
// arbitrary response text, URLs, or underlying fetch errors in CLI messages.
export async function request(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit,
  operation: string,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(input, { ...init, signal: controller.signal });
        const body = await response.arrayBuffer();
        return new Response(body.byteLength ? body : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new Error(
              `${operation} timed out. Check your connection and resume later; creation outcomes may be uncertain.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } catch {
    if (controller.signal.aborted) {
      throw new Error(
        `${operation} timed out. Check your connection and resume later; creation outcomes may be uncertain.`,
      );
    }
    throw new Error(
      `${operation} could not reach Yoto or read its response. Check your connection and resume later.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function responseError(response: Response, operation: string): Promise<YotoHttpError> {
  let code: unknown;
  let message: unknown;
  try {
    const body = await response.json();
    code = typeof body?.error === "string" ? body.error : body?.error?.code;
    message = body?.error?.message;
  } catch {
    /* HTML and unstructured bodies are intentionally not printed. */
  }
  const deleted = code === "not-found" || message === "Deleted card cannot be restored";
  let hint = "Check the request and try again after correcting the problem.";
  if (code === "invalid_grant" || response.status === 401) {
    hint = "Your session was rejected. Run npm start -- auth login.";
  } else if (response.status === 403) {
    hint =
      "Access was denied. Check the application's scopes and your permission to access this content.";
  } else if (response.status === 429) {
    const delay = retryAfterMs(response);
    hint =
      delay === undefined
        ? "Rate limited. Wait before resuming."
        : `Rate limited. Wait at least ${Math.ceil(delay / 1000)} seconds before resuming.`;
  } else if (response.status >= 500) {
    hint = "Yoto is temporarily unavailable. Resume later.";
  }
  return new YotoHttpError(
    response.status,
    `${operation} failed (${response.status}). ${hint}`,
    deleted,
  );
}

export async function readJson<T>(response: Response, operation: string): Promise<T> {
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as T;
  } catch {
    throw new Error(
      `${operation}: Yoto returned an invalid JSON response. Saved progress is retained.`,
    );
  }
}
