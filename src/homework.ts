import { missingSessionFailure } from "./auth";
import {
  fetchMocTermDto,
  learnReferer,
  resolveSession,
  type ToolError,
} from "./course-rpc";
import { buildDocLearnReport, findUnitInMocTerm, saveLearnDto } from "./study-unit";
import {
  asArray,
  asFiniteNumber,
  asId,
  asNonEmptyString,
  asRecord,
  parseJsonObject,
} from "./json-util";
import type { Icourse163Http, Icourse163Ports } from "./ports";

export const QUIZ_PAPER_RPC_PATH =
  "/web/j/mocQuizRpcBean.getOpenQuizPaperDto.rpc";
export const QUIZ_PAPER_RPC_URL = `https://www.icourse163.org${QUIZ_PAPER_RPC_PATH}`;

export const HOMEWORK_PAPER_RPC_PATH =
  "/web/j/mocQuizRpcBean.getOpenHomeworkPaperDto.rpc";
export const HOMEWORK_PAPER_RPC_URL = `https://www.icourse163.org${HOMEWORK_PAPER_RPC_PATH}`;

export const SUBMIT_ANSWERS_RPC_PATH =
  "/web/j/mocQuizRpcBean.submitAnswers.rpc";
export const SUBMIT_ANSWERS_RPC_URL = `https://www.icourse163.org${SUBMIT_ANSWERS_RPC_PATH}`;

const ORIGIN = "https://www.icourse163.org";

const TYPE_LABELS: Record<number, string> = {
  1: "单选题",
  2: "多选题",
  3: "填空题",
  4: "问答题",
  5: "判断题",
  6: "阅读理解",
  7: "编程题",
};

export type {
  PaperTarget,
  PaperTargetFail,
  PaperTargetOk,
  PaperType,
  ParsedTodoId,
} from "./paper-resolve";
export {
  resolvePaperTarget,
  resolvePaperType,
} from "./paper-resolve";
import type { PaperType, ParsedTodoId, PaperTargetOk } from "./paper-resolve";
import { resolvePaperTarget } from "./paper-resolve";

export type HomeworkOption = {
  id: string;
  content: string;
};

export type HomeworkQuestion = {
  index: number;
  question_id: string;
  type: number;
  type_label: string;
  title: string;
  stem_text: string | null;
  options: HomeworkOption[];
  current_answer: string | null;
  supports_save: boolean;
  bank: "objective" | "subjective";
};

export type GetHomeworkStatus =
  | "ok"
  | "auth_expired"
  | "not_found"
  | "unsupported"
  | "exam_out_of_scope"
  | "incomplete"
  | "error";

export type GetHomeworkResult = {
  isError: boolean;
  status: GetHomeworkStatus;
  todo_id: string;
  paper_type: PaperType | null;
  aid: string | null;
  tid: string | null;
  title: string | null;
  questions: HomeworkQuestion[];
  question_count: number;
  /** True when answers were draft-saved (preview); never means formally submitted. */
  draft_only: true;
  errors: ToolError[];
};

export type SaveAnswerInput = {
  question_id: string;
  /** Choice option id(s) for objective questions. */
  option_ids?: string[];
  /** Free-text / subjective answer. */
  text?: string;
};

export type SaveAnswerItemResult = {
  question_id: string;
  status: "saved" | "rejected" | "failed";
  message: string;
};

export type SaveHomeworkStatus =
  | "ok"
  | "auth_expired"
  | "not_found"
  | "exam_out_of_scope"
  | "rejected"
  | "incomplete"
  | "error";

export type SaveHomeworkAnswersResult = {
  isError: boolean;
  status: SaveHomeworkStatus;
  todo_id: string;
  preview: true;
  submitted: false;
  results: SaveAnswerItemResult[];
  errors: ToolError[];
};

