/**
 * Thin REST client. Same-origin only: cookies carry the session, and every
 * unsafe request echoes the CSRF token. API keys never reach the browser.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)jarvis_csrf=([^;]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

type Json = Record<string, unknown> | unknown[] | null;

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: Json | FormData; signal?: AbortSignal; raw?: boolean } = {},
): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (method !== "GET" && method !== "HEAD") {
    const token = csrfToken ?? readCsrfCookie();
    if (token) headers["X-CSRF-Token"] = token;
  }
  let body: BodyInit | undefined;
  if (init.body instanceof FormData) body = init.body;
  else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(path, { method, headers, body, credentials: "same-origin", signal: init.signal });
  if (init.raw) {
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res as unknown as T;
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const detail =
      data && typeof data === "object" && "detail" in data
        ? formatDetail((data as { detail: unknown }).detail)
        : res.statusText;
    if (res.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("jarvis:unauthorized"));
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`, data);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
      .join("; ");
  }
  return JSON.stringify(detail);
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body: Json | FormData = {}) => api<T>(path, { method: "POST", body });
export const put = <T,>(path: string, body: Json) => api<T>(path, { method: "PUT", body });
export const patch = <T,>(path: string, body: Json) => api<T>(path, { method: "PATCH", body });
export const del = <T,>(path: string) => api<T>(path, { method: "DELETE" });
