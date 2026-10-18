/**
 * 单元作业（主观论述题）的流水线封装。
 *
 * 为什么需要它：作业卷全是 `type=10` 主观题、无选项，题库完全无用（实测 `solve_quiz` 对它们是
 * 「已答 0 / 覆盖率 0%」）。所以"写正文"必须由 agent 或人来完成 —— 这个模块只负责把
 *
 *     读题 → 校验每道题都有人写的答案 → （草稿 | 直接提交）→ 报告真实结果
 *
 * 这一步顺序固定下来，并**默认只存草稿**：正式提交要显式 `submit: true`，
 * 因为主观题交出去之后通常只能等老师批改，撤回不了。
 */
import {
  getHomework,
  parseTodoId,
  saveHomeworkAnswers,
  submitHomework,
  type HomeworkQuestion,
  type SaveAnswerInput,
} from "./homework";
import type { Icourse163Ports } from "./ports";

export type SolveHomeworkArgs = {
  todo_id: string;
  /** 不传（或空数组）= 只读题，返回题目清单，不写任何东西。 */
  answers?: SaveAnswerInput[];
  /** true = 直接正式提交；缺省 / false = 只存草稿。由用户决定。 */
  submit?: boolean;
  school_short_name?: string;
  paper_type?: "quiz" | "homework";
  /** 显式允许考试来源；默认关闭，与 submit_homework 一致。 */
  allow_exam?: boolean;
};

export type SolveHomeworkQuestion = {
  index: number;
  question_id: string;
  type: number;
  type_label: string;
  /** 题干（已清洗 HTML）。 */
  title: string;
  /** 客观题的选项；主观题为空数组。 */
  options: { id: string; content: string }[];
  bank: "objective" | "subjective";
  /** 提供的答案是否可接受（有正文 / 有选项）。 */
  answer_ok: boolean;
  /** 被拒的原因，或 null。 */
  problem: string | null;
};

export type SolveHomeworkStatus =
  | "questions"
  | "drafted"
  | "submitted"
  | "incomplete"
  | "draft_rejected"
  | "auth_expired"
  | "not_found"
  | "unsupported"
  | "exam_out_of_scope"
  | "error";

export type SolveHomeworkResult = {
  isError: boolean;
  status: SolveHomeworkStatus;
  todo_id: string;
  title: string | null;
  paper_type: string | null;
  question_count: number;
  /** 有多少题的答案是可接受的。 */
  answered: number;
  /** 缺答案/答案不合格的题，给调用方看要补什么。 */
  missing: { question_id: string; title: string; problem: string }[];
  questions: SolveHomeworkQuestion[];
  /** 草稿是否真的落盘（部分卷子会拒绝 preview，见 docs/mcp.md）。 */
  draft_saved: boolean;
  submitted: boolean;
  task_point?: "marked" | "failed" | "skipped";
  errors: { where: string; message: string }[];
};

