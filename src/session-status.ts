import { missingSessionFailure } from "./auth";
import { cookieHasNtesstudysi, cookieHasStudyInfo, parseCookiePairs } from "./cookie";
import { fetchAllCoursePanels, resolveSession, type ToolError } from "./course-rpc";
import type { Icourse163Ports } from "./ports";

/**
 * Reports whether the stored icourse163 session can actually be used, and by which
 * transport.
 *
 * This exists because a stored session can be in three very different states, and
 * the tools fail in confusingly different ways in each:
 *
 *  1. No session at all            -> every tool returns auth_expired.
*  1b. Session passes the probe but lists 0 courses -> status "stale": the directory RPCs
*      answer code 0 with a null result, so every catalog-based tool fails.
 *  2. Valid API token only         -> reads and the signed RPC path work, but the
 *     (NTESSTUDYSI, no STUDY_SESS)   Playwright path cannot reach /learn/ at all,
 *                                    because a plain HTML request gets bounced off
 *                                    the learn page. This state caused a long
 *                                    misdiagnosis: list_courses kept working while
 *                                    study_unit reported "video element not found".
 *  3. Fully logged-in session      -> both transports work.
 *
 * Deliberately read-only. It never probes a browser session by requesting /learn/,
 * because that can hit the logout endpoint and invalidate a working session, and it
 * never writes progress (use `npm run check:rpc` for the signed-write check).
 */
/**
 * `stale` = 面板 RPC 成功了，但**一门课都没有**。
 *
 * 实测遇到过这种状态：`code: 0`、`result: null`、`course_count: 0`，而所有基于目录的工具
 * 都会失败。原来的实现把它报成 `ok`，于是任何"先查 status 再决定"的调用方都会被误导 ——
 * 并发测试因此差点得出错误结论。
 */
export type SessionStatusValue = "ok" | "stale" | "auth_expired" | "error";

export type SessionStatusResult = {
  isError: boolean;
  status: SessionStatusValue;
  /** A session is stored locally (keychain or file). */
  stored: boolean;
  cookies: {
    /** API token — required by every tool. */
    ntesstudysi: boolean;
    /** Written only by a real URS login. */
    study_info: boolean;
    /** Web/browser session cookie — required by the Playwright path. */
    study_sess: boolean;
    total: number;
  };
  /** Result of an authenticated read (the course panel RPC). */
  api: SessionStatusValue;
  course_count: number;
  /**
   * Both `STUDY_INFO` and `STUDY_SESS` cookies are present.
   *
   * Deliberately NOT named "browser path ready": that was an overclaim, and it was measured
   * wrong. Both markers can be present while /learn/ still bounces to the logout endpoint,
   * and a logged-in Chrome profile opens /learn/ while carrying neither STUDY_SESS nor
   * NTESSTUDYSI. So this is a marker check, not proof. Probing /learn/ directly would be
   * the real check, but it hits the logout endpoint and can invalidate a working session,
   * so it is not done here.
   */
  web_session_markers: boolean;
  guidance: string;
  errors: ToolError[];
};

const NO_SESSION_GUIDANCE =
  "No stored session. Run `npm run login` and enter your account and password (the prompt hides the password), or `npm run login --cookie-file <path>` with a cookie copied from a logged-in browser.";

const EXPIRED_GUIDANCE =
  "The stored session is no longer valid for API calls. Run `npm run login` again.";

export async function sessionStatus(ports?: Icourse163Ports): Promise<SessionStatusResult> {
  if (ports == null) {
    return {
      isError: true,
      status: "auth_expired",
      stored: false,
      cookies: { ntesstudysi: false, study_info: false, study_sess: false, total: 0 },
      api: "auth_expired",
      course_count: 0,
      web_session_markers: false,
      guidance: NO_SESSION_GUIDANCE,
      errors: [{ where: "credentials", message: missingSessionFailure().message }],
    };
  }

  let stored: string | null = null;
  let readError: string | null = null;
  try {
    stored = await ports.credentials.getCookie();
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  }

  const jar = parseCookiePairs(stored ?? "");
  const cookies = {
    ntesstudysi: cookieHasNtesstudysi(stored ?? ""),
    study_info: cookieHasStudyInfo(stored ?? ""),
    study_sess: (jar.get("STUDY_SESS") ?? "").trim().length > 0,
    total: jar.size,
  };
  const webSessionMarkers = cookies.study_info && cookies.study_sess;

  const session = await resolveSession(ports);
  if (!session.ok) {
    return {
      isError: true,
      status: session.status,
      stored: stored != null && stored.trim().length > 0,
      cookies,
      api: session.status,
      course_count: 0,
      web_session_markers: webSessionMarkers,
      guidance:
        readError != null
          ? `Could not read the stored session: ${readError}`
          : cookies.ntesstudysi
            ? EXPIRED_GUIDANCE
            : NO_SESSION_GUIDANCE,
      errors: session.errors,
    };
  }

  const panels = await fetchAllCoursePanels({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
  });
  if (!panels.ok) {
    return {
      isError: true,
      status: panels.status,
      stored: true,
      cookies,
      api: panels.status,
      course_count: 0,
      web_session_markers: webSessionMarkers,
      guidance: panels.status === "auth_expired" ? EXPIRED_GUIDANCE : "The course panel RPC failed; retry, or re-run `npm run login`.",
      errors: panels.errors,
    };
  }

  const courseCount = panels.courses.length;

  // 面板成功但一门课都没有 = 半死会话。这不是"可用"，因为所有基于目录的工具都会失败。
  if (courseCount === 0) {
    return {
      isError: true,
      status: "stale",
      stored: true,
      cookies,
      // api 也标成 stale：CLI 的 check_session / cmd_status 都看 `api == "ok"`，
      // 只改 status 会让它们继续放行半死会话。
      api: "stale",
      course_count: 0,
      web_session_markers: webSessionMarkers,
      guidance:
        "会话能通过体检，但一门课都没有 —— 这是**半死会话**：目录类 RPC 会返回 code 0 加 result null，" +
        "刷课/答题/讨论全部失败。请重新登录（`npm run login` 或 MCP 的 login 工具），不要把它当成可用会话。",
      errors: [],
    };
  }
  // Both branches point at transport=rpc, because the browser path cannot be promised from
  // cookies alone. Measured: both markers present yet /learn/ bounced to logout, while a
  // pure-HTTP login still drove the signed RPC fine.
  const guidance = webSessionMarkers
    ? `Session is usable (${courseCount} course/term entries). Prefer transport=rpc: signed HTTP, about a second per unit, no browser needed. The web-session markers are present, but that does NOT prove the Playwright path works — both markers have been seen present while /learn/ still bounced to the logout endpoint. Use \`npm run login\` (browser) if you need transport=playwright.`
    : `Session is usable for API calls (${courseCount} course/term entries), so transport=rpc works. STUDY_SESS/STUDY_INFO are missing, so the Playwright path is very unlikely to work — use \`npm run login\` (browser) if you need it.`;

  return {
    isError: false,
    status: "ok",
    stored: true,
    cookies,
    api: "ok",
    course_count: courseCount,
    web_session_markers: webSessionMarkers,
    guidance,
    errors: [],
  };
}
