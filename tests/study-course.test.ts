import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyUnit, flattenUnits, studyCourse, type StudyCourseArgs } from "../src/study-course";

type Unit = {
  id: string;
  name: string;
  contentType: number;
  contentId: string;
  completePercent: number;
  viewStatus: string;
};

const COURSE: StudyCourseArgs = { course_id: "1", term_id: "2", school_short_name: "X" };

/** 4 个单元：视频（未完成）、文档（已完成）、随堂测试（未完成）、讨论（未完成）。 */
const UNITS: Unit[] = [
  { id: "u1", name: "视频1", contentType: 1, contentId: "c1", completePercent: 0, viewStatus: "not-viewed" },
  { id: "u2", name: "文档1", contentType: 3, contentId: "c2", completePercent: 1, viewStatus: "completed" },
  { id: "u3", name: "随堂1", contentType: 5, contentId: "c3", completePercent: 0, viewStatus: "not-viewed" },
  { id: "u4", name: "讨论1", contentType: 6, contentId: "c4", completePercent: 0, viewStatus: "not-viewed" },
];

/** 章节测验夹具：默认空，需要时按用例注入。 */
const QUIZZES: { id: string; name: string; usedTryCount: number; trytime: number; viewStatus: string; totalScore: number | null; userScore: number | null }[] = [];

function deps(overrides: Partial<Parameters<typeof studyCourse>[1]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      listUnits: async () => UNITS,
      studyOne: async ({ unit }: { unit: Unit }) => {
        calls.push(`media:${unit.id}`);
        return { ok: true, detail: "ok" };
      },
      quizOne: async ({ unit }: { unit: Unit }) => {
        calls.push(`quiz:${unit.id}`);
        return { ok: true, detail: "ok" };
      },
      discussOne: async ({ unit }: { unit: Unit }) => {
        calls.push(`discuss:${unit.id}`);
        return { ok: true, detail: "ok" };
      },
      listQuizzes: async () => QUIZZES,
      chapterQuizOne: async ({ quiz }: { quiz: { id: string } }) => {
        calls.push(`chapter:${quiz.id}`);
        return { ok: true, detail: "ok" };
      },
      sleep: async () => undefined,
      ...overrides,
    } as never,
  };
}

describe("classifyUnit", () => {
  test("maps content types to the three parts", () => {
    assert.equal(classifyUnit(1), "media");
    assert.equal(classifyUnit(3), "media");
    assert.equal(classifyUnit(4), "media");
    assert.equal(classifyUnit(5), "quiz");
    assert.equal(classifyUnit(6), "discussion");
    assert.equal(classifyUnit(7), null);
    assert.equal(classifyUnit(2), null);
  });
});

describe("flattenUnits", () => {
  test("walks chapters → lessons → units", () => {
    const moc = { chapters: [{ lessons: [{ units: [{ id: 9, name: "a", contentType: 1 }] }] }] };
    const rows = flattenUnits(moc);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "9");
    assert.equal(rows[0].contentType, 1);
  });

  test("tolerates junk", () => {
    assert.deepEqual(flattenUnits(null), []);
    assert.deepEqual(flattenUnits({}), []);
  });
});

