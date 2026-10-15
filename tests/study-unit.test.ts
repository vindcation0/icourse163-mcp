import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TERM_RPC_URL, WARMUP_URL } from "../src/auth";
import { learnReferer } from "../src/course-rpc";
import {
  LEARN_VO_RPC_URL,
  MAX_REPORT_CHUNK_SEC,
  SAVE_LEARN_RPC_URL,
  buildDocLearnReport,
  buildVideoLearnReport,
  clampPageIntervalSec,
  clampReportChunkSec,
  findUnitInMocTerm,
  isLearnProgressBlockedMessage,
  planVideoChunks,
  studyUnit,
} from "../src/study-unit";
import type {
  Icourse163Http,
  Icourse163HttpRequest,
  Icourse163Ports,
} from "../src/ports";
import { CATALOG_MOC_TERM_DTO, mocTermBody } from "./fixtures";
import { icourse163RpcSignature } from "../src/rpc-sign";

const SESSION = "NTESSTUDYSI=test-session";

/**
 * Asserts the saveMocContentLearn call is a signed JSON request and returns its dto.
 * The signature must verify against the exact bytes sent, so recompute it here: a
 * body that does not match the signature is rejected by the server with a bogus
 * "并发限制" message, which is exactly the failure this replaced.
 */
function parseSignedSave(call: Icourse163HttpRequest | undefined): Record<string, unknown> {
  assert.ok(call != null, "expected a saveMocContentLearn call");
  assert.equal(call.method, "POST");
  assert.equal(call.form, undefined, "the signed save must not be form-encoded");
  assert.ok(call.raw != null, "the signed save must send a raw body");
  assert.equal(call.headers?.["content-type"], "application/json;charset=UTF-8");
  assert.equal(call.headers?.["system"], "v1");
  assert.equal(call.headers?.["edu-script-token"], "test-session");
  const nonce = Number(call.headers?.nonce);
  const timestamp = Number(call.headers?.timestamp);
  assert.ok(Number.isFinite(nonce) && Number.isFinite(timestamp));
  assert.equal(call.headers?.["auth-signature"], icourse163RpcSignature(call.raw, nonce, timestamp));
  return (JSON.parse(call.raw) as { dto: Record<string, unknown> }).dto;
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

const baseChapter = CATALOG_MOC_TERM_DTO.chapters[0];
const baseLesson = baseChapter.lessons[0];

const CATALOG_WITH_VIDEO_META = {
  chapters: [
    {
      ...baseChapter,
      lessons: [
        {
          ...baseLesson,
          units: [
            {
              id: 401,
              name: "导论视频",
              contentType: 1,
              contentId: 9001,
              duration: 120,
              hasLearned: false,
            },
            ...baseLesson.units.slice(1),
          ],
        },
      ],
    },
  ],
  exams: [],
};

const CATALOG_WITH_DURATION_IN_SECONDS = {
  chapters: [
    {
      ...baseChapter,
      lessons: [
        {
          ...baseLesson,
          units: [
            {
              id: 1303386815,
              name: "2小时揭秘大学信息差",
              contentType: 1,
              contentId: 1231832139,
              durationInSeconds: 8369,
              hasLearned: false,
            },
            ...baseLesson.units.slice(1),
          ],
        },
      ],
    },
  ],
  exams: [],
};

describe("findUnitInMocTerm", () => {
  test("finds video unit with content meta", () => {
    const found = findUnitInMocTerm(CATALOG_WITH_VIDEO_META, "401");
    assert.ok(found != null);
    assert.equal(found.unit_id, "401");
    assert.equal(found.name, "导论视频");
    assert.equal(found.content_type, 1);
    assert.equal(found.unit_type, "video");
    assert.equal(found.content_id, "9001");
    assert.equal(found.duration_sec, 120);
    assert.equal(found.lesson_id, "21");
  });

  test("returns null when unit missing", () => {
    assert.equal(findUnitInMocTerm(CATALOG_MOC_TERM_DTO, "999"), null);
  });

  test("reads catalog durationInSeconds as seconds (not ms)", () => {
    const found = findUnitInMocTerm(CATALOG_WITH_DURATION_IN_SECONDS, "1303386815");
    assert.ok(found != null);
    assert.equal(found.content_id, "1231832139");
    assert.equal(found.duration_sec, 8369);
    assert.equal(found.unit_type, "video");
  });
});

// Shape captured from the platform's own client. The old nested videoDto form was
// rejected with -10006/-2 because it was not the real contract (nor signed).
describe("buildVideoLearnReport", () => {
  test("builds the flat LEARN_TIME_COUNT report", () => {
    const dto = buildVideoLearnReport({
      course_id: "1450750234",
      term_id: "1475848441",
      lesson_id: "1265444035",
      unit_id: "1305575052",
      video_id: "1216009818",
      duration_sec: 1125,
    });
    assert.equal(dto.unitId, 1305575052);
    assert.equal(dto.contentType, 1);
    assert.equal(dto.finished, true);
    assert.equal(dto.action, "LEARN_TIME_COUNT");
    assert.equal(dto.courseId, 1450750234);
    assert.equal(dto.lessonId, 1265444035);
    assert.equal(dto.videoId, 1216009818);
    assert.equal(dto.termId, 1475848441);
    assert.equal(dto.index, 1);
    assert.equal(dto.videoTime, 1125);
    assert.equal(dto.learnedVideoTimeCount, 1125);
    assert.equal(dto.duration, 1125000);
    // the rejected shape had this; the real one must not
    assert.equal("videoDto" in dto, false);
  });

  test("learned_sec is clamped to the video length", () => {
    const dto = buildVideoLearnReport({
      course_id: "1",
      term_id: "2",
      lesson_id: "3",
      unit_id: "4",
      video_id: "5",
      duration_sec: 100,
      learned_sec: 500,
    });
    assert.equal(dto.learnedVideoTimeCount, 100);
    assert.equal(dto.duration, 100000);
  });

  test("honours a partial learned_sec", () => {
    const dto = buildVideoLearnReport({
      course_id: "1",
      term_id: "2",
      lesson_id: "3",
      unit_id: "4",
      video_id: "5",
      duration_sec: 100,
      learned_sec: 60,
    });
    assert.equal(dto.learnedVideoTimeCount, 60);
    assert.equal(dto.duration, 60000);
  });

  // videoTime is the POSITION, not the total duration. Measured on a 559s unit: advancing
  // it 60/120/180/240 got all four reports credited (+60s each, 2.5s apart), while sending
  // an unchanging value got code 0 and credited nothing. Getting this wrong is what made
  // incremental reporting look impossible.
  test("video_time_sec overrides the position so a chunk can advance", () => {
    const base = {
      course_id: "1",
      term_id: "2",
      lesson_id: "3",
      unit_id: "4",
      video_id: "5",
      duration_sec: 559,
      learned_sec: 60,
    };
    const first = buildVideoLearnReport({ ...base, video_time_sec: 60, finished: false });
    assert.equal(first.videoTime, 60);
    assert.equal(first.learnedVideoTimeCount, 60);
    assert.equal(first.finished, false);
    const second = buildVideoLearnReport({ ...base, video_time_sec: 120, finished: false });
    assert.equal(second.videoTime, 120);
    // The two reports must differ, otherwise the platform reads it as "no advance".
    assert.notEqual(first.videoTime, second.videoTime);
    // Omitted stays at the full duration, which is what the one-shot report needs.
    assert.equal(buildVideoLearnReport(base).videoTime, 559);
    assert.equal(buildVideoLearnReport(base).finished, true);
  });

  test("video_time_sec is clamped into the video", () => {
    const dto = buildVideoLearnReport({
      course_id: "1",
      term_id: "2",
      lesson_id: "3",
      unit_id: "4",
      video_id: "5",
      duration_sec: 100,
      learned_sec: 60,
      video_time_sec: 9999,
    });
    assert.equal(dto.videoTime, 100);
  });
});

describe("planVideoChunks", () => {
  test("chunk 0 is the single one-shot report", () => {
    assert.deepEqual(planVideoChunks(600, 0), [
      { learned_sec: 600, position_sec: 600, finished: true },
    ]);
  });

  test("splits a video and only the last report is finished", () => {
    const chunks = planVideoChunks(150, 60);
    assert.deepEqual(chunks, [
      { learned_sec: 60, position_sec: 60, finished: false },
      { learned_sec: 60, position_sec: 120, finished: false },
      { learned_sec: 30, position_sec: 150, finished: true },
    ]);
  });

  test("learned_sec sums to the duration and the position always advances", () => {
    const chunks = planVideoChunks(559, 60);
    const total = chunks.reduce((sum, c) => sum + c.learned_sec, 0);
    assert.equal(total, 559);
    assert.equal(chunks.at(-1)?.position_sec, 559);
    assert.equal(chunks.at(-1)?.finished, true);
    // Strictly increasing: a repeated videoTime is credited 0 by the platform.
    for (let i = 1; i < chunks.length; i += 1) {
      assert.ok(chunks[i].position_sec > chunks[i - 1].position_sec);
    }
    assert.equal(chunks.filter((c) => c.finished).length, 1);
  });

  test("a chunk longer than the video degrades to one report", () => {
    assert.deepEqual(planVideoChunks(30, 60), [
      { learned_sec: 30, position_sec: 30, finished: true },
    ]);
  });

  test("a zero-length video yields nothing", () => {
    assert.deepEqual(planVideoChunks(0, 60), []);
  });
});

describe("clampReportChunkSec", () => {
  test("treats 0 and nonsense as off, and lifts tiny chunks to the floor", () => {
    assert.equal(clampReportChunkSec(undefined), 0);
    assert.equal(clampReportChunkSec(0), 0);
    assert.equal(clampReportChunkSec(-5), 0);
    assert.equal(clampReportChunkSec(Number.NaN), 0);
    assert.equal(clampReportChunkSec(1), 5);
    assert.equal(clampReportChunkSec(60), 60);
    assert.equal(clampReportChunkSec(99_999), MAX_REPORT_CHUNK_SEC);
  });
});


// Shape captured from the platform's own client while it turned PDF pages.
describe("buildDocLearnReport", () => {
  test("builds the captured doc report", () => {
    const dto = buildDocLearnReport({
      course_id: "1450750234",
      term_id: "1475848441",
      lesson_id: "1265444035",
      unit_id: "1305575053",
      content_type: 3,
      page_count: 18,
      learned_sec: 2,
      now: 1791966259056,
    });
    assert.equal(dto.unitId, 1305575053);
    assert.equal(dto.contentType, 3);
    assert.equal(dto.finished, true);
    assert.equal(dto.index, 0);
    assert.equal(dto.pageNum, 18);
    assert.equal(dto.courseId, 1450750234);
    assert.equal(dto.lessonId, 1265444035);
    assert.equal(dto.termId, 1475848441);
    assert.equal(dto.lastLearnTime, 1791966259056);
    assert.equal(dto.learnedVideoTimeCount, 2);
  });

  // pageNum is not validated by the server: 18 / 1 / 9999 / omitted all return
  // code 0, and an incomplete doc reaches completePercent 1 without it. So an
  // unknown page count must not block the report.
  test("omits pageNum when the page count is unknown", () => {
    const dto = buildDocLearnReport({
      course_id: "1",
      term_id: "2",
      lesson_id: "3",
      unit_id: "4",
      content_type: 3,
      page_count: null,
    });
    assert.equal("pageNum" in dto, false);
    assert.equal(dto.learnedVideoTimeCount, 2);
  });
});

describe("clampPageIntervalSec", () => {
  test("defaults to 1 and clamps to 0–10", () => {
    assert.equal(clampPageIntervalSec(undefined), 1);
    assert.equal(clampPageIntervalSec(0), 0);
    assert.equal(clampPageIntervalSec(3), 3);
    assert.equal(clampPageIntervalSec(-1), 0);
    assert.equal(clampPageIntervalSec(99), 10);
  });
});

describe("studyUnit", () => {
  test("null credentials is auth_expired", async () => {
    const { calls, http } = recordingHttp(() => {
      throw new Error("http should not run");
    });
    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "401",
        school_short_name: "SJTU",
      },
      portsWith(async () => null, http),
    );
    assert.equal(result.status, "auth_expired");
    assert.equal(result.isError, true);
    assert.equal(result.completed, false);
    assert.deepEqual(calls, []);
  });

  test("missing args is error", async () => {
    const result = await studyUnit({
      course_id: " ",
      term_id: "2001",
      unit_id: "401",
    });
    assert.equal(result.status, "error");
    assert.equal(result.isError, true);
  });

  test("quiz/other unit is non_media_unit", async () => {
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      throw new Error(`unexpected url ${input.url}`);
    });
    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "404",
        school_short_name: "SJTU",
      },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.status, "non_media_unit");
    assert.equal(result.isError, true);
    assert.equal(result.unit_type, "quiz");
    assert.equal(result.completed, false);
  });

  test("doc PDF unit posts saveMocContentLearn and returns progress", async () => {
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        assert.equal(input.form?.contentType, "3");
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 0,
            result: { textPages: 9, textOrigUrl: "https://example.invalid/doc.pdf" },
          }),
        };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: {} }) };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "402",
        school_short_name: "SJTU",
        page_interval_sec: 0,
      },
      portsWith(async () => SESSION, http),
    );

    assert.equal(result.status, "ok");
    assert.equal(result.isError, false);
    assert.equal(result.completed, true);
    assert.equal(result.unit_id, "402");
    assert.equal(result.unit_type, "doc");
    assert.equal(result.page_count, 9);
    assert.equal(result.page_interval_sec, 0);
    assert.equal(result.percent, 100);
    assert.equal(result.transport, "rpc");
    assert.equal(result.learned_sec, null);
    assert.equal(result.duration_sec, null);
    assert.equal(JSON.stringify(result).includes("test-session"), false);

    const saveCall = calls.find((call) => call.url.startsWith(SAVE_LEARN_RPC_URL));
    const dto = parseSignedSave(saveCall);
    assert.equal(dto.unitId, 402);
    assert.equal(dto.contentType, 3);
    assert.equal(dto.finished, true);
    assert.equal(dto.pageNum, 9);
  });

  test("rich-text doc unit completes with pageNum 1", async () => {
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        assert.equal(input.form?.contentType, "4");
        return {
          statusCode: 200,
          body: JSON.stringify({ code: 0, result: { textPages: 0 } }),
        };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: {} }) };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "403",
        school_short_name: "SJTU",
        page_interval_sec: 0,
      },
      portsWith(async () => SESSION, http),
    );

    assert.equal(result.status, "ok");
    assert.equal(result.unit_type, "doc");
    assert.equal(result.completed, true);
    assert.equal(result.page_count, 1);
    const saveCall = calls.find((call) => call.url.startsWith(SAVE_LEARN_RPC_URL));
    const dto = parseSignedSave(saveCall);
    assert.equal(dto.contentType, 4);
    assert.equal(dto.pageNum, 1);
  });

  test("unknown unit is page_structure_change", async () => {
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      throw new Error(`unexpected url ${input.url}`);
    });
    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "40404",
        school_short_name: "SJTU",
      },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.status, "page_structure_change");
    assert.equal(result.isError, true);
  });

  test("posts saveMocContentLearn dto and returns progress", async () => {
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 0,
            result: { duration: 120, videoId: 9001, learnedTime: 0 },
          }),
        };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: {} }) };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "401",
        school_short_name: "SJTU",
        playback_rate: 2,
      },
      portsWith(async () => SESSION, http),
    );

    assert.equal(result.status, "ok");
    assert.equal(result.isError, false);
    assert.equal(result.completed, true);
    assert.equal(result.unit_id, "401");
    assert.equal(result.unit_type, "video");
    assert.equal(result.playback_rate, 2);
    assert.equal(result.learned_sec, 120);
    assert.equal(result.duration_sec, 120);
    assert.equal(result.percent, 100);
    assert.equal(result.transport, "rpc");
    assert.equal(JSON.stringify(result).includes("test-session"), false);

    const saveCall = calls.find((call) => call.url.startsWith(SAVE_LEARN_RPC_URL));
    const dto = parseSignedSave(saveCall);
    assert.equal(dto.unitId, 401);
    assert.equal(dto.finished, true);
    assert.equal(dto.action, "LEARN_TIME_COUNT");
    assert.equal(dto.videoTime, 120);
    assert.equal(dto.learnedVideoTimeCount, 120);
    assert.equal("videoDto" in dto, false);
    assert.equal(
      saveCall?.headers?.referer,
      learnReferer({
        course_id: "1001",
        term_id: "2001",
        school_short_name: "SJTU",
      }),
    );
  });

  test("learnVo failure still saves when catalog has contentId+durationInSeconds", async () => {
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return {
          statusCode: 200,
          body: mocTermBody(CATALOG_WITH_DURATION_IN_SECONDS),
        };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: -1, message: "系统异常" }),
        };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: {} }) };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      {
        course_id: "1473617163",
        term_id: "1475287452",
        unit_id: "1303386815",
        school_short_name: "kaopei",
      },
      portsWith(async () => SESSION, http),
    );

    assert.equal(result.status, "ok");
    assert.equal(result.isError, false);
    assert.equal(result.completed, true);
    assert.equal(result.duration_sec, 8369);
    assert.equal(result.learned_sec, 8369);
    assert.equal(result.transport, "rpc");

    const saveCall = calls.find((call) => call.url.startsWith(SAVE_LEARN_RPC_URL));
    const dto = parseSignedSave(saveCall);
    assert.equal(dto.videoId, 1231832139);
    assert.equal(dto.videoTime, 8369);
    assert.equal(dto.learnedVideoTimeCount, 8369);
  });

  test("malformed save response is page_structure_change", async () => {
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: 0, result: { duration: 60 } }),
        };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        return { statusCode: 200, body: "not-json<<<" };
      }
      throw new Error(`unexpected url ${input.url}`);
    });
    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "401",
        school_short_name: "SJTU",
      },
      portsWith(async () => SESSION, http),
    );
    assert.equal(result.status, "page_structure_change");
    assert.equal(result.isError, true);
  });

  test("saveMocContentLearn -10006 is error with documented hint", async () => {
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return {
          statusCode: 200,
          body: mocTermBody(CATALOG_WITH_DURATION_IN_SECONDS),
        };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: -1, message: "系统异常" }),
        };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: -2,
            message: "请检查本地时间是否和北京时间一致-10006",
          }),
        };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      {
        course_id: "1473617163",
        term_id: "1475287452",
        unit_id: "1303386815",
        school_short_name: "kaopei",
        transport: "rpc",
      },
      portsWith(async () => SESSION, http),
    );

    assert.equal(result.status, "error");
    assert.equal(result.isError, true);
    assert.equal(result.completed, false);
    assert.equal(result.transport, null);
    assert.match(result.errors[0]?.message ?? "", /10006/);
    // The hint used to blame anti-abuse and the machine clock. It is a signature
    // rejection: a correctly signed request to the same endpoint returns code 0.
    assert.match(result.errors[0]?.message ?? "", /signature rejected/);
    assert.match(result.errors[0]?.message ?? "", /0004-rpc-request-signing/);
  });

});

