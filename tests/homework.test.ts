import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TERM_RPC_URL, WARMUP_URL } from "../src/auth";
import {
  HOMEWORK_PAPER_RPC_URL,
  QUIZ_PAPER_RPC_URL,
  SUBMIT_ANSWERS_RPC_URL,
  getHomework,
  isPreviewSubmitRejectedMessage,
  parsePaperQuestions,
  parseTodoId,
  previewRejectedUserMessage,
  resolvePaperTarget,
  saveHomeworkAnswers,
  stripHtml,
  submitHomework,
} from "../src/homework";
import type {
  Icourse163Http,
  Icourse163HttpRequest,
  Icourse163Ports,
} from "../src/ports";
import { mocTermBody } from "./fixtures";

const SESSION = "NTESSTUDYSI=test-session";
const TODO_QUIZ = "1001:2001:quiz:301";
const TODO_EXAM = "1001:2001:exam:502";

const SAMPLE_PAPER = {
  aid: 90001,
  tid: 301,
  tname: "第一章单元测验",
  objectiveQList: [
    {
      id: 11,
      type: 1,
      title: "<p>1+1=?</p>",
      optionDtos: [
        { id: 101, content: "<p>A. 1</p>" },
        { id: 102, content: "<p>B. 2</p>" },
      ],
    },
    {
      id: 12,
      type: 2,
      title: "多选",
      optionDtos: [
        { id: 201, content: "A" },
        { id: 202, content: "B" },
      ],
    },
  ],
  subjectiveQList: [
    {
      id: 21,
      type: 4,
      title: "简述牛顿定律",
      answer: "",
    },
  ],
};

function paperBody(paper: unknown = SAMPLE_PAPER): string {
  return JSON.stringify({ code: 0, result: paper });
}

function portsWith(
  getCookie: () => Promise<string | null>,
  http: Icourse163Http,
): Icourse163Ports {
  return { credentials: { getCookie }, http };
}

function recordingHttp(
  handler: (input: Icourse163HttpRequest) => {
    statusCode: number;
    body: string;
    cookie?: string;
  },
): { calls: Icourse163HttpRequest[]; http: Icourse163Http } {
  const calls: Icourse163HttpRequest[] = [];
  return {
    calls,
    http: {
      async request(input) {
        calls.push(input);
        const result = handler(input);
        return {
          statusCode: result.statusCode,
          url: input.url,
          body: result.body,
          cookie: result.cookie ?? input.cookie,
        };
      },
    },
  };
}

function warmupOk(input: Icourse163HttpRequest): {
  statusCode: number;
  body: string;
  cookie: string;
} | null {
  if ((input.method ?? "GET") === "GET" && input.url === WARMUP_URL) {
    return {
      statusCode: 200,
      body: "<html>ok</html>",
      cookie: `${input.cookie}; STUDY_INFO=ok`,
    };
  }
  return null;
}

/** Identity catalog: contentId === catalog id (legacy test fixtures). */
function termEmptyOk(input: Icourse163HttpRequest): {
  statusCode: number;
  body: string;
} | null {
  if (input.url.startsWith(TERM_RPC_URL)) {
    return {
      statusCode: 200,
      body: mocTermBody({
        chapters: [
          {
            quizs: [
              {
                id: 301,
                name: "第一章单元测验",
                contentId: 301,
                test: { id: 301 },
              },
            ],
            homeworks: [],
            lessons: [
              {
                units: [
                  {
                    id: 401,
                    name: "旧版单元测验",
                    contentType: 5,
                    contentId: 401,
                  },
                ],
              },
            ],
          },
        ],
        exams: [{ id: 502, name: "考试", contentId: 502, test: { id: 502 } }],
      }),
    };
  }
  return null;
}

