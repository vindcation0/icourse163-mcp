/**
 * 讨论区：读单元列表 + 回复单元自己的主题（回复即完成该单元的任务点）。
 *
 * 这里的每个细节都是实测出来的，别凭直觉改：
 *
 * 1. **必须用「浏览器登录」的 cookie。** 站点有两套鉴权：旧的 `/web/j/*.rpc` 认我们 URS 纯 HTTP
 *    登录的会话，而新的 `/front-mooc-learn/api/learn/*` 不认 —— 用那份会话写讨论一律
 *    `401 请先登录后继续`。所以本模块读的是另一份存储（`browser-session`），不是 `session`。
 *
 * 2. **完成讨论任务的动作是「回复那节课的主题」，不是「新建帖子」。**
 *    实测：新建帖子即使带上 `lessonUnitId`，服务端也会把这个字段丢掉（读回来是 `null`），
 *    任务点不动；而 `action:"addReply"` 回复单元 `contentId` 指向的主题，
 *    `completePercent` 立刻 0→1、`viewStatus` 0→5、`replyCount` null→1。
 *
 * 3. **单元列表从 `content-outline` 读，`contentId` 就是主题 id。** 不要用 `forum/index` 的 `lid`
 *    参数去过滤单元 —— 它传任何值都返回 `-100 请求参数错误`。
 *
 * 4. **`canWrite:false` 不是权限信号。** `forum/index` 会返回它并附
 *    `writeReason:"当前接口仅提供只读讨论区数据"`，那只是这个**读接口自己的属性**；
 *    `forum/write` 照样能写。
 *
 * 5. **回复是公开内容，所以默认不重复发。** 单元已经完成就直接返回 `already_complete`，
 *    避免同一条讨论被回复多次。
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { createFileCredentialStore } from "./credentials";

/** 新版 Next.js API 的基址。注意**不是** `/api/learn/*`（那个会 404）。 */
export const LEARN_API_BASE = "https://www.icourse163.org/front-mooc-learn/api/learn";
export const ORIGIN = "https://www.icourse163.org";

/** 讨论单元的 contentType。 */
export const CONTENT_TYPE_DISCUSSION = 6;

/**
 * 浏览器登录会话的存储路径。
 *
 * 单独一份文件：它是**网页登录**产生的 cookie，与工具自己那份 URS 会话不同源、不同寿命，
 * 混在一起会让人误以为"有会话就能写讨论"。
 */
export function browserSessionFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg != null && xdg.length > 0 ? join(xdg, "icourse163-mcp") : join(home, ".config", "icourse163-mcp");
  return join(base, "browser-session");
}