export type SubmitHomeworkResult = {
  isError: boolean;
  status: SaveHomeworkStatus | "submitted";
  todo_id: string;
  preview: false;
  submitted: boolean;
  results: SaveAnswerItemResult[];
  /**
   * Unit-level quizzes (`contentType 5`, i.e. a 随堂测试 that is its own unit) carry a task point
   * that `submitAnswers` does not touch: answers get graded but the unit stays at
   * completePercent 0 / viewStatus 0, so the outline still shows it as undone.
   *
   * "marked" = the follow-up learn report went through; "failed" = it did not (details in
   * errors); "skipped" = not a unit-source quiz, or no ports available to report with.
   */
  task_point?: "marked" | "failed" | "skipped";
  errors: ToolError[];
};

export type GetHomeworkArgs = {
  todo_id: string;
  /** Force quiz vs homework paper RPC; default inferred from source/name heuristics. */
  paper_type?: PaperType;
  school_short_name?: string;
};

export type SaveHomeworkArgs = {
  todo_id: string;
  answers: SaveAnswerInput[];
  paper_type?: PaperType;
  school_short_name?: string;
};

export function parseTodoId(todoId: string): ParsedTodoId | null {
  const parts = todoId.trim().split(":");
  if (parts.length !== 4) {
    return null;
  }
  const [course_id, term_id, source, content_id] = parts;
  if (
    course_id.length === 0 ||
    term_id.length === 0 ||
    content_id.length === 0
  ) {
    return null;
  }
  if (
    source !== "quiz" &&
    source !== "unit" &&
    source !== "exam" &&
    source !== "homework"
  ) {
    return null;
  }
  return { course_id, term_id, source, content_id };
}

/**
 * Named HTML entities that actually show up in icourse163 stems.
 *
 * `&rlm;` / `&lrm;` are bidi marks the platform sprinkles into question text, and they survive
 * plain tag-stripping: a real stem reads `&rlm;田径项目主要由 等基本能力项目类组成。`. Leaving
 * them in poisons a question-bank query (the bank sees a different string than the student does),
 * so they are decoded here and then dropped by the zero-width cleanup below.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
  rlm: "\u200F",
  lrm: "\u200E",
  zwj: "\u200D",
  zwnj: "\u200C",
  shy: "",
  middot: "·",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  times: "×",
  divide: "÷",
};

/** Zero-width and bidi control characters; invisible, and harmful in a search string. */
const INVISIBLE_RE = /[\u200B-\u200F\u2060-\u2069\uFEFF\u00AD]/g;

export function stripHtml(html: string | null | undefined): string | null {
  if (html == null) {
    return null;
  }
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      // Drop zero-width / bidi markers that clutter stems.
      if (code === 8203 || code === 8204 || code === 8205 || code === 8206 || code === 8207) {
        return "";
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    })
    .replace(/&([a-z]+);/gi, (whole, name: string) => {
      const key = name.toLowerCase();
      return key in NAMED_ENTITIES ? NAMED_ENTITIES[key] : whole;
    })
    // Anything above that decoded into an invisible marker goes away here.
    .replace(INVISIBLE_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
  return text.length > 0 ? text : null;
}

export function typeLabelOf(type: number | null): string {
  if (type == null) {
    return "未知题型";
  }
  return TYPE_LABELS[type] ?? `题型${type}`;
}

