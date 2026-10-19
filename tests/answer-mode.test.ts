import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { solveHomework } from "../src/solve-homework";
import { solveQuiz } from "../src/solve-quiz";

type Rec = Record<string, unknown>;
const SESSION = "NTESSTUDYSI=test-session";
const QUIZ_TODO = "1449647163:1488389457:quiz:501";

/** 目录 + 试卷：试卷带一个带"自带答案"的单选题（模拟随堂测试）。 */
function catalogBody() {
  return {
    code: 0,
    result: {
      chapters: [
        {
          id: 1,
          quizs: [{ id: 501, name: "单元测试", contentId: 601, test: { id: 601 } }],
          homeworks: [],
          lessons: [{ id: 2, name: "ls", units: [] }],
        },
      ],
    },
  };
}

/** 客观题带 optionDtos[].answer —— 只有随堂测试会这样。 */
function paperWithPaperAnswers() {
  return {
    code: 0,
    result: {
      id: 601,
      name: "单元测试",
      objectiveQList: [
        {
          id: 7001,
          type: 1,
          title: "<p>1+1=?</p>",
          optionDtos: [
            { id: 11, content: "A. 1", answer: false },
            { id: 12, content: "B. 2", answer: true },
          ],
        },
      ],
      subjectiveQList: [],
    },
  };
}

/** 客观题**不带** answer —— 模拟章节测验。 */
function paperWithoutAnswers() {
  return {
    code: 0,
    result: {
      id: 601,
      name: "单元测试",
      objectiveQList: [
        {
          id: 7001,
          type: 1,
          title: "<p>1+1=?</p>",
          optionDtos: [
            { id: 11, content: "A. 1" },
            { id: 12, content: "B. 2" },
          ],
        },
      ],
      subjectiveQList: [],
    },
  };
}

function stubHttp(paper: unknown) {
  const calls: { url: string; json?: unknown }[] = [];
  const http = {
    async request(input: { url: string; method?: string; json?: unknown; cookie?: string }) {
      const url = String(input.url);
      calls.push({ url, json: input.json });
      const cookie = `${input.cookie ?? SESSION}; STUDY_INFO=ok`;
      if ((input.method ?? "GET").toUpperCase() === "GET") {
        return { statusCode: 200, url, body: "<html>ok</html>", cookie };
      }
      if (url.includes("getLastLearnedMocTermDto")) return { statusCode: 200, url, body: JSON.stringify(catalogBody()), cookie };
      if (url.includes("getOpen")) return { statusCode: 200, url, body: JSON.stringify(paper), cookie };
      return { statusCode: 200, url, body: JSON.stringify({ code: 0, result: { score: 10 } }), cookie };
    },
  };
  const credentials = { async getCookie() { return SESSION; } };
  return { calls, ports: { credentials, http } as never };
}

/** 假题库：记录被问了几次。 */
function fakeTiku(answer: string | null) {
  let hits = 0;
  const fetchImpl = (async () => {
    hits += 1;
    return {
      status: 200,
      text: JSON.stringify({ code: answer == null ? 0 : 1, answer }),
    };
  }) as never;
  return { fetchImpl, hits: () => hits };
}

const TIKU_CONFIG = JSON.stringify([
  { name: "假题库", url: "http://x/t", method: "post", data: { q: "${title}" }, handler: "return (r) => r.code === 1 ? ['q', r.answer] : ['没答案', undefined]" },
]);

describe("answer_mode: paper", () => {
  test("uses the paper's own answer and never asks the bank", async () => {
    const { ports } = stubHttp(paperWithPaperAnswers());
    const tiku = fakeTiku("B"); // 题库也会答，但 paper 模式不该问它
    const out = await solveQuiz({ todo_id: QUIZ_TODO, answer_mode: "paper" }, ports, tiku.fetchImpl);
    assert.equal(out.answer_mode, "paper");
    assert.equal(out.answered, 1);
    assert.equal(out.questions[0].source, "paper");
    assert.deepEqual(out.questions[0].option_ids, ["12"]);
    assert.equal(tiku.hits(), 0, "paper 模式不能访问题库");
  });

  test("with no paper answers it simply answers nothing (does not fall back)", async () => {
    const { ports } = stubHttp(paperWithoutAnswers());
    const tiku = fakeTiku("B");
    const out = await solveQuiz({ todo_id: QUIZ_TODO, answer_mode: "paper" }, ports, tiku.fetchImpl);
    assert.equal(out.answered, 0);
    assert.equal(tiku.hits(), 0, "显式 paper 模式不得回退到题库");
  });
});

describe("answer_mode: tiku", () => {
  test("ignores the paper's own answers and asks the bank", async () => {
    const { ports } = stubHttp(paperWithPaperAnswers());
    const tiku = fakeTiku("B");
    const out = await solveQuiz({ todo_id: QUIZ_TODO, answer_mode: "tiku", tiku_config: TIKU_CONFIG }, ports, tiku.fetchImpl);
    assert.equal(out.answer_mode, "tiku");
    assert.equal(tiku.hits(), 1, "tiku 模式必须真的问题库");
    assert.equal(out.questions[0].source, "tiku");
    assert.equal(out.questions[0].answerer, "假题库");
  });

  test("with no bank configured it answers nothing", async () => {
    const { ports } = stubHttp(paperWithPaperAnswers());
    const out = await solveQuiz({ todo_id: QUIZ_TODO, answer_mode: "tiku" }, ports, fakeTiku("B").fetchImpl);
    assert.equal(out.answered, 0);
    assert.equal(out.questions[0].source, null, "tiku 模式不得偷偷用试卷答案");
  });
});

describe("answer_mode: agent", () => {
  test("without answers it only returns the questions", async () => {
    const { calls, ports } = stubHttp(paperWithoutAnswers());
    const out = await solveQuiz({ todo_id: QUIZ_TODO, answer_mode: "agent" }, ports);
    assert.equal(out.status, "questions");
    assert.equal(out.isError, false);
    assert.equal(out.answered, 0);
    assert.equal(calls.filter((c) => c.url.includes("submitAnswers")).length, 0);
  });

  test("with answers it marks them as agent-sourced", async () => {
    const { ports } = stubHttp(paperWithoutAnswers());
    const out = await solveQuiz(
      { todo_id: QUIZ_TODO, answer_mode: "agent", answers: [{ question_id: "7001", option_ids: ["11"] }] },
      ports,
    );
    assert.equal(out.answered, 1);
    assert.equal(out.questions[0].source, "agent");
    assert.deepEqual(out.questions[0].option_ids, ["11"]);
  });
});

describe("answer_mode: auto (default)", () => {
  test("prefers the paper and only asks the bank when needed", async () => {
    const { ports } = stubHttp(paperWithoutAnswers());
    const tiku = fakeTiku("B");
    const out = await solveQuiz({ todo_id: QUIZ_TODO, tiku_config: TIKU_CONFIG }, ports, tiku.fetchImpl);
    assert.equal(out.answer_mode, "auto");
    assert.equal(out.questions[0].source, "tiku", "没有试卷答案时才问题库");
    assert.equal(tiku.hits(), 1);
  });
});

describe("solve_homework answer_mode", () => {
  test('rejects "tiku" outright instead of pretending to try', async () => {
    const { calls, ports } = stubHttp(paperWithoutAnswers());
    const out = await solveHomework({ todo_id: "1449647163:1488389457:homework:501", answer_mode: "tiku" }, ports);
    assert.equal(out.status, "unsupported");
    assert.equal(out.isError, true);
    assert.equal(calls.length, 0, "被拒时不该发任何请求");
  });
});