describe("studyCourse", () => {
  test("dry run lists work and writes nothing", async () => {
    const { calls, deps: d } = deps();
    const out = await studyCourse({ ...COURSE, dry_run: true }, d);
    assert.equal(out.status, "dry_run");
    assert.equal(calls.length, 0, "dry run 不能产生任何写操作");
    assert.deepEqual(out.counts.planned, { media: 1, quiz: 1, discussion: 1, chapter_quiz: 0 });
    assert.equal(out.counts.units_complete_before, 1);
  });

  test("runs all three parts and skips complete units", async () => {
    const { calls, deps: d } = deps();
    const out = await studyCourse(COURSE, d);
    assert.equal(out.status, "ok", JSON.stringify(out.errors));
    assert.deepEqual(calls.sort(), ["discuss:u4", "media:u1", "quiz:u3"]);
    assert.deepEqual(out.counts.done, { media: 1, quiz: 1, discussion: 1, chapter_quiz: 0 });
    assert.equal(out.counts.failed, 0);
  });

  test("include narrows the work", async () => {
    const { calls, deps: d } = deps();
    const out = await studyCourse({ ...COURSE, include: ["media"] }, d);
    assert.deepEqual(calls, ["media:u1"]);
    // planned 的语义是"本次实际要跑的量"，未选中的部分不计入
    assert.deepEqual(out.counts.planned, { media: 1, quiz: 0, discussion: 0, chapter_quiz: 0 });
    assert.equal(out.counts.done.quiz, 0);
  });

  test("a quiz with no answer is skipped, not guessed, and does not fail the run", async () => {
    const { deps: d } = deps({
      quizOne: async () => ({ ok: false, detail: "no_tiku", skip: "no_answer" as const }),
    });
    const out = await studyCourse(COURSE, d);
    assert.equal(out.status, "ok");
    assert.equal(out.counts.skipped.quiz, 1);
    assert.equal(out.counts.failed, 0);
    assert.ok(out.notes.some((n) => n.includes("题库")));
  });

  test("missing browser session skips discussions without killing the run", async () => {
    const { deps: d } = deps({
      discussOne: async () => ({ ok: false, detail: "no_session", skip: "no_session" as const }),
    });
    const out = await studyCourse(COURSE, d);
    assert.equal(out.counts.skipped.discussion, 1);
    assert.ok(out.notes.some((n) => n.includes("浏览器登录")));
  });

  test("a thrown error becomes a failure entry, not a crash", async () => {
    const { deps: d } = deps({
      studyOne: async () => {
        throw new Error("boom");
      },
    });
    const out = await studyCourse(COURSE, d);
    assert.equal(out.counts.failed, 1);
    assert.equal(out.failures.length, 1);
    assert.equal(out.failures[0].unit_id, "u1");
    assert.match(out.failures[0].detail ?? "", /boom/);
    assert.equal(out.status, "partial", "其他部分成功时是 partial 而不是 error");
  });

  test("chapter quizzes are planned and run, reusing nothing already submitted", async () => {
    const quizzes = [
      { id: "q1", name: "未做测验", usedTryCount: 0, trytime: 20, viewStatus: "0", totalScore: 100, userScore: null },
      { id: "q2", name: "已交测验", usedTryCount: 1, trytime: 20, viewStatus: "5", totalScore: 100, userScore: 25 },
      { id: "q3", name: "次数用完", usedTryCount: 20, trytime: 20, viewStatus: "0", totalScore: 100, userScore: null },
    ];
    const calls: string[] = [];
    const d = {
      listUnits: async () => [],
      listQuizzes: async () => quizzes,
      chapterQuizOne: async ({ quiz }: { quiz: { id: string } }) => {
        calls.push(quiz.id);
        return { ok: true, detail: "ok" };
      },
      sleep: async () => undefined,
    } as never;
    // 单元为空会被当成 no_units，所以给一个已完成的单元骗过前置检查
    const d2 = { ...(d as object), listUnits: async () => [UNITS[1]] } as never;
    const out = await studyCourse({ ...COURSE, include: ["chapter_quiz"] }, d2);
    assert.deepEqual(calls, ["q1"], "只做未交且还有次数的");
    assert.equal(out.counts.done.chapter_quiz, 1);
    assert.ok(out.notes.some((n) => n.includes("已交过")));
  });

  test("respects max_units and says so", async () => {
    const { calls, deps: d } = deps();
    const out = await studyCourse({ ...COURSE, max_units: 1 }, d);
    assert.equal(calls.length, 1);
    assert.ok(out.notes.some((n) => n.includes("max_units")));
  });

  test("reports completion before and after", async () => {
    const { deps: d } = deps();
    const out = await studyCourse(COURSE, d);
    assert.equal(out.counts.units_total, 4);
    assert.equal(out.counts.units_complete_before, 1);
    // listUnits 是同一个桩，前后都是同一份数据
    assert.equal(out.counts.units_complete_after, 1);
  });

  test("verbose adds per-unit items, default omits them", async () => {
    const { deps: d } = deps();
    const plain = await studyCourse(COURSE, d);
    assert.equal(plain.items, undefined);
    const { deps: d2 } = deps();
    const loud = await studyCourse({ ...COURSE, verbose: true }, d2);
    assert.equal(loud.items?.length, 3);
  });
});
