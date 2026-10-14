import {
  COURSE_LIST_RPC_URL,
  TERM_RPC_URL,
  WARMUP_URL,
  missingSessionFailure,
  probeSession,
  rpcCodeIsZero,
} from "./auth";
import { ntesstudysiFromCookie } from "./cookie";
import {
  asArray,
  asId,
  asNonEmptyString,
  asRecord,
  parseJsonObject,
} from "./json-util";
import type {
  Icourse163Http,
  Icourse163HttpResponse,
  Icourse163Ports,
} from "./ports";

export const COURSE_PANEL_PAGE_SIZE = 20;
export const COURSE_PANEL_MAX_PAGES = 20;
export const COURSE_TYPES = ["1", "2"] as const;

export type CoursePanelType = "mooc" | "spoc";

export type CoursePanelItem = {
  name: string;
  course_id: string;
  term_id: string;
  school_short_name: string;
  type: CoursePanelType;
};

export type ToolError = {
  where: string;
  message: string;
};

const ORIGIN = "https://www.icourse163.org";

export function learnReferer(course: {
  course_id: string;
  term_id: string;
  school_short_name: string;
}): string {
  const slug =
    course.school_short_name.length > 0
      ? `${course.school_short_name}-${course.course_id}`
      : course.course_id;
  return `${ORIGIN}/learn/${slug}?tid=${course.term_id}`;
}

export function parseCoursePanelItems(
  body: string,
  courseType: CoursePanelType,
): CoursePanelItem[] | null {
  const json = parseJsonObject(body);
  if (json == null || json.code !== 0) {
    return null;
  }
  const result = asRecord(json.result);
  if (result == null) {
    return [];
  }
  const items: CoursePanelItem[] = [];
  for (const raw of asArray(result.result)) {
    const item = asRecord(raw);
    if (item == null) {
      continue;
    }
    const courseId = asId(item.id);
    const term = asRecord(item.termPanel);
    const termId = term == null ? null : asId(term.id);
    if (courseId == null || termId == null) {
      continue;
    }
    const school = asRecord(item.schoolPanel);
    items.push({
      name: asNonEmptyString(item.name) ?? "未命名课程",
      course_id: courseId,
      term_id: termId,
      school_short_name: asNonEmptyString(school?.shortName) ?? "",
      type: courseType,
    });
  }
  return items;
}

export function parseMocTermDto(body: string): Record<string, unknown> | null {
  const json = parseJsonObject(body);
  if (json == null || json.code !== 0) {
    return null;
  }
  const result = asRecord(json.result);
  if (result == null) {
    return null;
  }
  const moc = asRecord(result.mocTermDto);
  return moc ?? result;
}

export type SessionOk = {
  ok: true;
  cookie: string;
  csrfKey: string;
};

export type SessionFail = {
  ok: false;
  status: "auth_expired" | "error";
  errors: ToolError[];
};

export async function resolveSession(
  ports: Icourse163Ports,
): Promise<SessionOk | SessionFail> {
  let stored: string | null;
  try {
    stored = await ports.credentials.getCookie();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: "error",
      errors: [
        {
          where: "credentials",
          message: `Failed to read stored session: ${detail}`,
        },
      ],
    };
  }

  const probed = await probeSession({ cookie: stored, http: ports.http });
  if (!probed.ok) {
    return {
      ok: false,
      status: "auth_expired",
      errors: [{ where: "credentials", message: probed.message }],
    };
  }

  const cookie = probed.cookie;
  const csrfKey = ntesstudysiFromCookie(cookie);
  if (csrfKey == null) {
    return {
      ok: false,
      status: "auth_expired",
      errors: [{ where: "credentials", message: missingSessionFailure().message }],
    };
  }

  return { ok: true, cookie, csrfKey };
}

export async function fetchAllCoursePanels(input: {
  http: Icourse163Http;
  cookie: string;
  csrfKey: string;
}): Promise<
  | { ok: true; courses: CoursePanelItem[] }
  | { ok: false; status: "auth_expired" | "error"; errors: ToolError[] }