describe("parseTodoId / stripHtml / parsePaperQuestions", () => {
  test("parses list_todos compound id", () => {
    assert.deepEqual(parseTodoId(TODO_QUIZ), {
      course_id: "1001",
      term_id: "2001",
      source: "quiz",
      content_id: "301",
    });
    assert.equal(parseTodoId("bad"), null);
  });

  test("strips html for stem text", () => {
    assert.equal(stripHtml("<p>1&nbsp;+&nbsp;1</p>"), "1 + 1");
    assert.equal(
      stripHtml("&#8205;身体形态是指&#8205;"),
      "身体形态是指",
    );
  });

  test("parses objective and subjective questions", () => {
    const qs = parsePaperQuestions(SAMPLE_PAPER);
    assert.equal(qs.length, 3);
    assert.equal(qs[0].question_id, "11");
    assert.equal(qs[0].type_label, "单选题");
    assert.equal(qs[0].stem_text, "1+1=?");
    assert.equal(qs[0].options.length, 2);
    assert.equal(qs[0].bank, "objective");
    assert.equal(qs[2].bank, "subjective");
    assert.equal(qs[2].supports_save, true);
  });
});

describe("getHomework", () => {
  test("auth_expired without session", async () => {
    const result = await getHomework(
      { todo_id: TODO_QUIZ },
      portsWith(async () => null, {
        async request() {
          throw new Error("http should not run");
        },
      }),
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_expired");
    assert.equal(result.draft_only, true);
  });

  test("reads structured questions via quiz paper RPC", async () => {
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      const term = termEmptyOk(input);
      if (term) return term;
      if (input.url.startsWith(QUIZ_PAPER_RPC_URL)) {
        assert.equal(input.method, "POST");
        assert.ok(input.json != null);
        assert.deepEqual(input.json, { tid: 301 });
        return { statusCode: 200, body: paperBody() };
      }
      throw new Error(`unexpected ${input.url}`);
    });
    const result = await getHomework(
      { todo_id: TODO_QUIZ, school_short_name: "SJTU" },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.paper_type, "quiz");
    assert.equal(result.aid, "90001");
    assert.equal(result.question_count, 3);
    assert.equal(result.questions[0].options[1].content, "B. 2");
    assert.equal(result.draft_only, true);
    assert.ok(calls.some((c) => c.url.startsWith(QUIZ_PAPER_RPC_URL)));
  });

  test("uses homework paper RPC when paper_type=homework", async () => {
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      const term = termEmptyOk(input);
      if (term) return term;
      if (input.url.startsWith(HOMEWORK_PAPER_RPC_URL)) {
        assert.deepEqual(input.json, {
          tid: 301,
          withStdAnswerAndAnalyse: false,
        });
        return {
          statusCode: 200,
          body: paperBody({
            aid: 1,
            tid: 301,
            objectiveQList: [],
            subjectiveQList: [{ id: 9, type: 4, title: "作文" }],
          }),
        };
      }
      throw new Error(`unexpected ${input.url}`);
    });
    const result = await getHomework(
      { todo_id: TODO_QUIZ, paper_type: "homework" },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.paper_type, "homework");
    assert.equal(result.questions.length, 1);
  });
});

