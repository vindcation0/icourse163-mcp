/**
 * 把"读题 → 查题库 → 填答案 → （可选）提交"串成一次可审阅的操作。
 *
 * 设计约束（每一条都是踩过的坑或实测结论）：
 *
 * 1. **默认不提交。** `submit` 必须显式传 true。因为①真消耗作答次数②部分卷子没有草稿态，
 *    交出去就不能"只存不交"了。
 * 2. **答案按选项正文匹配回 id。** 实测这样一次就能拿满分；写死选项顺序会错。
 * 3. **覆盖率不够不提交。** 命中率低于阈值时只出答案清单（用 `--submit` 也拦住），
 *    避免交半成品 —— 抄 chaoxing 的 COVER_RATE。
 * 4. **没有作答次数就如实报告。** 随堂测试（ct=5）根本没有次数字段，不能假装检查过。
 * 5. **章节测验提交后会自动置完成；随堂测试还需要一次任务点上报** —— 后者已在
 *    `submitHomework` 里修好，这里只管调用。
 */
import {
  getHomework,
  parseTodoId,
  submitHomework,
  type HomeworkQuestion,
  type SaveAnswerInput,
} from "./homework";
import type { Icourse163Ports } from "./ports";
import { fetchMocTermDto, type ToolError } from "./course-rpc";
import { resolveSession } from "./course-rpc";
import {
  mapQuestionType,
  matchOptionIds,
  loadTikuConfigFromDisk,
  parseTikuConfig,
  queryTiku,
  type AnswererWrapper,
  type TikuFetch,
  type TikuQuestion,
  type TikuQuestionType,
} from "./tiku";

/**
 * 答题方式 —— **显式选择，不做模糊优先级**。
 *
 * - `paper`：只用试卷自带答案（随堂测试在提交前就返回正确选项），**不查题库**
 * - `tiku` ：只用题库，**忽略**试卷自带的答案
 * - `agent`：工具自己不产生任何答案，只把题目返回；提交必须由调用方用 `answers` 给出
 * - `auto` ：`paper` 优先，剩下的才查题库（历史行为，默认）
 */
export type SolveQuizAnswerMode = "auto" | "paper" | "tiku" | "agent";

export type SolveQuizArgs = {
  todo_id: string;
  /** 显式答题方式；默认 `auto`。见 {@link SolveQuizAnswerMode}。 */
  answer_mode?: SolveQuizAnswerMode;
  /** `agent` 模式下由调用方给出的答案。 */
  answers?: SaveAnswerInput[];
  school_short_name?: string;
  /** 题库配置（JSON 文本）。不传就只读题，不做任何查询。 */
  tiku_config?: string;
  /** 只有 true 才真的提交；默认 false（只出清单）。 */
  submit?: boolean;
  /** 覆盖率下限，默认 0.8。低于它一律不提交。 */
  min_coverage?: number;
  paper_type?: "quiz" | "homework";
  /** 显式允许正式提交考试。默认 false —— 见 `SaveHomeworkArgs.allow_exam`。 */
  allow_exam?: boolean;
};

export type SolvedQuestion = {
  index: number;
  question_id: string;
  type: TikuQuestionType;
  type_label: string;
  title: string;
  options: { id: string; content: string }[];
  /** 答案原文（来自试卷或题库）。 */
  answer: string | null;
  answerer: string | null;
  /** paper = 平台自带；tiku = 题库；agent = 调用方传入；null = 没答上。 */
  source: "paper" | "tiku" | "agent" | null;
  /** 落到提交载荷里的字段。 */
  option_ids: string[];
  text: string | null;
  note: string | null;
};

export type SolveQuizStatus =
  | "ok"
  | "dry_run"
  | "low_coverage"
  | "no_tiku"
  | "auth_expired"
  | "not_found"
  | "incomplete"
  | "exam_out_of_scope"
  | "tiku_exhausted"
  | "questions"
  | "no_attempts_left"
  | "error";

export type SolveQuizResult = {
  isError: boolean;
  status: SolveQuizStatus;
  /** 本次用的答题方式（回显，便于审计）。 */
  answer_mode: SolveQuizAnswerMode;
  todo_id: string;
  title: string | null;
  paper_type: string | null;
  question_count: number;
  answered: number;
  /** 0..1 */
  coverage: number;
  min_coverage: number;
  submitted: boolean;
  task_point?: "marked" | "failed" | "skipped";
  /** 从课程目录读到的作答次数；读不到就都是 null（随堂测试就是这样）。 */
  attempts: { used: number | null; limit: number | null; timed: boolean };
  questions: SolvedQuestion[];
  errors: ToolError[];
};