describe("saveMocContentLearn throttling", () => {
  // A 7-unit batch was observed hitting 并发限制 on 4 of them when fired back to back.
  // The save must retry those (rebuilding the signature, which covers timestamp/nonce)
  // instead of surfacing a throttle as a hard failure.
  test("retries 并发限制 and succeeds on a later attempt", async () => {
    let saveAttempts = 0;
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: { duration: 120, videoId: 9001 } }) };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        saveAttempts += 1;
        if (saveAttempts === 1) {
          return { statusCode: 200, body: JSON.stringify({ code: -2, message: "并发限制，请稍后再试" }) };
        }
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: true }) };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      { course_id: "1001", term_id: "2001", unit_id: "401", school_short_name: "SJTU", transport: "rpc" },
      portsWith(async () => SESSION, http),
    );

    assert.equal(saveAttempts, 2);
    assert.equal(result.status, "ok");
    assert.equal(result.completed, true);
    assert.equal(result.transport, "rpc");
  });

  test("does not retry a non-throttle failure", async () => {
    let saveAttempts = 0;
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return { statusCode: 200, body: JSON.stringify({ code: 0, result: { duration: 120, videoId: 9001 } }) };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        saveAttempts += 1;
        return { statusCode: 200, body: JSON.stringify({ code: -2, message: "别的错误" }) };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      { course_id: "1001", term_id: "2001", unit_id: "401", school_short_name: "SJTU", transport: "rpc" },
      portsWith(async () => SESSION, http),
    );

    assert.equal(saveAttempts, 1);
    assert.equal(result.isError, true);
  });
});

