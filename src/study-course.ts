/**
 * T1：一门课一键跑完。
 *
 * 设计取舍（都是实测得出的）：
 *
 * 1. **模型不在循环里。** 每个单元的判断都在工具内部完成：视频/文档直接报进度、
 *    随堂测试用试卷自带答案、讨论回一句固定内容。所以 285 个单元只产生一次工具调用，
 *    不会像 agent 逐单元调用那样把上下文撑爆。
 *
 * 2. **讨论默认回 `"1"`。** 这是使用者的明确选择（T1 里没有模型生成内容）。
 *    它确实只满足"发过一条回复"这个条件，不追求内容质量 —— 内容可用
 *    `discussion_content` 覆盖。实测：回复长度不影响耗时，所以这只影响观感，不影响速度。
 *
 * 3. **章节测验不强行交。** 答案不泄露，需要题库；没有题库时就跳过并如实报告，
 *    而不是全选 A 去赌（那会消耗一次作答次数、拉低分数，且**不推进任何进度**）。
 *
 * 4. **默认真的会跑**（`dry_run` 默认 false）。这是使用者的要求，但它有三个刹车：
 *    `max_units` 上限、`include` 可只跑媒体、以及每单元之间的 `delay_ms` 节流。
 *
 * 5. **讨论区需要浏览器会话。** 新版 API 不认 URS 会话；没有时会把讨论标成
 *    `skipped_reason: "no_browser_session"` 而不是让整门课失败。
 */
import { fetchMocTermDto } from "./course-rpc";
import { replyDiscussion } from "./discussion";
import { solveQuiz } from "./solve-quiz";
import { studyUnit } from "./study-unit";
import type { Icourse163Ports } from "./ports";

/** media = 视频/文档；quiz = 随堂测试；discussion = 讨论区。 */
export type StudyCoursePart = "media" | "quiz" | "discussion";

export type StudyCourseArgs = {
  course_id: string;
  term_id: string;
  school_short_name?: string;
  /** 只跑其中几类；默认三类都跑。 */
  include?: StudyCoursePart[];
  /** 只列出要做什么，不动手。默认 false —— 也就是默认真的会跑。 */
  dry_run?: boolean;
  /** 讨论回复内容。默认 "1"（T1 的明确选择）。 */
  discussion_content?: string;
  /** 单元之间的停顿毫秒数，节流用。默认 800。 */
  delay_ms?: number;
  /** 安全上限：本次最多处理多少个单元。默认 400。 */
  max_units?: number;
  /** 逐单元报告（会显著增大返回体）。默认 false，只给汇总 + 失败清单。 */
  verbose?: boolean;
};

export type StudyCourseItemResult = {
  unit_id: string;
  name: string;
  kind: "media" | "quiz" | "discussion";
  outcome: "done" | "skipped_done" | "skipped_no_answer" | "skipped_no_session" | "failed" | "would_run";
  detail?: string;
};

export type StudyCourseResult = {
  isError: boolean;
  status: "ok" | "dry_run" | "auth_expired" | "not_found" | "no_units" | "partial" | "error";
  course_id: string;
  term_id: string;
  dry_run: boolean;
  counts: {
    units_total: number;
    units_complete_before: number;
    units_complete_after: number | null;
    planned: Record<StudyCoursePart, number>;
    done: Record<StudyCoursePart, number>;
    skipped: Record<StudyCoursePart, number>;
    failed: number;
  };
  /** 失败项，始终返回（这是唯一需要人看的东西）。 */
  failures: StudyCourseItemResult[];
  /** 需要人留意但不是失败的跳过，例如"没有题库所以章节/随堂测验没交"。 */
  notes: string[];
  /** 只在 verbose 时有内容。 */
  items?: StudyCourseItemResult[];
  errors: { where: string; message: string }[];
};

