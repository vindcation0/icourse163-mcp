import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TERM_RPC_URL, WARMUP_URL } from "../src/auth";
import { learnReferer } from "../src/course-rpc";
import {
  LEARN_VO_RPC_URL,
  SAVE_LEARN_RPC_URL,
  buildDocLearnDto,
  buildVideoLearnDto,
  clampPageIntervalSec,
  findUnitInMocTerm,
  isLearnProgressBlockedMessage,
  studyUnit,
} from "../src/study-unit";
import type {
  Icourse163Http,
  Icourse163HttpRequest,
  Icourse163Ports,
} from "../src/ports";
import { CATALOG_MOC_TERM_DTO, mocTermBody } from "./fixtures";

const SESSION = "NTESSTUDYSI=test-session";

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

describe("buildVideoLearnDto", () => {
  test("builds finished video dto for saveMocContentLearn", () => {
    const dto = buildVideoLearnDto({
      unit_id: "401",
      content_id: "9001",
      duration_sec: 120,
    });
    assert.equal(dto.unitId, 401);
    assert.equal(dto.contentType, 1);
    assert.equal(dto.finished, true);
    assert.equal(dto.videoDto.videoId, 9001);
    assert.equal(dto.videoDto.duration, 120);
    assert.equal(dto.videoDto.currentTime, 120);
    assert.equal(dto.videoDto.learnedTime, 120);
  });
});


describe("buildDocLearnDto", () => {
  test("builds finished doc dto for saveMocContentLearn", () => {
    const dto = buildDocLearnDto({
      unit_id: "402",
      content_type: 3,
      page_count: 9,
    });
    assert.equal(dto.unitId, 402);
    assert.equal(dto.contentType, 3);
    assert.equal(dto.finished, true);
    assert.equal(dto.pageNum, 9);
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
    assert.ok(saveCall != null);
    assert.equal(saveCall.method, "POST");
    assert.ok(saveCall.form?.dto != null);
    const dto = JSON.parse(saveCall.form.dto) as {
      unitId: number;
      contentType: number;
      finished: boolean;
      pageNum: number;
    };
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
    assert.ok(saveCall != null);
    const dto = JSON.parse(saveCall.form!.dto!) as { contentType: number; pageNum: number };
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
    assert.ok(saveCall != null);
    assert.equal(saveCall.method, "POST");
    assert.ok(saveCall.form?.dto != null);
    const dto = JSON.parse(saveCall.form.dto) as {
      unitId: number;
      finished: boolean;
      videoDto: { duration: number };
    };
    assert.equal(dto.unitId, 401);
    assert.equal(dto.finished, true);
    assert.equal(dto.videoDto.duration, 120);
    assert.equal(
      saveCall.headers?.referer,
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
    assert.ok(saveCall != null);
    const dto = JSON.parse(saveCall.form!.dto!) as {
      videoDto: { videoId: number; duration: number };
    };
    assert.equal(dto.videoDto.videoId, 1231832139);
    assert.equal(dto.videoDto.duration, 8369);
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
    assert.match(result.errors[0]?.message ?? "", /docs\/mcp\.md/);
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
