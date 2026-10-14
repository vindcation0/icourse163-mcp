import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { COURSE_LIST_RPC_URL, WARMUP_URL } from "../src/auth";
import type { Icourse163Http, Icourse163HttpRequest, Icourse163Ports } from "../src/ports";
import { sessionStatus } from "../src/session-status";
import { EMPTY_COURSE_PANEL_BODY, coursePanelBody, MOOC_COURSE } from "./fixtures";

const FULL_SESSION =
  "NTESSTUDYSI=test-session; STUDY_INFO=info; STUDY_SESS=sess";
const API_ONLY_SESSION = "NTESSTUDYSI=test-session";

function portsWith(
  getCookie: () => Promise<string | null>,
  http: Icourse163Http,
): Icourse163Ports {
  return { credentials: { getCookie }, http };
}

function recordingHttp(
  handler: (input: Icourse163HttpRequest) => { statusCode: number; body: string; cookie?: string },
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

/** Warm-up returns 200 with STUDY_INFO so resolveSession passes on its first branch. */
function happyHttp(panelBody: string) {
  return recordingHttp((input) => {
    if ((input.method ?? "GET") === "GET" && input.url === WARMUP_URL) {
      return { statusCode: 200, body: "<html>ok</html>", cookie: `${input.cookie}; STUDY_INFO=ok` };
    }
    if (input.url.startsWith(COURSE_LIST_RPC_URL)) {
      return { statusCode: 200, body: panelBody };
    }
    throw new Error(`unexpected url ${input.url}`);
  });
}

describe("sessionStatus", () => {
  test("no ports is auth_expired and tells the user to log in", async () => {
    const result = await sessionStatus(undefined);
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_expired");
    assert.equal(result.stored, false);
    assert.match(result.guidance, /npm run login/);
  });

  test("no stored cookie is auth_expired", async () => {
    const { http } = happyHttp(coursePanelBody([MOOC_COURSE]));
    const result = await sessionStatus(portsWith(async () => null, http));
    assert.equal(result.status, "auth_expired");
    assert.equal(result.stored, false);
    assert.equal(result.cookies.ntesstudysi, false);
    assert.match(result.guidance, /npm run login/);
  });

  test("a full session reports both transports ready", async () => {
    const { http } = happyHttp(coursePanelBody([MOOC_COURSE]));
    const result = await sessionStatus(portsWith(async () => FULL_SESSION, http));
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.stored, true);
    assert.deepEqual(result.cookies, {
      ntesstudysi: true,
      study_info: true,
      study_sess: true,
      total: 3,
    });
    assert.equal(result.browser_path_ready, true);
    assert.equal(result.course_count, 1);
    assert.match(result.guidance, /transport=rpc/);
    assert.match(result.guidance, /web session is present/);
  });

  // This is the state that cost hours: reads work, so list_courses succeeds, while the
  // browser path is bounced off /learn/ and study_unit fails with a misleading error.
  test("an API-only session is usable but flags the browser path as unavailable", async () => {
    const { http } = happyHttp(coursePanelBody([MOOC_COURSE]));
    const result = await sessionStatus(portsWith(async () => API_ONLY_SESSION, http));
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.api, "ok");
    assert.equal(result.cookies.ntesstudysi, true);
    assert.equal(result.cookies.study_sess, false);
    assert.equal(result.browser_path_ready, false);
    assert.match(result.guidance, /transport=rpc works/);
    assert.match(result.guidance, /bounced off \/learn\//);
  });

  test("an empty course panel is ok with zero courses, not an error", async () => {
    const { http } = happyHttp(EMPTY_COURSE_PANEL_BODY);
    const result = await sessionStatus(portsWith(async () => FULL_SESSION, http));
    assert.equal(result.isError, false);
    assert.equal(result.course_count, 0);
  });

  test("an expired session reports auth_expired and keeps the cookie markers", async () => {
    const { http } = recordingHttp((input) => {
      if ((input.method ?? "GET") === "GET" && input.url === WARMUP_URL) {
        return { statusCode: 200, body: "<html>login</html>" };
      }
      return { statusCode: 200, body: JSON.stringify({ code: 11, result: null }) };
    });
    const result = await sessionStatus(portsWith(async () => FULL_SESSION, http));
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_expired");
    assert.equal(result.stored, true);
    assert.equal(result.cookies.study_info, true);
    assert.match(result.guidance, /npm run login/);
  });

  test("a credential read failure is surfaced, not swallowed", async () => {
    const { http } = happyHttp(coursePanelBody([MOOC_COURSE]));
    const result = await sessionStatus(
      portsWith(async () => {
        throw new Error("keychain unavailable");
      }, http),
    );
    assert.equal(result.isError, true);
    assert.match(result.guidance, /keychain unavailable/);
  });

  test("never requests an HTML page (that could log the session out)", async () => {
    const { calls, http } = happyHttp(coursePanelBody([MOOC_COURSE]));
    await sessionStatus(portsWith(async () => FULL_SESSION, http));
    assert.equal(
      calls.some((call) => call.url.includes("/learn/") || call.url.includes("/passport/")),
      false,
    );
  });
});