> {
  const courses: CoursePanelItem[] = [];
  const seen = new Set<string>();
  for (const courseTypeCode of COURSE_TYPES) {
    const courseType: CoursePanelType = courseTypeCode === "1" ? "mooc" : "spoc";
    for (let page = 1; page <= COURSE_PANEL_MAX_PAGES; page += 1) {
      let response: Icourse163HttpResponse;
      try {
        response = await input.http.request({
          url: `${COURSE_LIST_RPC_URL}?csrfKey=${encodeURIComponent(input.csrfKey)}`,
          cookie: input.cookie,
          method: "POST",
          form: {
            type: "30",
            p: String(page),
            psize: String(COURSE_PANEL_PAGE_SIZE),
            courseType: courseTypeCode,
          },
          headers: {
            origin: ORIGIN,
            referer: WARMUP_URL,
          },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          status: "error",
          errors: [{ where: "course_panel", message: detail }],
        };
      }
      if (isAuthFailureResponse(response)) {
        return {
          ok: false,
          status: "auth_expired",
          errors: [
            {
              where: "credentials",
              message:
                "icourse163 session is missing or expired (auth_expired). Run `npm run login` again.",
            },
          ],
        };
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return {
          ok: false,
          status: "error",
          errors: [
            {
              where: "course_panel",
              message: `Course panel RPC HTTP ${response.statusCode}`,
            },
          ],
        };
      }
      const items = parseCoursePanelItems(response.body, courseType);
      if (items == null) {
        if (!rpcCodeIsZero(response.body)) {
          return {
            ok: false,
            status: "auth_expired",
            errors: [
              {
                where: "credentials",
                message:
                  "icourse163 session is missing or expired (auth_expired). Run `npm run login` again.",
              },
            ],
          };
        }
        return {
          ok: false,
          status: "error",
          errors: [{ where: "course_panel", message: "Course panel RPC parse failed" }],
        };
      }
      for (const item of items) {
        const key = `${item.course_id}:${item.term_id}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        courses.push(item);
      }
      if (items.length === 0 || items.length < COURSE_PANEL_PAGE_SIZE) {
        break;
      }
    }
  }
  return { ok: true, courses };
}

const MOC_CONCURRENCY_RETRY_ATTEMPTS = 3;
const MOC_CONCURRENCY_RETRY_BASE_MS = 200;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rpcBodyMessage(body: string): string {
  const json = parseJsonObject(body);
  if (json == null) {
    return "";
  }
  return asNonEmptyString(json.message) ?? asNonEmptyString(json.msg) ?? "";
}

export async function fetchMocTermDto(input: {
  http: Icourse163Http;
  cookie: string;
  csrfKey: string;
  course: { course_id: string; term_id: string; school_short_name: string };
  /**
   * Optional collector for the upstream failure. Without it every failure looks
   * like "no mocTermDto", which hides things like -1002 非法跨域请求.
   */
  diagnostics?: string[];
}): Promise<Record<string, unknown> | null> {
  for (let attempt = 1; attempt <= MOC_CONCURRENCY_RETRY_ATTEMPTS; attempt += 1) {
    const response = await input.http.request({
      url: `${TERM_RPC_URL}?csrfKey=${encodeURIComponent(input.csrfKey)}`,
      cookie: input.cookie,
      method: "POST",
      form: { termId: input.course.term_id },
      headers: {
        origin: ORIGIN,
        referer: learnReferer(input.course),
      },
    });
    const msg = rpcBodyMessage(response.body);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      const moc = parseMocTermDto(response.body);
      if (moc != null) {
        return moc;
      }
      noteTermRpcFailure(input, response.body, msg, response.statusCode);
      if (/并发限制/.test(msg) && attempt < MOC_CONCURRENCY_RETRY_ATTEMPTS) {
        await sleepMs(MOC_CONCURRENCY_RETRY_BASE_MS * attempt);
        continue;
      }
      return null;
    }
    noteTermRpcFailure(input, response.body, msg, response.statusCode);
    if (/并发限制/.test(msg) && attempt < MOC_CONCURRENCY_RETRY_ATTEMPTS) {
      await sleepMs(MOC_CONCURRENCY_RETRY_BASE_MS * attempt);
      continue;
    }
    return null;
  }
  return null;
}

function noteTermRpcFailure(
  input: { diagnostics?: string[] },
  body: string,
  msg: string,
  statusCode: number,
): void {
  if (input.diagnostics == null) {
    return;
  }
  const json = parseJsonObject(body);
  const code = json == null ? null : (json as { code?: unknown }).code;
  const suffix = msg.length > 0 ? ` ${msg}` : "";
  if (code != null && code !== 0) {
    input.diagnostics.push(`getLastLearnedMocTermDto code=${String(code)}${suffix}`);
    return;
  }
  if (statusCode < 200 || statusCode >= 300) {
    input.diagnostics.push(`getLastLearnedMocTermDto HTTP ${statusCode}${suffix}`);
    return;
  }
  input.diagnostics.push("getLastLearnedMocTermDto returned no mocTermDto (unparseable body)");
}

function isAuthFailureResponse(response: Icourse163HttpResponse): boolean {
  if (response.statusCode === 401 || response.statusCode === 403) {
    return true;
  }
  const trimmed = response.body.trim();
  if (trimmed.length > 0 && !trimmed.startsWith("{") && /登录|login/i.test(trimmed)) {
    return true;
  }
  return false;
}