export function parsePaperQuestions(
  paper: Record<string, unknown>,
): HomeworkQuestion[] {
  const questions: HomeworkQuestion[] = [];
  let index = 0;
  for (const raw of asArray(paper.objectiveQList)) {
    const q = asRecord(raw);
    if (q == null) {
      continue;
    }
    const questionId = asId(q.id);
    if (questionId == null) {
      continue;
    }
    const type = asFiniteNumber(q.type) ?? 0;
    const titleRaw =
      asNonEmptyString(q.title) ??
      asNonEmptyString(q.description) ??
      asNonEmptyString(q.plainTextTitle) ??
      "";
    const options: HomeworkOption[] = [];
    for (const optRaw of asArray(q.optionDtos)) {
      const opt = asRecord(optRaw);
      if (opt == null) {
        continue;
      }
      const optId = asId(opt.id);
      if (optId == null) {
        continue;
      }
      const content =
        stripHtml(asNonEmptyString(opt.content) ?? asNonEmptyString(opt.title)) ??
        "";
      options.push({ id: optId, content });
    }
    const current =
      asNonEmptyString(q.answer) ??
      (Array.isArray(q.stdAnswer) ? null : asNonEmptyString(q.stdAnswer));
    questions.push({
      index,
      question_id: questionId,
      type,
      type_label: typeLabelOf(type),
      title: stripHtml(titleRaw) ?? titleRaw,
      stem_text: stripHtml(titleRaw),
      options,
      current_answer: current,
      supports_save: true,
      bank: "objective",
    });
    index += 1;
  }
  for (const raw of asArray(paper.subjectiveQList)) {
    const q = asRecord(raw);
    if (q == null) {
      continue;
    }
    const questionId = asId(q.id);
    if (questionId == null) {
      continue;
    }
    const type = asFiniteNumber(q.type) ?? 4;
    const titleRaw =
      asNonEmptyString(q.title) ??
      asNonEmptyString(q.description) ??
      asNonEmptyString(q.plainTextTitle) ??
      "";
    questions.push({
      index,
      question_id: questionId,
      type,
      type_label: typeLabelOf(type),
      title: stripHtml(titleRaw) ?? titleRaw,
      stem_text: stripHtml(titleRaw),
      options: [],
      current_answer: stripHtml(asNonEmptyString(q.answer)),
      supports_save: true,
      bank: "subjective",
    });
    index += 1;
  }
  return questions;
}

export async function getHomework(
  args: GetHomeworkArgs,
  ports?: Icourse163Ports,
): Promise<GetHomeworkResult> {
  const todoId = args.todo_id.trim();
  const base = emptyGet(todoId);
  if (todoId.length === 0) {
    return {
      ...base,
      isError: true,
      status: "not_found",
      errors: [{ where: "todo_id", message: "todo_id 不能为空" }],
    };
  }
  const parsed = parseTodoId(todoId);
  if (parsed == null) {
    return {
      ...base,
      isError: true,
      status: "not_found",
      errors: [
        {
          where: "todo_id",
          message:
            "todo_id 格式应为 course_id:term_id:quiz|unit|homework|exam:content_id（来自 list_todos）",
        },
      ],
    };
  }

  if (ports == null) {
    return {
      ...base,
      isError: true,
      status: "auth_expired",
      errors: [{ where: "credentials", message: missingSessionFailure().message }],
    };
  }

  const session = await resolveSession(ports);
  if (!session.ok) {
    return {
      ...base,
      isError: true,
      status: session.status === "auth_expired" ? "auth_expired" : "error",
      errors: session.errors,
    };
  }

  const course = {
    course_id: parsed.course_id,
    term_id: parsed.term_id,
    school_short_name: args.school_short_name?.trim() ?? "",
  };

  const resolved = await resolvePaperTargetFromTerm({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    parsed,
    course,
    paper_type: args.paper_type,
  });
  if (!resolved.ok) {
    return {
      ...base,
      isError: true,
      status: resolved.status,
      errors: resolved.errors,
    };
  }

  const paperType = resolved.paper_type;
  const fetched = await fetchPaperDto({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    tid: resolved.tid,
    paperType,
    course,
  });
  if (!fetched.ok) {
    return {
      ...base,
      isError: true,
      status: fetched.status,
      paper_type: paperType,
      errors: fetched.errors,
    };
  }

  const questions = parsePaperQuestions(fetched.paper);
  return {
    isError: false,
    status: "ok",
    todo_id: todoId,
    paper_type: paperType,
    aid: asId(fetched.paper.aid),
    tid: asId(fetched.paper.tid) ?? resolved.tid,
    title:
      asNonEmptyString(fetched.paper.tname) ??
      asNonEmptyString(fetched.paper.name) ??
      resolved.title,
    questions,
    question_count: questions.length,
    draft_only: true,
    errors: [],
  };
}

export async function saveHomeworkAnswers(
  args: SaveHomeworkArgs,
  ports?: Icourse163Ports,
): Promise<SaveHomeworkAnswersResult> {
  const result = await persistAnswers(args, ports, { preview: true });
  return { ...result, preview: true, submitted: false };
}