/** 读浏览器登录的 cookie；没有就返回 null（绝不回退到 URS 会话，那份写不了）。 */
export function createBrowserSessionStore(options: { path?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env = options.env ?? process.env;
  const path = options.path ?? browserSessionFilePath(env);
  const store = createFileCredentialStore({ path, env });
  return {
    path,
    /** 环境变量优先（便于临时使用），其次读文件。 */
    getCookie: async (): Promise<string | null> => {
      const fromEnv = env.ICOURSE163_BROWSER_COOKIE?.trim();
      if (fromEnv != null && fromEnv !== "") {
        return fromEnv;
      }
      const fromFile = await store.getCookie();
      const trimmed = fromFile?.trim();
      return trimmed == null || trimmed === "" ? null : trimmed;
    },
    /** 面向用户的补救说明，避免只说"失败"。 */
    missingHint: () =>
      `缺少浏览器登录会话。请把登录 icourse163.org 后浏览器里的整行 Cookie 写入 ${path}（UTF-8、单行），` +
      `或设置 ICOURSE163_BROWSER_COOKIE。新版 API 不认 npm run login 产生的会话。`,
  };
}

export type DiscussionUnit = {
  unit_id: string;
  lesson_id: string;
  content_id: string;
  name: string;
  /** 新 API 的 content-outline **没有** completePercent，只有 viewStatus；两个都给，方便判断。 */
  complete_percent: number | null;
  view_status: string | null;
  /**
   * 是否已完成。
   *
   * 实测：新版 `content-outline` **不返回 `completePercent`**，完成状态在 `viewStatus` 里
   * （已回复的单元是 `"completed"`，未看的是 `"not-viewed"`）。旧的 mocTermDto 那条路才有
   * `completePercent`。所以两个都认，否则幂等闸门会失效、对同一主题重复发帖。
   */
  completed: boolean;
};

type Rec = Record<string, unknown>;

const asRec = (value: unknown): Rec | null =>
  value != null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
const asArr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asStr = (value: unknown): string | null => (value == null ? null : String(value));

/** 从 `content-outline` 的响应里挑出讨论单元。导出是为了能单独测。 */
export function parseDiscussionUnits(outline: unknown): DiscussionUnit[] {
  const units: DiscussionUnit[] = [];
  const root = asRec(outline) ?? {};
  const result = asRec(root.result) ?? root;
  for (const chapter of asArr(result.chapters)) {
    const ch = asRec(chapter);
    if (ch == null) continue;
    for (const lesson of asArr(ch.lessons)) {
      const ls = asRec(lesson);
      if (ls == null) continue;
      for (const unit of asArr(ls.units)) {
        const u = asRec(unit);
        if (u == null) continue;
        if (Number(u.contentType) !== CONTENT_TYPE_DISCUSSION) continue;
        const unitId = asStr(u.id);
        const contentId = asStr(u.contentId);
        if (unitId == null || contentId == null || contentId === "") continue;
        const pct = Number(u.completePercent);
        const completePercent = u.completePercent != null && Number.isFinite(pct) ? pct : null;
        const viewStatus = asStr(u.viewStatus);
        units.push({
          unit_id: unitId,
          lesson_id: asStr(ls.id) ?? "",
          content_id: contentId,
          name: asStr(u.name) ?? "",
          complete_percent: completePercent,
          view_status: viewStatus,
          completed:
            (completePercent != null && completePercent >= 0.999) ||
            (viewStatus != null && viewStatus.toLowerCase() === "completed"),
        });
      }
    }
  }
  return units;
}

export type DiscussionReplyStatus =
  | "ok"
  | "already_complete"
  | "no_session"
  | "unit_not_found"
  | "not_a_discussion"
  | "http_error"
  | "rejected";

export type DiscussionReplyResult = {
  isError: boolean;
  status: DiscussionReplyStatus;
  course_id: string;
  term_id: string;
  unit_id: string;
  content_id: string | null;
  unit_name: string | null;
  /** 发出去的回复 id。 */
  reply_id: string | null;
  /** 回复前的任务点百分比。 */
  complete_percent_before: number | null;
  errors: { where: string; message: string }[];
};

export type DiscussionReplyArgs = {
  course_id: string;
  term_id: string;
  unit_id: string;
  content: string;
  school_short_name?: string;
};

type Deps = {
  /** 浏览器登录会话的 cookie；为 null 表示没配置。 */
  browserCookie: () => Promise<string | null>;
  /** 供测试注入。 */
  fetchImpl?: typeof fetch;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function courseKeyOf(schoolShortName: string, courseId: string): string {
  const school = schoolShortName.trim().toUpperCase();
  return school === "" ? courseId : `${school}-${courseId}`;
}

/** URL 构造单独提出，便于测试断言（尤其"基址不是 /api/learn"这一点）。 */
export function outlineUrl(courseKey: string, termId: string): string {
  const qs = new URLSearchParams({ courseKey, entryMode: "learn" });
  return `${LEARN_API_BASE}/terms/${encodeURIComponent(termId)}/content-outline?${qs.toString()}`;
}

/** `addReply` 的请求体。`termId` **必须是字符串**，传数字会被判成缺参数（400）。 */
export function buildReplyBody(args: {
  courseKey: string;
  termId: string;
  contentId: string;
  content: string;
}): Record<string, unknown> {
  return {
    action: "addReply",
    courseKey: args.courseKey,
    termId: args.termId,
    forumScope: "mooc",
    postId: args.contentId,
    content: args.content,
    photos: [],
    anonymous: false,
  };
}

/**
 * 回复某个讨论单元。回复成功即完成任务点，所以成功后不再单独上报进度。
 *
 * 已完成的单元会直接返回 `already_complete` —— 回复是对外公开的，不该重复留痕。
 */
export async function replyDiscussion(args: DiscussionReplyArgs, deps: Deps): Promise<DiscussionReplyResult> {
  const base: DiscussionReplyResult = {
    isError: false,
    status: "ok",
    course_id: args.course_id,
    term_id: args.term_id,
    unit_id: args.unit_id,
    content_id: null,
    unit_name: null,
    reply_id: null,
    complete_percent_before: null,
    errors: [],
  };
  const content = args.content.trim();
  if (content === "") {
    return { ...base, isError: true, status: "rejected", errors: [{ where: "content", message: "回复内容不能为空" }] };
  }

  const cookie = await deps.browserCookie();
  if (cookie == null || cookie.trim() === "") {
    return {
      ...base,
      isError: true,
      status: "no_session",
      errors: [
        {
          where: "browser_session",
          message:
            "缺少浏览器登录会话。新版 API 只认网页登录的 cookie（含 STUDY_INFO/STUDY_SESS），不认 npm run login 的会话。",
        },
      ],
    };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const courseKey = courseKeyOf(args.school_short_name ?? "", args.course_id);

  // ① 从 content-outline 找这个单元，拿它的 contentId（= 主题 id）
  let outlineRes: Response;
  try {
    outlineRes = await fetchImpl(outlineUrl(courseKey, args.term_id), {
      headers: { "user-agent": UA, cookie, accept: "application/json" },
    });
  } catch (error) {
    return { ...base, isError: true, status: "http_error", errors: [{ where: "outline", message: String(error) }] };
  }
  if (!outlineRes.ok) {
    return { ...base, isError: true, status: "http_error", errors: [{ where: "outline", message: `HTTP ${outlineRes.status}` }] };
  }
  const outlineJson = (await outlineRes.json().catch(() => null)) as unknown;
  const units = parseDiscussionUnits(outlineJson);
  const unit = units.find((u) => u.unit_id === args.unit_id);
  if (unit == null) {
    // 区分"根本没这个单元"和"有但不是讨论"
    const anyUnit = parseDiscussionUnits(outlineJson).find((u) => u.unit_id === args.unit_id);
    return {
      ...base,
      isError: true,
      status: anyUnit == null ? "unit_not_found" : "not_a_discussion",
      errors: [
        {
          where: "unit",
          message: `单元 ${args.unit_id} 不在讨论单元列表里（共找到 ${units.length} 个讨论单元）`,
        },
      ],
    };
  }
  const withMeta: DiscussionReplyResult = {
    ...base,
    content_id: unit.content_id,
    unit_name: unit.name,
    complete_percent_before: unit.complete_percent,
  };
  if (unit.completed) {
    return { ...withMeta, status: "already_complete" };
  }

  // ② 回复那个主题
  const referer = `${ORIGIN}/mooc/learn/${courseKey}/content/${unit.lesson_id}?tid=${args.term_id}&unitId=${args.unit_id}`;
  let replyRes: Response;
  try {
    replyRes = await fetchImpl(`${LEARN_API_BASE}/forum/write`, {
      method: "POST",
      headers: {
        "user-agent": UA,
        cookie,
        accept: "application/json",
        "content-type": "application/json",
        origin: ORIGIN,
        referer,
        "x-request-id": `learn-${Date.now()}`,
      },
      body: JSON.stringify(buildReplyBody({ courseKey, termId: args.term_id, contentId: unit.content_id, content })),
    });
  } catch (error) {
    return { ...withMeta, isError: true, status: "http_error", errors: [{ where: "forum/write", message: String(error) }] };
  }
  const replyText = await replyRes.text();
  let replyJson: Rec | null = null;
  try {
    replyJson = JSON.parse(replyText) as Rec;
  } catch {
    replyJson = null;
  }
  if (!replyRes.ok || Number(replyJson?.code) !== 0) {
    return {
      ...withMeta,
      isError: true,
      status: replyRes.status === 401 ? "no_session" : "http_error",
      errors: [
        {
          where: "forum/write",
          message: `HTTP ${replyRes.status} ${asStr(replyJson?.message) ?? replyText.slice(0, 200)}`,
        },
      ],
    };
  }
  const replyId = asStr(asRec(replyJson?.result)?.id);
  return { ...withMeta, reply_id: replyId };
}

/** 列出某门课的讨论单元（只读）。 */
export async function listDiscussionUnits(
  args: { course_id: string; term_id: string; school_short_name?: string },
  deps: Deps,
): Promise<{ isError: boolean; status: "ok" | "no_session" | "http_error"; units: DiscussionUnit[]; errors: { where: string; message: string }[] }> {
  const cookie = await deps.browserCookie();
  if (cookie == null || cookie.trim() === "") {
    return { isError: true, status: "no_session", units: [], errors: [{ where: "browser_session", message: "缺少浏览器登录会话" }] };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const courseKey = courseKeyOf(args.school_short_name ?? "", args.course_id);
  try {
    const res = await fetchImpl(outlineUrl(courseKey, args.term_id), {
      headers: { "user-agent": UA, cookie, accept: "application/json" },
    });
    if (!res.ok) {
      return { isError: true, status: "http_error", units: [], errors: [{ where: "outline", message: `HTTP ${res.status}` }] };
    }
    const json = (await res.json().catch(() => null)) as unknown;
    return { isError: false, status: "ok", units: parseDiscussionUnits(json), errors: [] };
  } catch (error) {
    return { isError: true, status: "http_error", units: [], errors: [{ where: "outline", message: String(error) }] };
  }
}
