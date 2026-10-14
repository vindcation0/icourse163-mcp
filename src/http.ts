import { mergeSetCookies } from "./cookie";
import type { Icourse163Http, Icourse163HttpRequest } from "./list-todos";

const MAX_COOKIE_REDIRECTS = 10;

export const ICOURSE163_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "status" | "url" | "headers" | "text">>;

export function isTrustedIcourse163Url(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "icourse163.org" || url.hostname.endsWith(".icourse163.org"))
    );
  } catch {
    return false;
  }
}

export type TrustedFetchResult = {
  statusCode: number;
  url: string;
  body: string;
  cookie: string;
};

export function readSetCookieHeaders(headers: Pick<Headers, "get">): string[] {
  const withGetSetCookie = headers as Pick<Headers, "get"> & {
    getSetCookie?: () => string[];
  };
  if (typeof withGetSetCookie.getSetCookie === "function") {
    return withGetSetCookie.getSetCookie();
  }
  const combined = headers.get("set-cookie");
  if (combined == null || combined.trim() === "") {
    return [];
  }
  if (!combined.includes(",")) {
    return [combined];
  }
  const parts = combined.split(/,(?=\s*[^;=,]+=)/);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export async function fetchTrustedIcourse163(
  fetchImpl: FetchLike,
  input: Icourse163HttpRequest,
): Promise<TrustedFetchResult> {
  let currentUrl = input.url;
  let cookie = input.cookie;
  for (let hop = 0; hop <= MAX_COOKIE_REDIRECTS; hop += 1) {
    if (!isTrustedIcourse163Url(currentUrl)) {
      throw new Error(
        hop === 0 ? "untrusted_cookie_request_target" : "untrusted_redirect_target",
      );
    }
    const hopInput: Icourse163HttpRequest = {
      ...input,
      url: currentUrl,
      cookie,
    };
    const response = await fetchImpl(
      currentUrl,
      buildFetchInit(hopInput, hop === 0 ? currentUrl : null),
    );
    cookie = mergeSetCookies(cookie, readSetCookieHeaders(response.headers));
    if (!isRedirectStatus(response.status)) {
      return {
        statusCode: response.status,
        url: response.url && response.url.length > 0 ? response.url : currentUrl,
        body: await response.text(),
        cookie,
      };
    }
    if (hop === MAX_COOKIE_REDIRECTS) {
      throw new Error("too_many_cookie_redirects");
    }
    const location = response.headers.get("location");
    if (location == null || location.trim() === "") {
      throw new Error("redirect_without_location");
    }
    currentUrl = resolveIcourse163Redirect(currentUrl, location);
  }
  throw new Error("too_many_cookie_redirects");
}

export function createFetchIcourse163Http(
  fetchImpl: FetchLike = globalThis.fetch,
): Icourse163Http {
  return {
    async request(input) {
      const result = await fetchTrustedIcourse163(fetchImpl, input);
      return {
        statusCode: result.statusCode,
        url: result.url,
        body: result.body,
        cookie: result.cookie,
      };
    },
  };
}

function resolveIcourse163Redirect(currentUrl: string, location: string): string {
  try {
    const parsed = new URL(location, currentUrl);
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "icourse163.org" ||
        parsed.hostname.endsWith(".icourse163.org"))
    ) {
      parsed.protocol = "https:";
    }
    return parsed.toString();
  } catch {
    throw new Error("invalid_redirect_location");
  }
}

function buildFetchInit(
  input: Icourse163HttpRequest,
  originalUrl: string | null,
): RequestInit {
  const method = (input.method ?? "GET").toUpperCase();
  const headers = new Headers(input.headers);
  headers.set("cookie", input.cookie);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", ICOURSE163_USER_AGENT);
  }

  const sendBody =
    originalUrl != null &&
    method === "POST" &&
    (input.json !== undefined || input.form !== undefined || input.raw !== undefined);

  if (sendBody && input.raw !== undefined) {
    if (input.json !== undefined || input.form !== undefined) {
      throw new Error("http_request_cannot_mix_raw_with_json_or_form");
    }
    // Sent verbatim: signed RPCs cover these exact bytes in the signature.
    return {
      method: "POST",
      headers,
      body: input.raw,
      redirect: "manual",
    };
  }

  if (sendBody && input.json !== undefined) {
    if (input.form !== undefined) {
      throw new Error("http_request_cannot_set_both_json_and_form");
    }
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json;charset=UTF-8");
    }
    return {
      method: "POST",
      headers,
      body: JSON.stringify(input.json),
      redirect: "manual",
    };
  }

  if (sendBody) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/x-www-form-urlencoded; charset=UTF-8");
    }
    return {
      method: "POST",
      headers,
      body: encodeForm(input.form ?? {}),
      redirect: "manual",
    };
  }

  return {
    method: originalUrl == null ? "GET" : method,
    headers,
    redirect: "manual",
  };
}

function encodeForm(form: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    params.append(key, value);
  }
  return params.toString();
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}
