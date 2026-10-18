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
  parseTikuConfig,
  queryTiku,
  type AnswererWrapper,
  type TikuFetch,
  type TikuQuestion,
  type TikuQuestionType,
} from "./tiku";

export type SolveQuizArgs = {
  todo_id: string;
  school_short_name?: string;
  /** 题库配置（JSON 文本）。不传就只读题，不做任何查询。 */
  tiku_config?: string;
  /** 只有 true 才真的提交；默认 false（只出清单）。 */
  submit?: boolean;
  /** 覆盖率下限，默认 0.8。低于它一律不提交。 */
  min_coverage?: number;
  paper_type?: "quiz" | "homework";
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
  /** paper = 平台自己给的答案；tiku = 题库给的；null = 没答上。 */
  source: "paper" | "tiku" | null;
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
  | "no_attempts_left"
  | "error";

export type SolveQuizResult = {
  isError: boolean;
  status: SolveQuizStatus;
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

  if (parsed?.source === "exam") {
    return {
      ...base,
      isError: true,
      status: "exam_out_of_scope",
      errors: [{ where: "exam", message: "考试代交不做：solve_quiz 拒绝 exam 来源。" }],
    };
  }

  let config: AnswererWrapper[] = [];
  if (args.tiku_config != null && args.tiku_config.trim() !== "") {
    try {
      config = parseTikuConfig(args.tiku_config);
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

  // ① 试卷自带答案优先。随堂测试（contentType 5）在**提交前**就返回
  //    `optionDtos[].answer` 与填空题的 `stdAnswer`，所以这类卷子根本不需要题库；
  //    章节测验不返回这些字段（实测 0/10），走 ②。
  for (const [index, question] of solved.entries()) {
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

  // ② 剩下的才问题库。
  if (config.length > 0) {
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
    title: hw.title ?? null,
    paper_type: hw.paper_type ?? null,
    question_count: solved.length,
    answered,
    coverage,
    attempts: attemptInfo,
    questions: solved,
  };

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