describe("saveHomeworkAnswers / submitHomework", () => {
  test("save posts submitAnswers with preview:true only", async () => {
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      const term = termEmptyOk(input);
      if (term) return term;
      if (input.url.startsWith(QUIZ_PAPER_RPC_URL)) {
        return { statusCode: 200, body: paperBody() };
      }
      if (input.url.startsWith(SUBMIT_ANSWERS_RPC_URL)) {
        const body = input.json as {
          preview?: unknown;
          paperDto?: { answers?: unknown[] };
        };
        assert.equal(body.preview, true);
        assert.ok(Array.isArray(body.paperDto?.answers));
        assert.equal(body.paperDto?.answers?.length, 1);
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: {} }) };
      }
      throw new Error(`unexpected ${input.url}`);
    });
    const result = await saveHomeworkAnswers(
      {
        todo_id: TODO_QUIZ,
        answers: [{ question_id: "11", option_ids: ["102"] }],
      },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.preview, true);
    assert.equal(result.submitted, false);
    assert.equal(result.results[0].status, "saved");
    const submitCall = calls.find((c) => c.url.startsWith(SUBMIT_ANSWERS_RPC_URL));
    assert.ok(submitCall);
    assert.equal((submitCall.json as { preview: boolean }).preview, true);
  });

  test("save rejects smuggled submit/preview=false", async () => {
    const result = await saveHomeworkAnswers(
      {
        todo_id: TODO_QUIZ,
        answers: [{ question_id: "11", option_ids: ["102"] }],
        submit: true,
      } as never,
      portsWith(async () => SESSION, {
        async request() {
          throw new Error("http should not run");
        },
      }),
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "rejected");
    assert.equal(result.submitted, false);
  });

  test("submit_homework posts preview:false and refuses exam", async () => {
    const exam = await submitHomework(
      {
        todo_id: TODO_EXAM,
        answers: [{ question_id: "11", option_ids: ["102"] }],
      },
      portsWith(async () => SESSION, {
        async request() {
          throw new Error("http should not run");
        },
      }),
    );
    assert.equal(exam.isError, true);
    assert.equal(exam.status, "exam_out_of_scope");
    assert.equal(exam.submitted, false);
    assert.equal(exam.preview, false);

    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      const term = termEmptyOk(input);
      if (term) return term;
      if (input.url.startsWith(QUIZ_PAPER_RPC_URL)) {
        return { statusCode: 200, body: paperBody() };
      }
      if (input.url.startsWith(SUBMIT_ANSWERS_RPC_URL)) {
        assert.equal((input.json as { preview: boolean }).preview, false);
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: { score: 10 } }) };
      }
      throw new Error(`unexpected ${input.url}`);
    });
    const result = await submitHomework(
      {
        todo_id: TODO_QUIZ,
        answers: [
          { question_id: "11", option_ids: ["102"] },
          { question_id: "21", text: "F=ma" },
        ],
      },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.isError, false);
    assert.equal(result.status, "submitted");
    assert.equal(result.submitted, true);
    assert.equal(result.preview, false);
    assert.ok(calls.some((c) => c.url.startsWith(SUBMIT_ANSWERS_RPC_URL)));
  });

  test("supports fill-in-the-blank (type 3) answers", async () => {
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      const term = termEmptyOk(input);
      if (term) return term;
      if (input.url.startsWith(QUIZ_PAPER_RPC_URL)) {
        return {
          statusCode: 200,
          body: paperBody({
            aid: 90001,
            tid: 301,
            tname: "填空测验",
            objectiveQList: [
              { id: 31, type: 3, title: "<p>田径起源于____</p>", optionDtos: [] },
            ],
            subjectiveQList: [],
          }),
        };
      }
      if (input.url.startsWith(SUBMIT_ANSWERS_RPC_URL)) {
        const body = input.json as {
          preview?: unknown;
          paperDto?: { answers?: Array<{ qid: number; type: number; fillAnswers?: string[]; time?: number }> };
        };
        assert.equal(body.preview, false);
        assert.equal(body.paperDto?.answers?.[0]?.qid, 31);
        assert.equal(body.paperDto?.answers?.[0]?.type, 3);
        assert.deepEqual(body.paperDto?.answers?.[0]?.fillAnswers, ["走跑跳投"]);
        assert.ok(typeof body.paperDto?.answers?.[0]?.time === "number");
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: { score: 10 } }) };
      }
      throw new Error(`unexpected ${input.url}`);
    });

    const result = await submitHomework(
      {
        todo_id: TODO_QUIZ,
        answers: [{ question_id: "31", text: "走跑跳投" }],
      },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.isError, false);
    assert.equal(result.status, "submitted");
    assert.equal(result.results[0].status, "saved");
  });

  test("save does not mark submitted even on success", async () => {
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      const term = termEmptyOk(input);
      if (term) return term;
      if (input.url.startsWith(QUIZ_PAPER_RPC_URL)) {
        return { statusCode: 200, body: paperBody() };
      }
      if (input.url.startsWith(SUBMIT_ANSWERS_RPC_URL)) {
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: {} }) };
      }
      throw new Error(`unexpected ${input.url}`);
    });
    const result = await saveHomeworkAnswers(
      {
        todo_id: TODO_QUIZ,
        answers: [{ question_id: "21", text: "draft only" }],
      },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.submitted, false);
    assert.equal(result.preview, true);
    assert.equal(JSON.stringify(result).includes('"submitted":true'), false);
  });
});

const TODO_UNIT = "1001:2001:unit:401";
const TODO_HOMEWORK = "1001:2001:homework:701";

