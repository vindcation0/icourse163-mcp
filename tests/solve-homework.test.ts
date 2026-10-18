import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { solveHomework } from "../src/solve-homework";

type Rec = Record<string, unknown>;

const SESSION = "NTESSTUDYSI=test-session";
const TODO = "1449647163:1488389457:homework:501";
const TODO_EXAM = "1449647163:1488389457:exam:999";
const ESSAY = "田径运动具有健身、竞技、教育三大功能，同时也是社会交往与文化传承的载体。";

/** 目录：一个章节里挂一个作业（catalog id 501 → 试卷 tid 601）。 */
function catalogBody() {
  return {
    code: 0,
    result: {
      chapters: [
        {
          id: 1,
          name: "ch",
          quizs: [],
          homeworks: [{ id: 501, name: "单元作业", contentId: 601, test: { id: 601 } }],
          lessons: [{ id: 2, name: "ls", units: [] }],
        },
      ],
    },
  };
}

/** 作业卷：默认一道主观题。 */
function paperBody(opts: { subjective?: Rec[]; objective?: Rec[] } = {}) {
  return {
    code: 0,
    result: {
      id: 601,
      name: "单元作业",
      objectiveQList: opts.objective ?? [],
      subjectiveQList: opts.subjective ?? [{ id: 9001, title: "<p>田径运动的主要功能是什么？</p>" }],
    },
  };
}

/**
 * 一个按 URL 分流的 http 桩。
 * getHomework 会先 GET 一次暖机会话，再打目录 RPC，最后打取卷 RPC —— 三步都要喂。
 */
function stubHttp(paper: unknown, onWrite?: (input: { url: string; json?: unknown }) => { statusCode: number; body: string }) {
  const calls: { url: string; json?: unknown }[] = [];
  const http = {
    async request(input: { url: string; method?: string; json?: unknown; cookie?: string }) {
      const url = String(input.url);
      calls.push({ url, json: input.json });
      const cookie = `${input.cookie ?? SESSION}; STUDY_INFO=ok`;
      const isGet = (input.method ?? "GET").toUpperCase() === "GET";
      if (isGet) {
        return { statusCode: 200, url, body: "<html>ok</html>", cookie };
      }
      if (url.includes("getLastLearnedMocTermDto")) {
        return { statusCode: 200, url, body: JSON.stringify(catalogBody()), cookie };
      }
      if (url.includes("getOpen")) {
        return { statusCode: 200, url, body: JSON.stringify(paper), cookie };
      }
      if (url.includes("submitAnswers")) {
        const r = onWrite?.({ url, json: input.json }) ?? {
          statusCode: 200,
          body: JSON.stringify({ code: 0, result: { score: 10 } }),
        };
        return { statusCode: r.statusCode, url, body: r.body, cookie };
      }
      return { statusCode: 200, url, body: JSON.stringify({ code: 0, result: {} }), cookie };
    },
  };
  const credentials = { async getCookie() { return SESSION; } };
  return { calls, ports: { credentials, http } as never };
}

const writes = (calls: { url: string; json?: unknown }[]) => calls.filter((c) => c.url.includes("submitAnswers"));

describe("solveHomework", () => {
  test("with todo_id only it returns the questions and writes nothing", async () => {
    const { calls, ports } = stubHttp(paperBody());
    const out = await solveHomework({ todo_id: TODO }, ports);
    assert.equal(out.isError, false, JSON.stringify(out.errors));
    assert.equal(out.status, "questions");
    assert.equal(out.question_count, 1);
    assert.equal(out.answered, 0);
    assert.equal(out.questions[0].bank, "subjective");
    assert.equal(out.questions[0].title, "田径运动的主要功能是什么？");
    assert.equal(out.questions[0].answer_ok, false);
    assert.equal(writes(calls).length, 0, "读题阶段不能有写请求");
  });

  test("refuses to write anything when a question has no acceptable answer", async () => {
    const { calls, ports } = stubHttp(paperBody());
    const out = await solveHomework(
      { todo_id: TODO, answers: [{ question_id: "9001", text: "   " }], submit: true },
      ports,
    );
    assert.equal(out.status, "incomplete");
    assert.equal(out.isError, true);
    assert.equal(out.missing.length, 1);
    assert.equal(out.missing[0].question_id, "9001");
    assert.equal(out.submitted, false);
    assert.equal(writes(calls).length, 0);
  });

  test("defaults to a draft, never a submit", async () => {
    const { calls, ports } = stubHttp(paperBody());
    const out = await solveHomework({ todo_id: TODO, answers: [{ question_id: "9001", text: ESSAY }] }, ports);
    assert.equal(out.status, "drafted", JSON.stringify(out.errors));
    assert.equal(out.draft_saved, true);
    assert.equal(out.submitted, false);
    const w = writes(calls);
    assert.equal(w.length, 1);
    assert.equal((w[0].json as Rec).preview, true, "草稿必须是 preview:true");
  });

  test("submits formally only when submit:true is passed", async () => {
    const { calls, ports } = stubHttp(paperBody());
    const out = await solveHomework({ todo_id: TODO, answers: [{ question_id: "9001", text: ESSAY }], submit: true }, ports);
    assert.equal(out.status, "submitted", JSON.stringify(out.errors));
    assert.equal(out.submitted, true);
    const w = writes(calls);
    assert.equal(w.length, 1);
    assert.equal((w[0].json as Rec).preview, false, "正式提交必须是 preview:false");
  });

  test("reports draft_rejected instead of pretending the draft saved", async () => {
    // 真实拒绝是"非 0 code + 含「预览不能提交」的消息"（见 homework.ts 的 isPreviewSubmitRejectedMessage）
    const { ports } = stubHttp(paperBody(), () => ({
      statusCode: 200,
      body: JSON.stringify({ code: -1, message: "预览不能提交！" }),
    }));
    const out = await solveHomework({ todo_id: TODO, answers: [{ question_id: "9001", text: ESSAY }] }, ports);
    assert.equal(out.status, "draft_rejected", JSON.stringify(out).slice(0, 300));
    assert.equal(out.isError, true);
    assert.equal(out.draft_saved, false);
  });

  test("validates option ids for objective questions", async () => {
    const paper = paperBody({
      objective: [
        { id: 7001, type: 1, title: "<p>选一个</p>", optionDtos: [{ id: 11, content: "A" }, { id: 12, content: "B" }] },
      ],
      subjective: [],
    });
    const bad = await solveHomework(
      { todo_id: TODO, answers: [{ question_id: "7001", option_ids: ["999"] }] },
      stubHttp(paper).ports,
    );
    assert.equal(bad.status, "incomplete");
    assert.match(bad.missing[0].problem, /未知选项/);

    const ok = await solveHomework(
      { todo_id: TODO, answers: [{ question_id: "7001", option_ids: ["12"] }] },
      stubHttp(paper).ports,
    );
    assert.equal(ok.status, "drafted", JSON.stringify(ok.errors));
  });

  test("exam source stays closed unless allow_exam is true", async () => {
    const { calls, ports } = stubHttp(paperBody());
    const out = await solveHomework({ todo_id: TODO_EXAM, answers: [{ question_id: "1", text: "x" }] }, ports);
    assert.equal(out.status, "exam_out_of_scope");
    assert.equal(out.isError, true);
    assert.equal(calls.length, 0, "被拒时不该发任何请求");
  });
});