export async function solveHomework(
  args: SolveHomeworkArgs,
  ports?: Icourse163Ports,
): Promise<SolveHomeworkResult> {
  const todoId = args.todo_id.trim();
  const parsed = parseTodoId(todoId);
  const base: SolveHomeworkResult = {
    isError: false,
    status: "questions",
    todo_id: todoId,
    title: null,
    paper_type: null,
    question_count: 0,
    answered: 0,
    missing: [],
    questions: [],
    draft_saved: false,
    submitted: false,
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
          message: "考试默认关闭；要提交考试请显式传 allow_exam: true。",
        },
      ],
    };
  }

  const hw = await getHomework(
    { todo_id: todoId, school_short_name: args.school_short_name, paper_type: args.paper_type },
    ports,
  );
  if (hw.isError) {
    const status: SolveHomeworkStatus =
      hw.status === "exam_out_of_scope"
        ? "exam_out_of_scope"
        : hw.status === "auth_expired"
          ? "auth_expired"
          : hw.status === "not_found"
            ? "not_found"
            : hw.status === "unsupported"
              ? "unsupported"
              : "error";
    return { ...base, isError: true, status, title: hw.title ?? null, errors: hw.errors };
  }

  const questions = hw.questions ?? [];
  const byId = new Map<string, SaveAnswerInput>();
  for (const a of args.answers ?? []) {
    if (a?.question_id != null) {
      byId.set(String(a.question_id).trim(), a);
    }
  }

  const judged: SolveHomeworkQuestion[] = questions.map((q) => judgeQuestion(q, byId.get(q.question_id)));
  const missing = judged
    .filter((q) => !q.answer_ok)
    .map((q) => ({ question_id: q.question_id, title: q.title, problem: q.problem ?? "缺少答案" }));
  const answered = judged.filter((q) => q.answer_ok).length;

  const result: SolveHomeworkResult = {
    ...base,
    title: hw.title ?? null,
    paper_type: hw.paper_type ?? null,
    question_count: judged.length,
    answered,
    missing,
    questions: judged,
  };

  // ① 只读题：给了 todo_id 但没给答案。
  //    空的 answers 也算"只想看题"，因为这是最容易的调用方式，不该被当成错误。
  const wantsWrite = args.answers != null && args.answers.length > 0;
  if (!wantsWrite) {
    return result;
  }

  // ② 有题没答上就不写任何东西 —— 避免交半成品或被草稿污染。
  if (missing.length > 0) {
    return {
      ...result,
      isError: true,
      status: "incomplete",
      errors: [
        {
          where: "answers",
          message: `${missing.length} 道题还没有可接受的答案，未写入任何内容（${missing
            .map((m) => m.question_id)
            .join(", ")}）`,
        },
      ],
    };
  }

  const answers: SaveAnswerInput[] = judged.map((q) => byId.get(q.question_id)!);

  // ③ 用户选择：直接提交，还是只存草稿。
  if (args.submit === true) {
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
    const status: SolveHomeworkStatus = submitted.submitted
      ? "submitted"
      : submitted.status === "rejected"
        ? "error"
        : "error";
    return {
      ...result,
      status,
      isError: !submitted.submitted,
      submitted: submitted.submitted,
      task_point: submitted.task_point,
      errors: submitted.errors,
    };
  }

  // ④ 默认：只存草稿。部分卷子会拒绝 preview，要如实报出来而不是假装成功。
  const draft = await saveHomeworkAnswers(
    {
      todo_id: todoId,
      answers,
      school_short_name: args.school_short_name,
      paper_type: args.paper_type,
    },
    ports,
  );
  if (draft.isError) {
    return {
      ...result,
      isError: true,
      status: "draft_rejected",
      draft_saved: false,
      errors: [
        ...draft.errors,
        {
          where: "draft",
          message:
            "这份卷子不接受草稿（部分卷子只允许正式提交）。若确实要交，请显式传 submit: true。",
        },
      ],
    };
  }
  return { ...result, status: "drafted", draft_saved: true, errors: draft.errors };
}

/** 判断某道题的答案能不能用；主观题要正文，客观题要选项。 */
function judgeQuestion(q: HomeworkQuestion, answer: SaveAnswerInput | undefined): SolveHomeworkQuestion {
  const base = {
    index: q.index,
    question_id: q.question_id,
    type: q.type,
    type_label: q.type_label,
    title: (q.stem_text ?? q.title ?? "").trim(),
    options: (q.options ?? []).map((o) => ({ id: o.id, content: o.content })),
    bank: q.bank,
  };
  if (answer == null) {
    return { ...base, answer_ok: false, problem: "缺少答案" };
  }
  if (q.bank === "subjective") {
    const text = (answer.text ?? "").trim();
    if (text === "") {
      return { ...base, answer_ok: false, problem: "主观题需要非空的 text" };
    }
    return { ...base, answer_ok: true, problem: null };
  }
  const optionIds = (answer.option_ids ?? []).map((id) => id.trim()).filter(Boolean);
  if (optionIds.length === 0) {
    return { ...base, answer_ok: false, problem: "客观题需要 option_ids" };
  }
  const allowed = new Set(base.options.map((o) => o.id));
  const unknown = optionIds.filter((id) => !allowed.has(id));
  if (unknown.length > 0) {
    return { ...base, answer_ok: false, problem: `option_ids 含未知选项：${unknown.join(", ")}` };
  }
  return { ...base, answer_ok: true, problem: null };
}