type UnitRow = {
  id: string;
  name: string;
  contentType: number;
  contentId: string;
  completePercent: number;
  viewStatus: string;
};

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | null => (v != null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string => (v == null ? "" : String(v));

/** contentType → 属于哪一类。1/3/4 = 媒体，5 = 随堂测试，6 = 讨论。 */
export function classifyUnit(contentType: number): StudyCoursePart | null {
  if (contentType === 1 || contentType === 3 || contentType === 4) {
    return "media";
  }
  if (contentType === 5) {
    return "quiz";
  }
  if (contentType === 6) {
    return "discussion";
  }
  return null;
}

/** 从 mocTermDto 里摊平出所有单元（导出便于单测）。 */
export function flattenUnits(moc: unknown): UnitRow[] {
  const root = asRec(moc) ?? {};
  const result = asRec(root.result) ?? root;
  const rows: UnitRow[] = [];
  for (const chapter of asArr(result.chapters)) {
    const ch = asRec(chapter);
    if (ch == null) continue;
    for (const lesson of asArr(ch.lessons)) {
      const ls = asRec(lesson);
      if (ls == null) continue;
      for (const unit of asArr(ls.units)) {
        const u = asRec(unit);
        if (u == null) continue;
        const id = asStr(u.id);
        if (id === "") continue;
        rows.push({
          id,
          name: asStr(u.name),
          contentType: Number(u.contentType),
          contentId: asStr(u.contentId),
          completePercent: Number(u.completePercent ?? 0),
          viewStatus: asStr(u.viewStatus),
        });
      }
    }
  }
  return rows;
}

function isComplete(row: UnitRow): boolean {
  return row.completePercent >= 0.999 || row.viewStatus === "completed" || row.viewStatus === "5";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type StudyCourseDeps = {
  ports?: Icourse163Ports;
  /** 覆盖用：读目录。 */
  listUnits?: (args: StudyCourseArgs) => Promise<UnitRow[]>;
  studyOne?: (args: { unit: UnitRow; course: StudyCourseArgs }) => Promise<{ ok: boolean; detail: string }>;
  quizOne?: (args: { unit: UnitRow; course: StudyCourseArgs }) => Promise<{ ok: boolean; detail: string; skip?: "no_answer" | "no_session" }>;
  discussOne?: (args: { unit: UnitRow; course: StudyCourseArgs }) => Promise<{ ok: boolean; detail: string; skip?: "no_answer" | "no_session" }>;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * 一键跑完一门课。
 *
 * 注意：它**不处理单元作业**（需要有人写正文）与**考试**（默认关闭）。这两类不在
 * `contentType` 的媒体/测验/讨论里，所以不会被误触。
 */
export async function studyCourse(args: StudyCourseArgs, deps: StudyCourseDeps = {}): Promise<StudyCourseResult> {
  const parts: StudyCoursePart[] = args.include?.length ? args.include : ["media", "quiz", "discussion"];
  const dryRun = args.dry_run === true;
  const discussionContent = (args.discussion_content ?? "1").trim() || "1";
  const delayMs = Math.max(0, args.delay_ms ?? 800);
  const maxUnits = Math.max(1, args.max_units ?? 400);
  const doSleep = deps.sleep ?? sleep;

  const base: StudyCourseResult = {
    isError: false,
    status: "ok",
    course_id: args.course_id,
    term_id: args.term_id,
    dry_run: dryRun,
    counts: {
      units_total: 0,
      units_complete_before: 0,
      units_complete_after: null,
      planned: { media: 0, quiz: 0, discussion: 0 },
      done: { media: 0, quiz: 0, discussion: 0 },
      skipped: { media: 0, quiz: 0, discussion: 0 },
      failed: 0,
    },
    failures: [],
    notes: [],
    errors: [],
  };

  let units: UnitRow[];
  try {
    units = deps.listUnits
      ? await deps.listUnits(args)
      : flattenUnits(
          await fetchMocTermDto({
            http: (deps.ports?.http ?? (await defaultHttp())) as never,
            cookie: await defaultCookie(deps),
            csrfKey: await defaultCsrf(deps),
            course: { course_id: args.course_id, term_id: args.term_id, school_short_name: args.school_short_name ?? "" },
          }),
        );
  } catch (error) {
    return {
      ...base,
      isError: true,
      status: "error",
      errors: [{ where: "catalog", message: error instanceof Error ? error.message : String(error) }],
    };
  }
  if (units.length === 0) {
    return { ...base, isError: true, status: "no_units", errors: [{ where: "catalog", message: "目录里没有单元" }] };
  }

  const todo: UnitRow[] = [];
  for (const u of units) {
    const part = classifyUnit(u.contentType);
    if (part == null || !parts.includes(part)) continue;
    if (isComplete(u)) continue;
    todo.push(u);
  }
  const planned = { media: 0, quiz: 0, discussion: 0 };
  for (const u of todo) {
    const part = classifyUnit(u.contentType);
    if (part != null) planned[part] += 1;
  }
  const picked = todo.slice(0, maxUnits);

  const items: StudyCourseItemResult[] = [];
  const result: StudyCourseResult = {
    ...base,
    status: dryRun ? "dry_run" : "ok",
    counts: {
      ...base.counts,
      units_total: units.length,
      units_complete_before: units.filter(isComplete).length,
      planned,
    },
  };
  if (todo.length > picked.length) {
    result.notes.push(`待处理 ${todo.length} 个，但受 max_units=${maxUnits} 限制只处理前 ${picked.length} 个`);
  }
  if (dryRun) {
    for (const u of picked) {
      const part = classifyUnit(u.contentType);
      if (part == null) continue;
      items.push({ unit_id: u.id, name: u.name, kind: part, outcome: "would_run" });
    }
    return { ...result, items: args.verbose ? items : undefined };
  }

  const studyOne = deps.studyOne ?? (({ unit }) => defaultStudyOne(unit, args, deps));
  const quizOne = deps.quizOne ?? (({ unit }) => defaultQuizOne(unit, args, deps));
  const discussOne = deps.discussOne ?? (({ unit }) => defaultDiscussOne(unit, args, deps, discussionContent));

  for (const [index, unit] of picked.entries()) {
    const part = classifyUnit(unit.contentType);
    if (part == null) continue;
    let outcome: StudyCourseItemResult["outcome"] = "failed";
    let detail = "";
    try {
      if (part === "media") {
        const r = await studyOne({ unit, course: args });
        outcome = r.ok ? "done" : "failed";
        detail = r.detail;
      } else if (part === "quiz") {
        const r = await quizOne({ unit, course: args });
        outcome = r.ok ? "done" : r.skip === "no_answer" ? "skipped_no_answer" : r.skip === "no_session" ? "skipped_no_session" : "failed";
        detail = r.detail;
      } else {
        const r = await discussOne({ unit, course: args });
        outcome = r.ok ? "done" : r.skip === "no_session" ? "skipped_no_session" : "failed";
        detail = r.detail;
      }
    } catch (error) {
      outcome = "failed";
      detail = error instanceof Error ? error.message : String(error);
    }

    const item: StudyCourseItemResult = { unit_id: unit.id, name: unit.name, kind: part, outcome, detail };
    items.push(item);
    if (outcome === "done") {
      result.counts.done[part] += 1;
    } else if (outcome === "failed") {
      result.counts.failed += 1;
      result.failures.push(item);
    } else {
      result.counts.skipped[part] += 1;
    }

    if (index < picked.length - 1) {
      await doSleep(delayMs);
    }
  }

  // 复查完成度
  try {
    const after = deps.listUnits
      ? await deps.listUnits(args)
      : flattenUnits(
          await fetchMocTermDto({
            http: (deps.ports?.http ?? (await defaultHttp())) as never,
            cookie: await defaultCookie(deps),
            csrfKey: await defaultCsrf(deps),
            course: { course_id: args.course_id, term_id: args.term_id, school_short_name: args.school_short_name ?? "" },
          }),
        );
    result.counts.units_complete_after = after.filter(isComplete).length;
  } catch {
    result.counts.units_complete_after = null;
  }

  if (result.counts.failed > 0) {
    result.status = result.counts.done.media + result.counts.done.quiz + result.counts.done.discussion > 0 ? "partial" : "error";
    result.isError = result.counts.failed > 0 && result.counts.done.media + result.counts.done.quiz + result.counts.done.discussion === 0;
  }
  if (result.counts.skipped.quiz > 0) {
    result.notes.push(`${result.counts.skipped.quiz} 个测验没有可用答案而跳过（章节测验不泄露答案，需要题库）`);
  }
  if (result.counts.skipped.discussion > 0) {
    result.notes.push(`${result.counts.skipped.discussion} 个讨论跳过（需要浏览器登录会话，先调 login 工具）`);
  }
  return { ...result, items: args.verbose ? items : undefined };
}

// ---- 默认实现（真实网络） ----

async function defaultHttp(): Promise<unknown> {
  const { createFetchIcourse163Http } = await import("./http");
  return createFetchIcourse163Http();
}

let cachedSession: { cookie: string; csrfKey: string } | null = null;
async function defaultSession(deps: StudyCourseDeps): Promise<{ cookie: string; csrfKey: string }> {
  if (cachedSession != null) return cachedSession;
  const { resolveSession } = await import("./course-rpc");
  const { createLocalCredentialStore } = await import("./credentials");
  const { createFetchIcourse163Http } = await import("./http");
  const session = await resolveSession({
    credentials: deps.ports?.credentials ?? createLocalCredentialStore(),
    http: deps.ports?.http ?? createFetchIcourse163Http(),
  } as never);
  if (!session.ok) {
    throw new Error("会话不可用：请先登录（login 工具或 npm run login）");
  }
  cachedSession = { cookie: session.cookie, csrfKey: session.csrfKey };
  return cachedSession;
}
const defaultCookie = async (deps: StudyCourseDeps) => (await defaultSession(deps)).cookie;
const defaultCsrf = async (deps: StudyCourseDeps) => (await defaultSession(deps)).csrfKey;

async function defaultStudyOne(
  unit: UnitRow,
  course: StudyCourseArgs,
  deps: StudyCourseDeps,
): Promise<{ ok: boolean; detail: string }> {
  const r = await studyUnit(
    {
      course_id: course.course_id,
      term_id: course.term_id,
      unit_id: unit.id,
      school_short_name: course.school_short_name,
      transport: "rpc",
    },
    deps.ports,
  );
  return { ok: !r.isError, detail: r.status };
}

async function defaultQuizOne(
  unit: UnitRow,
  course: StudyCourseArgs,
  deps: StudyCourseDeps,
): Promise<{ ok: boolean; detail: string; skip?: "no_answer" | "no_session" }> {
  const r = await solveQuiz(
    {
      todo_id: `${course.course_id}:${course.term_id}:unit:${unit.id}`,
      school_short_name: course.school_short_name,
      submit: true,
    },
    deps.ports,
  );
  if (r.status === "ok") return { ok: true, detail: r.status };
  if (r.status === "no_tiku") return { ok: false, detail: r.status, skip: "no_answer" };
  if (r.status === "auth_expired") return { ok: false, detail: r.status, skip: "no_session" };
  return { ok: false, detail: r.status };
}

async function defaultDiscussOne(
  unit: UnitRow,
  course: StudyCourseArgs,
  deps: StudyCourseDeps,
  content: string,
): Promise<{ ok: boolean; detail: string; skip?: "no_answer" | "no_session" }> {
  const r = await replyDiscussion(
    {
      course_id: course.course_id,
      term_id: course.term_id,
      unit_id: unit.id,
      content,
      school_short_name: course.school_short_name,
    },
    { browserCookie: async () => (await browserCookie()) },
  );
  if (r.status === "ok" || r.status === "already_complete") return { ok: true, detail: r.status };
  if (r.status === "no_session") return { ok: false, detail: r.status, skip: "no_session" };
  return { ok: false, detail: r.status };
}

async function browserCookie(): Promise<string | null> {
  const { createBrowserSessionStore } = await import("./discussion");
  return createBrowserSessionStore().getCookie();
}