export async function submitHomework(
  args: SaveHomeworkArgs,
  ports?: Icourse163Ports,
): Promise<SubmitHomeworkResult> {
  const parsed = parseTodoId(args.todo_id.trim());
  if (parsed?.source === "exam") {
    return {
      isError: true,
      status: "exam_out_of_scope",
      todo_id: args.todo_id.trim(),
      preview: false,
      submitted: false,
      results: [],
      errors: [
        {
          where: "exam",
          message:
            "考试代交不做：submit_homework 拒绝 exam 来源的 todo_id。可读题 + save 草稿，但绝不自动/正式提交考试。",
        },
      ],
    };
  }
  const saved = await persistAnswers(args, ports, { preview: false });
  const result: SubmitHomeworkResult = {
    isError: saved.isError,
    status: saved.status === "ok" ? "submitted" : saved.status,
    todo_id: saved.todo_id,
    preview: false,
    submitted: !saved.isError && saved.status === "ok",
    results: saved.results,
    errors: saved.errors,
  };

  // A unit-level quiz (contentType 5) needs a SECOND, separate report before the outline marks
  // it done. Leaving this out is why a fully-answered 随堂测试 still showed 0%: `submitAnswers`
  // grades the paper but never touches the unit's task point.
  if (result.submitted && parsed?.source === "unit") {
    result.task_point = await markUnitTaskPoint({
      args,
      ports,
      parsed,
      errors: result.errors,
    });
  } else {
    result.task_point = "skipped";
  }
  return result;
}

/**
 * Report the task point for a unit-level quiz.
 *
 * Measured on unit 1322018145 (现代田径运动的发展特点-随堂测试): after a successful
 * `submitAnswers` the unit was still `completePercent 0 / viewStatus 0`; one
 * `saveMocContentLearn` with `contentType: 5` flipped it to `1 / 5`. Nothing else changed, and
 * no other field differs between a completed and an incomplete copy of the same quiz.
 */
async function markUnitTaskPoint(input: {
  args: SaveHomeworkArgs;
  ports: Icourse163Ports | undefined;
  parsed: NonNullable<ReturnType<typeof parseTodoId>>;
  errors: ToolError[];
}): Promise<"marked" | "failed"> {
  const ports = input.ports;
  if (ports == null) {
    input.errors.push({
      where: "task_point",
      message: "答案已提交，但没有可用的 HTTP 端口来上报任务点，页面可能仍显示未完成",
    });
    return "failed";
  }
  const session = await resolveSession(ports);
  if (!session.ok) {
    input.errors.push({
      where: "task_point",
      message: "答案已提交，但会话读取失败，任务点未上报（页面可能仍显示未完成）",
    });
    return "failed";
  }
  const course = {
    course_id: input.parsed.course_id,
    term_id: input.parsed.term_id,
    school_short_name: input.args.school_short_name?.trim() ?? "",
  };
  const unitId = input.parsed.content_id;

  const moc = await fetchMocTermDto({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    course,
  });
  const located = moc == null ? null : findUnitInMocTerm(moc, unitId);
  if (located?.lesson_id == null) {
    input.errors.push({
      where: "task_point",
      message: "答案已提交，但课程目录里定位不到该单元所属课时，任务点未上报",
    });
    return "failed";
  }

  const dto = buildDocLearnReport({
    course_id: course.course_id,
    term_id: course.term_id,
    lesson_id: located.lesson_id,
    unit_id: unitId,
    content_type: 5,
    page_count: null,
  });
  const saved = await saveLearnDto({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    referer: learnReferer(course),
    dto,
  });
  if (saved.kind === "saved") {
    return "marked";
  }
  input.errors.push({
    where: "task_point",
    message: `答案已提交，但任务点上报失败（页面可能仍显示未完成）：${saved.message}`,
  });
  return "failed";
}

type PersistResult = {
  isError: boolean;
  status: SaveHomeworkStatus;
  todo_id: string;
  preview: boolean;
  submitted: false;
  results: SaveAnswerItemResult[];
  errors: ToolError[];
};