/** mocTermDto where unit/quiz/homework catalog ids differ from paper tid (contentId). */
const PAPER_RESOLVE_MOC = {
  chapters: [
    {
      id: 11,
      quizs: [
        {
          id: 301,
          name: "第一章单元测验",
          contentType: 2,
          contentId: 9301,
          test: { id: 9301, deadline: Date.now() + 86400000, usedTryCount: 0 },
        },
      ],
      homeworks: [
        {
          id: 701,
          name: "第1周编程练习",
          contentType: 3,
          contentId: 9701,
          test: { id: 9701, deadline: Date.now() + 86400000, usedTryCount: 0 },
        },
      ],
      lessons: [
        {
          id: 21,
          units: [
            {
              id: 401,
              name: "旧版单元测验",
              contentType: 5,
              contentId: 9401,
              deadline: Date.now() + 86400000,
              testScore: 0,
              usedTryCount: 0,
            },
          ],
        },
      ],
    },
  ],
  exams: [
    {
      id: 502,
      name: "进行中的考试",
      contentId: 9502,
      test: { id: 9502 },
      deadline: Date.now() + 86400000,
      usedTryCount: 0,
    },
  ],
};

describe("resolvePaperTarget", () => {
  test("maps unit catalog id to contentId paper tid", () => {
    const target = resolvePaperTarget(
      { course_id: "1001", term_id: "2001", source: "unit", content_id: "401" },
      PAPER_RESOLVE_MOC,
    );
    assert.deepEqual(target, {
      ok: true,
      tid: "9401",
      paper_type: "quiz",
      catalog_id: "401",
      title: "旧版单元测验",
    });
  });

  test("maps chapter quiz id to contentId / test.id", () => {
    const target = resolvePaperTarget(
      { course_id: "1001", term_id: "2001", source: "quiz", content_id: "301" },
      PAPER_RESOLVE_MOC,
    );
    assert.equal(target.ok, true);
    if (target.ok) {
      assert.equal(target.tid, "9301");
      assert.equal(target.paper_type, "quiz");
    }
  });

  test("maps homework id to contentId and homework paper type", () => {
    const target = resolvePaperTarget(
      {
        course_id: "1001",
        term_id: "2001",
        source: "homework",
        content_id: "701",
      },
      PAPER_RESOLVE_MOC,
    );
    assert.deepEqual(target, {
      ok: true,
      tid: "9701",
      paper_type: "homework",
      catalog_id: "701",
      title: "第1周编程练习",
    });
  });

  test("returns not_found for unknown catalog id", () => {
    const target = resolvePaperTarget(
      { course_id: "1001", term_id: "2001", source: "unit", content_id: "999" },
      PAPER_RESOLVE_MOC,
    );
    assert.equal(target.ok, false);
    if (!target.ok) {
      assert.equal(target.status, "not_found");
    }
  });
});

describe("getHomework paper tid resolution", () => {
  test("unit todo fetches paper with contentId not unit id", async () => {
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(PAPER_RESOLVE_MOC) };
      }
      if (input.url.startsWith(QUIZ_PAPER_RPC_URL)) {
        assert.deepEqual(input.json, { tid: 9401 });
        return {
          statusCode: 200,
          body: paperBody({
            aid: 1,
            tid: 9401,
            tname: "旧版单元测验",
            objectiveQList: [
              {
                id: 11,
                type: 1,
                title: "<p>题干</p>",
                optionDtos: [
                  { id: 101, content: "A" },
                  { id: 102, content: "B" },
                ],
              },
            ],
            subjectiveQList: [],
          }),
        };
      }
      throw new Error(`unexpected ${input.url}`);
    });
    const result = await getHomework(
      { todo_id: TODO_UNIT, school_short_name: "SJTU" },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.question_count, 1);
    assert.equal(result.questions[0].stem_text, "题干");
    assert.equal(result.tid, "9401");
    const paperCalls = calls.filter((c) => c.url.startsWith(QUIZ_PAPER_RPC_URL));
    assert.equal(paperCalls.length, 1);
    assert.deepEqual(paperCalls[0].json, { tid: 9401 });
  });

  test("homework todo uses homework paper RPC with contentId", async () => {
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(PAPER_RESOLVE_MOC) };
      }
      if (input.url.startsWith(HOMEWORK_PAPER_RPC_URL)) {
        assert.deepEqual(input.json, {
          tid: 9701,
          withStdAnswerAndAnalyse: false,
        });
        return {
          statusCode: 200,
          body: paperBody({
            aid: 2,
            tid: 9701,
            tname: "第1周编程练习",
            objectiveQList: [],
            subjectiveQList: [{ id: 21, type: 7, title: "输出 Hello" }],
          }),
        };
      }
      throw new Error(`unexpected ${input.url}`);
    });
    const result = await getHomework(
      { todo_id: TODO_HOMEWORK },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.paper_type, "homework");
    assert.equal(result.questions[0].type, 7);
    assert.equal(result.questions[0].stem_text, "输出 Hello");
  });

  test("clear not_found when catalog entry missing", async () => {
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(PAPER_RESOLVE_MOC) };
      }
      throw new Error(`paper should not run: ${input.url}`);
    });
    const result = await getHomework(
      { todo_id: "1001:2001:unit:999" },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "not_found");
    assert.match(result.errors[0]?.message ?? "", /未在学期目录中找到|contentId|试卷/);
  });
});

