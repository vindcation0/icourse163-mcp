import { cookieHasNtesstudysi, cookieHasStudyInfo, ntesstudysiFromCookie } from "./cookie";
import {
  fetchTrustedIcourse163,
  type FetchLike,
} from "./http";

export const WARMUP_URL = "https://www.icourse163.org/";

export const COURSE_LIST_RPC_PATH =
  "/web/j/learnerCourseRpcBean.getMyLearnedCoursePanelList.rpc";

export const COURSE_LIST_RPC_URL = `https://www.icourse163.org${COURSE_LIST_RPC_PATH}`;

export const TERM_RPC_PATH = "/web/j/courseBean.getLastLearnedMocTermDto.rpc";

export const TERM_RPC_URL = `https://www.icourse163.org${TERM_RPC_PATH}`;

/** Structurally the same as Icourse163Http; kept here to avoid a runtime cycle. */
export type SessionHttp = {
  request(input: {
    url: string;
    cookie: string;
    method?: "GET" | "POST";
    form?: Record<string, string>;
    headers?: Record<string, string>;
  }): Promise<{ statusCode: number; body: string; cookie: string }>;
};

export type AuthProbeOk = {
  ok: true;
  cookie: string;
};

export type AuthProbeFail = {
  ok: false;
  status: "auth_expired";
  message: string;
};

export type AuthProbeResult = AuthProbeOk | AuthProbeFail;

const MISSING_SESSION_MESSAGE =
  "No icourse163 session (missing NTESSTUDYSI). Run `npm run login` first. MCP tools never take passwords.";

const EXPIRED_SESSION_MESSAGE =
  "icourse163 session is missing or expired (auth_expired). Run `npm run login` again.";

export function missingSessionFailure(message = MISSING_SESSION_MESSAGE): AuthProbeFail {
  return { ok: false, status: "auth_expired", message };
}

export function expiredSessionFailure(message = EXPIRED_SESSION_MESSAGE): AuthProbeFail {
  return { ok: false, status: "auth_expired", message };
}

export async function probeSession(input: {
  cookie: string | null;
  fetchImpl?: FetchLike;
  http?: SessionHttp;
}): Promise<AuthProbeResult> {
  const cookie = input.cookie?.trim() ?? "";
  if (cookie.length === 0 || !cookieHasNtesstudysi(cookie)) {
    return missingSessionFailure();
  }

  const request = createSessionRequest(input);
  let warmed: { statusCode: number; body: string; cookie: string };
  try {
    warmed = await request({
      url: WARMUP_URL,
      cookie,
      method: "GET",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return expiredSessionFailure(`${EXPIRED_SESSION_MESSAGE} Warm-up failed: ${detail}`);
  }

  // Warm-up is meant to refresh cookies, but an HTML page can also answer with a
  // logout redirect whose Set-Cookie clears the session. Never let the warm-up
  // strip NTESSTUDYSI from a session that had one — keep whichever candidate
  // still carries the token.
  const warmedCookie = cookieHasNtesstudysi(warmed.cookie) ? warmed.cookie : cookie;

  if (warmed.statusCode >= 200 && warmed.statusCode < 400 && cookieHasStudyInfo(warmedCookie)) {
    return { ok: true, cookie: warmedCookie };
  }

  const csrfKey = ntesstudysiFromCookie(warmedCookie) ?? ntesstudysiFromCookie(cookie);
  if (csrfKey == null) {
    return expiredSessionFailure();
  }

  let rpc: { statusCode: number; body: string; cookie: string };
  try {
    rpc = await request({
      url: `${COURSE_LIST_RPC_URL}?csrfKey=${encodeURIComponent(csrfKey)}`,
      cookie: warmedCookie,
      method: "POST",
      form: {
        type: "30",
        p: "1",
        psize: "1",
        courseType: "1",
      },
      headers: {
        origin: "https://www.icourse163.org",
        referer: WARMUP_URL,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return expiredSessionFailure(`${EXPIRED_SESSION_MESSAGE} Course-list probe failed: ${detail}`);
  }

  if (rpcCodeIsZero(rpc.body) && rpc.statusCode >= 200 && rpc.statusCode < 300) {
    const resultCookie = cookieHasNtesstudysi(rpc.cookie) ? rpc.cookie : warmedCookie;
    return { ok: true, cookie: resultCookie };
  }

  return expiredSessionFailure();
}

function createSessionRequest(input: {
  fetchImpl?: FetchLike;
  http?: SessionHttp;
}): SessionHttp["request"] {
  const http = input.http;
  if (http != null) {
    return (request) => http.request(request);
  }
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  return async (request) => fetchTrustedIcourse163(fetchImpl, request);
}

export function rpcCodeIsZero(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    return (value as { code?: unknown }).code === 0;
  } catch {
    return false;
  }
}