const DEFAULT_MIN_COVERAGE = 0.8;

export async function solveQuiz(
  args: SolveQuizArgs,
  ports?: Icourse163Ports,
  tikuFetch?: TikuFetch,
): Promise<SolveQuizResult> {
  const todoId = args.todo_id.trim();
  const parsed = parseTodoId(todoId);
  const minCoverage =
    typeof args.min_coverage === "number" && Number.isFinite(args.min_coverage)
      ? Math.min(1, Math.max(0, args.min_coverage))
      : DEFAULT_MIN_COVERAGE;
  const base: SolveQuizResult = {
    isError: false,
    status: "dry_run",
    answer_mode: "auto",
    todo_id: todoId,
    title: null,
    paper_type: null,
    question_count: 0,
    answered: 0,
    coverage: 0,
    min_coverage: minCoverage,
    submitted: false,
    attempts: { used: null, limit: null, timed: false },
    questions: [],
    errors: [],
  };

  if (parsed?.source === "exam" && args.allow_exam !== true) {
    return {
      ...base,
      isError: true,
      status: "exam_out_of_scope",
      errors: [
        {
          where: "exam",
          message:
            "考试代交默认关闭。真要作答并正式提交考试，请显式传 allow_exam: true。" +
            "即使开启，也只有 submit: true 且覆盖率达标时才会提交。",
        },
      ],
    };
  }

  let config: AnswererWrapper[] = [];
  // 传了就用传的；没传则尝试磁盘上的题库配置（放一次，全局可用）。
  const tikuRaw = args.tiku_config?.trim() ?? "";
  if (tikuRaw === "") {
    try {
      const fromDisk = await loadTikuConfigFromDisk();
      if (fromDisk != null) {
        config = fromDisk.config;
      }
    } catch (error) {
      // 磁盘配置写坏了要说清楚，不能静默当成"没配题库"
      return {
        ...base,
        isError: true,
        status: "error",
        errors: [{ where: "tiku_config", message: `题库配置文件解析失败：${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
  if (tikuRaw !== "") {
    try {
      config = parseTikuConfig(tikuRaw);
    } catch (error) {
      return {
        ...base,
        isError: true,
        status: "error",
        errors: [{ where: "tiku_config", message: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  const hw = await getHomework(
    { todo_id: todoId, school_short_name: args.school_short_name, paper_type: args.paper_type },
    ports,
  );
  if (hw.isError) {
    return {
      ...base,
      isError: true,
      status: hw.status === "exam_out_of_scope" ? "exam_out_of_scope" : hw.status === "auth_expired" ? "auth_expired" : hw.status === "not_found" ? "not_found" : "incomplete",
      title: hw.title ?? null,
      errors: hw.errors,
    };
  }

  const questions = hw.questions ?? [];
  const solved: SolvedQuestion[] = questions.map((q) => toSolved(q));

  const answerMode: SolveQuizAnswerMode = args.answer_mode ?? "auto";

  // ① 试卷自带答案：只在 `paper` / `auto` 下使用。
  //    `tiku` 模式明确要求忽略它（用题库的结果），`agent` 模式完全不产生答案。
  for (const [index, question] of answerMode === "paper" || answerMode === "auto" ? solved.entries() : []) {
    const platformQuestion = questions[index];
    if (platformQuestion == null) {
      continue;
    }
    const fromPaper = answerFromPaper(platformQuestion);
    if (fromPaper == null) {
      continue;
    }
    question.answer = fromPaper.answer;
    question.source = "paper";
    if (fromPaper.option_ids.length > 0) {
      question.option_ids = fromPaper.option_ids;
    } else if (fromPaper.text != null) {
      question.text = fromPaper.text;
    }
  }

  /** 题库额度耗尽的提示；非 null 表示批量应中止。 */
  let exhaustedNote: string | null = null;

  // ② 题库：只在 `tiku` / `auto` 下使用。
  if (config.length > 0 && (answerMode === "tiku" || answerMode === "auto")) {
    for (const [index, question] of solved.entries()) {
      if (question.option_ids.length > 0 || (question.text != null && question.text !== "")) {
        continue; // 试卷已经给了答案
      }
      const platformType = questions[index]?.type ?? null;
      const type = mapQuestionType(platformType);
      question.type = type;
      if (type === "unknown" || question.title === "") {
        question.note = type === "unknown" ? "主观题/未知题型：题库不适用" : "题干为空，跳过";
        continue;
      }
      const tikuQuestion: TikuQuestion = {
        title: question.title,
        type,
        options: question.options.map((o) => o.content).join("\n"),
      };
      const lookup = await queryTiku(tikuQuestion, config, tikuFetch);
      if (lookup.exhausted === true) {
        // 额度耗尽：再问下去每题都是白跑，停下来并如实报告。
        exhaustedNote = lookup.note ?? "题库额度耗尽";
        break;
      }
      if (lookup.answer == null) {
        question.note = lookup.note ?? "题库未命中";
        continue;
      }
      question.answer = lookup.answer;
      question.answerer = lookup.answerer;
      question.source = "tiku";
      question.note = lookup.note;
      if (question.options.length > 0) {
        // 选择题/判断题：把答案文本匹配回选项 id（实测最可靠）
        question.option_ids = matchOptionIds(lookup.answer, question.options);
      } else {
        question.text = lookup.answer;
      }
    }
  }

  // ③ agent 模式：工具自己不产生答案。调用方给了 `answers` 就用它，没给就把题目返回去。
  if (answerMode === "agent") {
    const supplied = new Map<string, SaveAnswerInput>();
    for (const a of args.answers ?? []) {
      if (a?.question_id != null) supplied.set(String(a.question_id).trim(), a);
    }
    if (supplied.size === 0) {
      // 只读题：让 agent 先看题，再带着 answers 回来。
      const preview: SolveQuizResult = {
        ...base,
        status: "questions",
        answer_mode: answerMode,
        title: hw.title ?? null,
        paper_type: hw.paper_type ?? null,
        question_count: solved.length,
        answered: 0,
        coverage: 0,
        questions: solved,
      };
      return preview;
    }
    for (const q of solved) {
      const a = supplied.get(q.question_id);
      if (a == null) continue;
      q.source = "agent";
      const ids = (a.option_ids ?? []).map((x) => x.trim()).filter(Boolean);
      if (ids.length > 0) {
        q.option_ids = ids;
        q.answer = ids.join("#");
      } else if (a.text != null && a.text.trim() !== "") {
        q.text = a.text.trim();
        q.answer = q.text;
      }
    }
  }

  const answered = solved.filter((q) => q.option_ids.length > 0 || (q.text != null && q.text !== "")).length;
  const coverage = solved.length === 0 ? 0 : answered / solved.length;

  // 连 dry-run 也读次数：用户要靠它判断"这次交出去还剩几次"。读不到就如实报 null。
  const attempts =
    parsed == null ? null : await readAttempts(parsed, ports, args.school_short_name).catch(() => null);
  const attemptInfo =
    attempts == null ? base.attempts : { used: attempts.used, limit: attempts.limit, timed: attempts.timed };

  const result: SolveQuizResult = {
    ...base,
    status: "dry_run",
    answer_mode: answerMode,
    title: hw.title ?? null,
    paper_type: hw.paper_type ?? null,
    question_count: solved.length,
    answered,
    coverage,
    attempts: attemptInfo,
    questions: solved,
  };

  if (exhaustedNote != null) {
    return {
      ...result,
      isError: true,
      status: "tiku_exhausted",
      errors: [{ where: "tiku", message: `题库额度耗尽，已中止：${exhaustedNote}` }],
    };
  }

  if (args.submit !== true) {
    // 有试卷自带答案时，没有题库也不算"缺少题库"
    return { ...result, status: config.length === 0 && answered === 0 ? "no_tiku" : "dry_run" };
  }
  if (config.length === 0 && answered === 0) {
    return { ...result, status: "no_tiku", isError: true, errors: [{ where: "tiku_config", message: "没有题库配置，而且试卷没给出答案，拒绝提交" }] };
  }
  if (coverage < minCoverage) {
    return {
      ...result,
      status: "low_coverage",
      isError: true,
      errors: [
        {
          where: "coverage",
          message: `命中率 ${(coverage * 100).toFixed(0)}% 低于阈值 ${(minCoverage * 100).toFixed(0)}%，未提交（避免交半成品）`,
        },
      ],
    };
  }

  if (attempts != null && attempts.used != null && attempts.limit != null && attempts.limit > 0 && attempts.used >= attempts.limit) {
    return {
      ...result,
      status: "no_attempts_left",
      isError: true,
      errors: [{ where: "attempts", message: `作答次数已用完（${attempts.used}/${attempts.limit}），无法提交` }],
    };
  }

  const answers: SaveAnswerInput[] = solved
    .filter((q) => q.option_ids.length > 0 || (q.text != null && q.text !== ""))
    .map((q) => ({
      question_id: q.question_id,
      ...(q.option_ids.length > 0 ? { option_ids: q.option_ids } : { text: q.text ?? "" }),
    }));

  const submitted = await submitHomework(
    {
      todo_id: todoId,
      answers,
      school_short_name: args.school_short_name,
      paper_type: args.paper_type,
      allow_exam: args.allow_exam,
    },
    ports,
  );

  return {
    ...result,
    status: submitted.submitted ? "ok" : "error",
    isError: !submitted.submitted,
    submitted: submitted.submitted,
    task_point: submitted.task_point,
    attempts: attempts == null ? result.attempts : { used: attempts.used, limit: attempts.limit, timed: attempts.timed },
    errors: submitted.errors,
  };
}

/**
 * Answer straight from the paper when the platform exposes it.
 *
 * Unit-level 随堂测试 return the correctness flag per option and the standard answer for fill-ins
 * **before submission**; chapter quizzes do not. Reading these is not a shortcut or a heuristic —
 * it is the platform's own data, and it is what let the whole 随堂测试 set be finished without
 * configuring any question bank.
 */
function answerFromPaper(q: HomeworkQuestion): { answer: string; option_ids: string[]; text: string | null } | null {
  const correct = (q.options ?? []).filter((o) => o.correct === true);
  if (correct.length > 0) {
    return { answer: correct.map((o) => o.content).join("#"), option_ids: correct.map((o) => o.id), text: null };
  }
  const std = (q.std_answer ?? "").trim();
  if (std !== "") {
    return { answer: std, option_ids: [], text: std };
  }
  return null;
}

function toSolved(q: HomeworkQuestion): SolvedQuestion {
  const options = (q.options ?? []).map((o) => ({ id: o.id, content: o.content }));
  const title = (q.stem_text ?? q.title ?? "").trim();
  return {
    index: q.index,
    question_id: q.question_id,
    type: mapQuestionType(q.type),
    type_label: q.type_label ?? "",
    title,
    options,
    answer: null,
    answerer: null,
    source: null,
    option_ids: [],
    text: null,
    note: null,
  };
}

/** 从课程目录读这道卷子的作答次数；随堂测试没有这些字段，会返回全 null。 */
async function readAttempts(
  parsed: NonNullable<ReturnType<typeof parseTodoId>>,
  ports: Icourse163Ports | undefined,
  schoolShortName: string | undefined,
): Promise<{ used: number | null; limit: number | null; timed: boolean }> {
  if (ports == null) {
    return { used: null, limit: null, timed: false };
  }
  const session = await resolveSession(ports);
  if (!session.ok) {
    return { used: null, limit: null, timed: false };
  }
  const moc = await fetchMocTermDto({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    course: {
      course_id: parsed.course_id,
      term_id: parsed.term_id,
      // 必须传真实学校简称：目录请求的 referer 由它拼出来，空串会导致取不到目录
      school_short_name: schoolShortName?.trim() ?? "",
    },
  });
  if (moc == null) {
    return { used: null, limit: null, timed: false };
  }
  type Rec = Record<string, unknown>;
  for (const ch of ((moc.chapters ?? []) as Rec[])) {
    for (const quiz of ((ch.quizs ?? []) as Rec[])) {
      if (String(quiz.id) !== parsed.content_id) {
        continue;
      }
      const test = (quiz.test ?? {}) as Rec;
      const used = Number(test.usedTryCount);
      const limit = Number(test.trytime);
      const time = Number(test.testTime);
      return {
        used: Number.isFinite(used) ? used : null,
        limit: Number.isFinite(limit) ? limit : null,
        timed: Number.isFinite(time) && time > 0,
      };
    }
  }
  return { used: null, limit: null, timed: false };
}