describe("issue #32 unit-id fallback and preview reject", () => {
  test("rejects using unit catalog id as tid when mocTermDto unavailable", async () => {
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      if (input.url.startsWith(TERM_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: -1, message: "系统异常", result: null }),
        };
      }
      throw new Error(`paper must not run with catalog tid: ${input.url}`);
    });
    const result = await getHomework(
      { todo_id: TODO_UNIT },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "incomplete");
    assert.match(result.errors[0]?.message ?? "", /禁止用目录 id|contentId|mocTermDto/);
    assert.equal(
      calls.some((c) => c.url.startsWith(QUIZ_PAPER_RPC_URL)),
      false,
    );
  });

  test("empty paper result hints tid may not be contentId", async () => {
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(PAPER_RESOLVE_MOC) };
      }
      if (input.url.startsWith(QUIZ_PAPER_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: 0, result: null }),
        };
      }
      throw new Error(`unexpected ${input.url}`);
    });
    const result = await getHomework(
      { todo_id: TODO_UNIT },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "not_found");
    assert.match(result.errors[0]?.message ?? "", /result 为空/);
    assert.match(result.errors[0]?.message ?? "", /contentId|tid/);
  });

  test("maps preview-cannot-submit to clear draft-unsupported error", async () => {
    assert.equal(isPreviewSubmitRejectedMessage("预览不能提交！"), true);
    assert.match(previewRejectedUserMessage(), /本试卷不支持草稿预览保存/);
    assert.match(previewRejectedUserMessage(), /submit_homework/);

    let submitCalls = 0;
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed) return warmed;
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(PAPER_RESOLVE_MOC) };
      }
      if (input.url.startsWith(QUIZ_PAPER_RPC_URL)) {
        return {
          statusCode: 200,
          body: paperBody({
            aid: 1,
            tid: 9401,
            type: 6,
            tname: "type6 quiz",
            objectiveQList: [
              {
                id: 11,
                type: 1,
                title: "题",
                optionDtos: [
                  { id: 101, content: "A" },
                  { id: 102, content: "B" },
                ],
              },
            ],
            subjectiveQList: [],
          }),
        };
      }
      if (input.url.startsWith(SUBMIT_ANSWERS_RPC_URL)) {
        submitCalls += 1;
        const body = input.json as { preview?: unknown };
        assert.equal(body.preview, true);
        return {
          statusCode: 200,
          body: JSON.stringify({ code: -1, message: "预览不能提交！" }),
        };
      }
      throw new Error(`unexpected ${input.url}`);
    });
    const result = await saveHomeworkAnswers(
      {
        todo_id: TODO_UNIT,
        answers: [{ question_id: "11", option_ids: ["102"] }],
      },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "rejected");
    assert.equal(result.preview, true);
    assert.equal(result.submitted, false);
    assert.match(result.errors[0]?.message ?? "", /本试卷不支持草稿预览保存/);
    assert.match(result.errors[0]?.message ?? "", /submit_homework/);
    assert.equal(submitCalls, 1);
    // Must not have retried with preview:false
    const submitPayloads = calls
      .filter((c) => c.url.startsWith(SUBMIT_ANSWERS_RPC_URL))
      .map((c) => (c.json as { preview: boolean }).preview);
    assert.deepEqual(submitPayloads, [true]);
  });

  test("unit without contentId is unsupported, not unit-id tid", () => {
    const moc = {
      chapters: [
        {
          lessons: [
            {
              units: [
                {
                  id: 1321887787,
                  name: "Java unit quiz",
                  contentType: 5,
                  // no contentId / test.id
                },
              ],
            },
          ],
          quizs: [],
          homeworks: [],
        },
      ],
      exams: [],
    };
    const target = resolvePaperTarget(
      {
        course_id: "1206455818",
        term_id: "1487801457",
        source: "unit",
        content_id: "1321887787",
      },
      moc,
    );
    assert.equal(target.ok, false);
    if (!target.ok) {
      assert.equal(target.status, "unsupported");
      assert.match(target.errors[0]?.message ?? "", /缺少 contentId/);
    }
  });
});