describe("isLearnProgressBlockedMessage", () => {
  test("detects -10006 / clock / concurrency blockers", () => {
    assert.equal(
      isLearnProgressBlockedMessage(
        "saveMocContentLearn code=-2 请检查本地时间是否和北京时间一致-10006",
      ),
      true,
    );
    assert.equal(isLearnProgressBlockedMessage("并发限制"), true);
    assert.equal(isLearnProgressBlockedMessage("普通错误"), false);
  });
});

describe("studyUnit Playwright fallback", () => {
  test("falls back to playwright when save returns -10006 (transport=auto)", async () => {
    let playwrightCalls = 0;
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 0,
            result: { duration: 120, videoId: 9001 },
          }),
        };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: -2,
            message: "请检查本地时间是否和北京时间一致-10006",
          }),
        };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "401",
        school_short_name: "SJTU",
        transport: "auto",
      },
      {
        ...portsWith(async () => SESSION, http),
        studyPlaywright: {
          async studyUnitInBrowser(args) {
            playwrightCalls += 1;
            assert.equal(args.unit_id, "401");
            assert.equal(args.unit_type, "video");
            assert.ok(args.cookie.includes("NTESSTUDYSI"));
            return {
              kind: "completed",
              nav_strategy: "tree_click",
              learned_sec: 120,
              duration_sec: 120,
              page_count: null,
              percent: 100,
            };
          },
        },
      },
    );

    assert.equal(result.status, "ok");
    assert.equal(result.isError, false);
    assert.equal(result.transport, "playwright");
    assert.ok(result.course_kind === "school" || result.course_kind === "non_school");
    assert.equal(result.nav_strategy, "tree_click");
    assert.equal(result.completed, true);
    assert.equal(playwrightCalls, 1);
    assert.ok(calls.some((call) => call.url.startsWith(SAVE_LEARN_RPC_URL)));
    assert.equal(JSON.stringify(result).includes("test-session"), false);
  });

  test("transport=rpc does not fall back on -10006", async () => {
    let playwrightCalls = 0;
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 0,
            result: { duration: 120, videoId: 9001 },
          }),
        };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: -2,
            message: "请检查本地时间是否和北京时间一致-10006",
          }),
        };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "401",
        school_short_name: "SJTU",
        transport: "rpc",
      },
      {
        ...portsWith(async () => SESSION, http),
        studyPlaywright: {
          async studyUnitInBrowser() {
            playwrightCalls += 1;
            return {
              kind: "completed",
              learned_sec: 1,
              duration_sec: 1,
              page_count: null,
              percent: 100,
            };
          },
        },
      },
    );

    assert.equal(result.status, "error");
    assert.equal(result.isError, true);
    assert.equal(result.transport, null);
    assert.equal(playwrightCalls, 0);
    assert.match(result.errors[0]?.message ?? "", /10006/);
  });

  test("transport=playwright skips save RPC", async () => {
    let playwrightCalls = 0;
    const { calls, http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 0,
            result: { duration: 120, videoId: 9001 },
          }),
        };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        throw new Error("save RPC must not run for transport=playwright");
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "401",
        school_short_name: "SJTU",
        transport: "playwright",
        playback_rate: 1.5,
      },
      {
        ...portsWith(async () => SESSION, http),
        studyPlaywright: {
          async studyUnitInBrowser(args) {
            playwrightCalls += 1;
            assert.equal(args.playback_rate, 1.5);
            return {
              kind: "completed",
              learned_sec: 120,
              duration_sec: 120,
              page_count: null,
              percent: 100,
            };
          },
        },
      },
    );

    assert.equal(result.status, "ok");
    assert.equal(result.transport, "playwright");
    assert.equal(playwrightCalls, 1);
    assert.equal(
      calls.some((call) => call.url.startsWith(SAVE_LEARN_RPC_URL)),
      false,
    );
  });

  // seek_near_end means "jump to the end of the media"; skip_to_end is its
  // positive form. Inverting the mapping silently keeps the fast path and the
  // platform never credits the unit, so pin the direction down.
  test("skip_to_end maps to seek_near_end without inversion", async () => {
    const seen: boolean[] = [];
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: 0, result: { duration: 120, videoId: 9001 } }),
        };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    for (const skipToEnd of [undefined, false] as const) {
      await studyUnit(
        {
          course_id: "1001",
          term_id: "2001",
          unit_id: "401",
          school_short_name: "SJTU",
          transport: "playwright",
          ...(skipToEnd === undefined ? {} : { skip_to_end: skipToEnd }),
        },
        {
          ...portsWith(async () => SESSION, http),
          studyPlaywright: {
            async studyUnitInBrowser(args) {
              seen.push(args.seek_near_end !== false);
              return {
                kind: "completed",
                learned_sec: 120,
                duration_sec: 120,
                page_count: null,
                percent: 100,
              };
            },
          },
        },
      );
    }

    assert.deepEqual(seen, [true, false]);
  });

  test("playwright video quiz popup returns needs_quiz_assist without submit", async () => {
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 0,
            result: { duration: 60, videoId: 9001 },
          }),
        };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "401",
        school_short_name: "SJTU",
        transport: "playwright",
      },
      {
        ...portsWith(async () => SESSION, http),
        studyPlaywright: {
          async studyUnitInBrowser() {
            return {
              kind: "needs_quiz_assist",
              message:
                "Video popup quiz detected (.u-questionItem). Do not silent-submit; use get_homework → AI → save_homework_answers, then retry study_unit.",
              learned_sec: 12,
              duration_sec: 60,
            };
          },
        },
      },
    );

    assert.equal(result.status, "needs_quiz_assist");
    assert.equal(result.isError, true);
    assert.equal(result.completed, false);
    assert.equal(result.transport, "playwright");
    assert.equal(result.learned_sec, 12);
    assert.match(result.errors.map((e) => e.message).join(" "), /get_homework|save_homework/);
  });

  test("doc unit falls back to playwright on 并发限制", async () => {
    let playwrightCalls = 0;
    const { http } = recordingHttp((input) => {
      const warmed = warmupOk(input);
      if (warmed != null) {
        return warmed;
      }
      if (input.url.startsWith(TERM_RPC_URL)) {
        return { statusCode: 200, body: mocTermBody(CATALOG_WITH_VIDEO_META) };
      }
      if (input.url.startsWith(LEARN_VO_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 0,
            result: { textPages: 3 },
          }),
        };
      }
      if (input.url.startsWith(SAVE_LEARN_RPC_URL)) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: -2, message: "并发限制" }),
        };
      }
      throw new Error(`unexpected url ${input.url}`);
    });

    const result = await studyUnit(
      {
        course_id: "1001",
        term_id: "2001",
        unit_id: "402",
        school_short_name: "SJTU",
        page_interval_sec: 0,
        transport: "auto",
      },
      {
        ...portsWith(async () => SESSION, http),
        studyPlaywright: {
          async studyUnitInBrowser(args) {
            playwrightCalls += 1;
            assert.equal(args.unit_type, "doc");
            assert.equal(args.page_interval_sec, 0);
            return {
              kind: "completed",
              learned_sec: null,
              duration_sec: null,
              page_count: 3,
              percent: 100,
            };
          },
        },
      },
    );

    assert.equal(result.status, "ok");
    assert.equal(result.transport, "playwright");
    assert.equal(result.unit_type, "doc");
    assert.equal(result.page_count, 3);
    assert.equal(playwrightCalls, 1);
  });
});