async function persistAnswers(
  args: SaveHomeworkArgs,
  ports: Icourse163Ports | undefined,
  mode: { preview: boolean },
): Promise<PersistResult> {
  const todoId = args.todo_id.trim();
  const empty: PersistResult = {
    isError: true,
    status: "error",
    todo_id: todoId,
    preview: mode.preview,
    submitted: false,
    results: [],
    errors: [],
  };

  if (todoId.length === 0) {
    return {
      ...empty,
      status: "not_found",
      errors: [{ where: "todo_id", message: "todo_id 不能为空" }],
    };
  }
  const parsed = parseTodoId(todoId);
  if (parsed == null) {
    return {
      ...empty,
      status: "not_found",
      errors: [
        {
          where: "todo_id",
          message:
            "todo_id 格式应为 course_id:term_id:quiz|unit|homework|exam:content_id（来自 list_todos）",
        },
      ],
    };
  }

  // Refuse accidental submit flags on the save path.
  if (mode.preview) {
    const smuggled = args as SaveHomeworkArgs & {
      submit?: unknown;
      preview?: unknown;
    };
    if (smuggled.submit === true || smuggled.submit === "true") {
      return {
        ...empty,
        status: "rejected",
        errors: [
          {
            where: "submit",
            message:
              "拒绝提交：save_homework_answers 仅草稿保存（preview=true）。正式提交请显式调用 submit_homework。",
          },
        ],
      };
    }
    if (smuggled.preview === false || smuggled.preview === "false") {
      return {
        ...empty,
        status: "rejected",
        errors: [
          {
            where: "preview",
            message:
              "拒绝提交：save_homework_answers 强制 preview=true。正式提交请显式调用 submit_homework。",
          },
        ],
      };
    }
  }

  if (ports == null) {
    return {
      ...empty,
      status: "auth_expired",
      errors: [{ where: "credentials", message: missingSessionFailure().message }],
    };
  }

  const session = await resolveSession(ports);
  if (!session.ok) {
    return {
      ...empty,
      status: session.status === "auth_expired" ? "auth_expired" : "error",
      errors: session.errors,
    };
  }

  const course = {
    course_id: parsed.course_id,
    term_id: parsed.term_id,
    school_short_name: args.school_short_name?.trim() ?? "",
  };

  const resolved = await resolvePaperTargetFromTerm({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    parsed,
    course,
    paper_type: args.paper_type,
  });
  if (!resolved.ok) {
    return {
      ...empty,
      status: resolved.status === "unsupported" ? "rejected" : resolved.status,
      errors: resolved.errors,
    };
  }

  const paperType = resolved.paper_type;
  const fetched = await fetchPaperDto({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    tid: resolved.tid,
    paperType,
    course,
  });
  if (!fetched.ok) {
    return {
      ...empty,
      status: fetched.status,
      errors: fetched.errors,
    };
  }

  const paper = { ...fetched.paper };
  const catalog = parsePaperQuestions(paper);
  const byId = new Map(catalog.map((q) => [q.question_id, q]));
  const results: SaveAnswerItemResult[] = [];
  const builtAnswers: Record<string, unknown>[] = [];

  for (const answer of args.answers) {
    const qid = answer.question_id.trim();
    const question = byId.get(qid);
    if (question == null) {
      results.push({
        question_id: qid,
        status: "failed",
        message: "未找到对应题目",
      });
      continue;
    }
    if (question.bank === "objective") {
      const optionIds = (answer.option_ids ?? []).map((id) => id.trim()).filter(Boolean);
      if (optionIds.length === 0) {
        results.push({
          question_id: qid,
          status: "rejected",
          message: "客观题需要 option_ids",
        });
        continue;
      }
      const allowed = new Set(question.options.map((o) => o.id));
      if (optionIds.some((id) => !allowed.has(id))) {
        results.push({
          question_id: qid,
          status: "rejected",
          message: "option_ids 含未知选项",
        });
        continue;
      }
      builtAnswers.push({
        qid: Number(qid),
        type: question.type,
        optIds: optionIds.map((id) => Number(id)),
        time: Math.floor(Date.now() / 1000),
      });
      results.push({
        question_id: qid,
        status: "saved",
        message: mode.preview ? "草稿已写入待提交包" : "已写入提交包",
      });
      continue;
    }

    const text = answer.text?.trim() ?? "";
    if (text.length === 0) {
      results.push({
        question_id: qid,
        status: "rejected",
        message: "主观题需要 text",
      });
      continue;
    }
    builtAnswers.push({
      qid: Number(qid),
      type: question.type,
      content: { content: text, attachments: [] },
    });
    results.push({
      question_id: qid,
      status: "saved",
      message: mode.preview ? "草稿已写入待提交包" : "已写入提交包",
    });
  }

  if (builtAnswers.length === 0) {
    return {
      isError: true,
      status: results.some((r) => r.status === "rejected") ? "rejected" : "incomplete",
      todo_id: todoId,
      preview: mode.preview,
      submitted: false,
      results,
      errors: [{ where: "answers", message: "没有可保存的答案" }],
    };
  }

  paper.answers = builtAnswers;
  // Absolute hard rule: preview flag must match the calling tool (save→true, submit→false).
  const preview = mode.preview;

  const submitUrl = `${SUBMIT_ANSWERS_RPC_URL}?csrfKey=${encodeURIComponent(session.csrfKey)}`;
  let response;
  try {
    response = await ports.http.request({
      url: submitUrl,
      cookie: session.cookie,
      method: "POST",
      json: { paperDto: paper, preview },
      headers: {
        origin: ORIGIN,
        referer: learnReferer({
          course_id: parsed.course_id,
          term_id: parsed.term_id,
          school_short_name: args.school_short_name?.trim() ?? "",
        }),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      status: "error",
      todo_id: todoId,
      preview: mode.preview,
      submitted: false,
      results,
      errors: [{ where: "submitAnswers", message: detail }],
    };
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return {
      isError: true,
      status: "error",
      todo_id: todoId,
      preview: mode.preview,
      submitted: false,
      results,
      errors: [
        {
          where: "submitAnswers",
          message: `submitAnswers HTTP ${response.statusCode}`,
        },
      ],
    };
  }

  const json = parseJsonObject(response.body);
  if (json == null || json.code !== 0) {
    const rpcMsg =
      asNonEmptyString(json?.message) ??
      asNonEmptyString(json?.msg) ??
      "submitAnswers RPC 返回非 0";
    // preview save only: never silently convert to formal submit.
    if (mode.preview && isPreviewSubmitRejectedMessage(rpcMsg)) {
      return {
        isError: true,
        status: "rejected",
        todo_id: todoId,
        preview: true,
        submitted: false,
        results,
        errors: [
          {
            where: "submitAnswers",
            message: previewRejectedUserMessage(),
          },
        ],
      };
    }
    return {
      isError: true,
      status: "incomplete",
      todo_id: todoId,
      preview: mode.preview,
      submitted: false,
      results,
      errors: [{ where: "submitAnswers", message: rpcMsg }],
    };
  }

  return {
    isError: false,
    status: "ok",
    todo_id: todoId,
    preview: mode.preview,
    submitted: false,
    results,
    errors: [],
  };
}

function emptyGet(todoId: string): GetHomeworkResult {
  return {
    isError: false,
    status: "ok",
    todo_id: todoId,
    paper_type: null,
    aid: null,
    tid: null,
    title: null,
    questions: [],
    question_count: 0,
    draft_only: true,
    errors: [],
  };
}

/** Platform rejects submitAnswers with preview:true (common on some type=6 quizzes). */
export function isPreviewSubmitRejectedMessage(message: string): boolean {
  return /预览不能提交/.test(message);
}

export function previewRejectedUserMessage(): string {
  return (
    "本试卷不支持草稿预览保存。确认答案后请显式调用 submit_homework；" +
    "save_homework_answers 不会自动改为正式提交。"
  );
}

function isConcurrencyLimitMessage(message: string): boolean {
  return /并发限制/.test(message);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONCURRENCY_RETRY_ATTEMPTS = 3;
const CONCURRENCY_RETRY_BASE_MS = 200;

async function resolvePaperTargetFromTerm(input: {
  http: Icourse163Http;
  cookie: string;
  csrfKey: string;
  parsed: ParsedTodoId;
  course: { course_id: string; term_id: string; school_short_name: string };
  paper_type?: PaperType;
}): Promise<
  | PaperTargetOk
  | {
      ok: false;
      status: "not_found" | "unsupported" | "incomplete" | "error";
      errors: ToolError[];
    }
> {
  let moc: Record<string, unknown> | null;
  try {
    moc = await fetchMocTermDto({
      http: input.http,
      cookie: input.cookie,
      csrfKey: input.csrfKey,
      course: input.course,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: "error",
      errors: [{ where: "term", message: `学期目录拉取失败: ${detail}` }],
    };
  }
  if (moc == null) {
    // Never use catalog unit/quiz/homework/exam id as paper tid — platform
    // returns code:0 result:null (空试卷). Require mocTermDto contentId.
    return {
      ok: false,
      status: "incomplete",
      errors: [
        {
          where: "term",
          message:
            `无法解析试卷 contentId：学期目录（mocTermDto）不可用，禁止用目录 id=${input.parsed.content_id} 冒充 tid。请重试或检查登录/课程权限。`,
        },
      ],
    };
  }
  return resolvePaperTarget(input.parsed, moc, input.paper_type);
}

async function fetchPaperDto(input: {
  http: Icourse163Http;
  cookie: string;
  csrfKey: string;
  tid: string;
  paperType: PaperType;
  course: { course_id: string; term_id: string; school_short_name: string };
}): Promise<
  | { ok: true; paper: Record<string, unknown> }
  | {
      ok: false;
      status: "auth_expired" | "not_found" | "incomplete" | "error";
      errors: ToolError[];
    }
> {
  const baseUrl =
    input.paperType === "homework" ? HOMEWORK_PAPER_RPC_URL : QUIZ_PAPER_RPC_URL;
  const url = `${baseUrl}?csrfKey=${encodeURIComponent(input.csrfKey)}`;
  const body =
    input.paperType === "homework"
      ? { tid: Number(input.tid), withStdAnswerAndAnalyse: false }
      : { tid: Number(input.tid) };

  let json: Record<string, unknown> | null = null;
  for (let attempt = 1; attempt <= CONCURRENCY_RETRY_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await input.http.request({
        url,
        cookie: input.cookie,
        method: "POST",
        json: body,
        headers: {
          origin: ORIGIN,
          referer: learnReferer(input.course),
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (
        isConcurrencyLimitMessage(detail) &&
        attempt < CONCURRENCY_RETRY_ATTEMPTS
      ) {
        await sleepMs(CONCURRENCY_RETRY_BASE_MS * attempt);
        continue;
      }
      return {
        ok: false,
        status: "error",
        errors: [{ where: "paper", message: detail }],
      };
    }

    if (response.statusCode === 401 || response.statusCode === 403) {
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
          { where: "paper", message: `Paper RPC HTTP ${response.statusCode}` },
        ],
      };
    }

    json = parseJsonObject(response.body);
    if (json == null) {
      return {
        ok: false,
        status: "incomplete",
        errors: [{ where: "paper", message: "Paper RPC 返回非 JSON" }],
      };
    }
    if (json.code !== 0) {
      const rpcMsg =
        asNonEmptyString(json.message) ??
        asNonEmptyString(json.msg) ??
        `Paper RPC code=${String(json.code)}`;
      if (
        isConcurrencyLimitMessage(rpcMsg) &&
        attempt < CONCURRENCY_RETRY_ATTEMPTS
      ) {
        await sleepMs(CONCURRENCY_RETRY_BASE_MS * attempt);
        continue;
      }
      if (json.code === -1 || /登录|login|auth/i.test(String(json.message ?? ""))) {
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
        status: "not_found",
        errors: [{ where: "paper", message: rpcMsg }],
      };
    }
    break;
  }
  if (json == null || json.code !== 0) {
    return {
      ok: false,
      status: "incomplete",
      errors: [{ where: "paper", message: "Paper RPC 重试后仍失败" }],
    };
  }

  const paper = asRecord(json.result);
  if (paper == null) {
    return {
      ok: false,
      status: "not_found",
      errors: [
        {
          where: "paper",
          message:
            `试卷 result 为空（tid=${input.tid}）。可能 tid 尚未解析为试卷 contentId（目录 unit/quiz id 不能直接当 tid）。`,
        },
      ],
    };
  }
  return { ok: true, paper };
}