// Measured bug: a unit-level 随堂测试 (contentType 5) is graded by submitAnswers, but its task
// point is a separate report. Without it the outline keeps showing the test as undone -- a fully
// answered quiz stayed at completePercent 0 / viewStatus 0 until one saveMocContentLearn with
// contentType 5 was sent (observed on unit 1322018145, which then flipped to 1 / viewStatus 5).
describe("unit quiz task point", () => {
  const UNIT_TODO = "1001:2001:unit:555";
  const CATALOG = {
    chapters: [
      {
        quizs: [{ id: 301, name: "章节测验", contentId: 301, test: { id: 301 } }],
        lessons: [
          {
            id: 777,
            name: "lesson",
            units: [
              { id: 555, name: "随堂测试", contentType: 5, contentId: 301, completePercent: 0 },
            ],
          },
        ],
      },
    ],
  };

  test("marks the task point after a unit quiz is submitted", async () => {
    const { calls, http } = recordingHttp((input) => {
      const warm = warmupOk(input);
      if (warm) {
        return warm;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG) };
      }
      if (input.url.startsWith(QUIZ_PAPER_RPC_URL)) {
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: SAMPLE_PAPER }) };
      }
      if (input.url.startsWith(SUBMIT_ANSWERS_RPC_URL)) {
        assert.equal((input.json as { preview: boolean }).preview, false);
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: { score: 10 } }) };
      }
      if (input.url.includes("saveMocContentLearn")) {
        return { statusCode: 200, body: JSON.stringify({ code: 0 }) };
      }
      throw new Error(`unexpected ${input.url}`);
    });

    const result = await submitHomework(
      { todo_id: UNIT_TODO, answers: [{ question_id: "11", option_ids: ["102"] }] },
      portsWith(async () => SESSION, http),
    );

    assert.equal(result.isError, false);
    assert.equal(result.submitted, true);
    assert.equal(result.task_point, "marked");

    const learn = calls.filter((c) => c.url.includes("saveMocContentLearn"));
    assert.equal(learn.length, 1);
    const dto = JSON.parse(String((learn[0] as { raw?: string }).raw ?? "{}")).dto as Record<
      string,
      unknown
    >;
    assert.equal(dto.contentType, 5);
    assert.equal(dto.unitId, 555);
    assert.equal(dto.lessonId, 777);
    assert.equal(dto.finished, true);
  });

  test("does not report a task point for a chapter quiz", async () => {
    const { calls, http } = recordingHttp((input) => {
      const warm = warmupOk(input);
      if (warm) {
        return warm;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG) };
      }
      if (input.url.startsWith(QUIZ_PAPER_RPC_URL)) {
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: SAMPLE_PAPER }) };
      }
      if (input.url.startsWith(SUBMIT_ANSWERS_RPC_URL)) {
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: { score: 10 } }) };
      }
      throw new Error(`unexpected ${input.url}`);
    });

    const result = await submitHomework(
      { todo_id: "1001:2001:quiz:301", answers: [{ question_id: "11", option_ids: ["102"] }] },
      portsWith(async () => SESSION, http),
    );

    assert.equal(result.submitted, true);
    assert.equal(result.task_point, "skipped");
    assert.equal(calls.filter((c) => c.url.includes("saveMocContentLearn")).length, 0);
  });
});
