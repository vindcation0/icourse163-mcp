import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  COURSE_LIST_RPC_URL,
  WARMUP_URL,
  probeSession,
  rpcCodeIsZero,
} from "../src/auth";

const SESSION = "NTESSTUDYSI=test-session";

type FetchCall = { url: string; init?: RequestInit };

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): {
  calls: FetchCall[];
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  };
  return { calls, fetchImpl };
}

describe("rpcCodeIsZero", () => {
  test("accepts code 0 JSON", () => {
    assert.equal(rpcCodeIsZero('{"code":0,"result":{}}'), true);
  });

  test("rejects non-zero, HTML, and invalid JSON", () => {
    assert.equal(rpcCodeIsZero('{"code":11}'), false);
    assert.equal(rpcCodeIsZero("<html>login</html>"), false);
    assert.equal(rpcCodeIsZero("not-json"), false);
  });
});

describe("probeSession", () => {
  test("missing cookie is auth_expired, never ok", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => new Response("no", { status: 200 }));
    const missing = await probeSession({ cookie: null, fetchImpl });
    assert.equal(missing.ok, false);
    if (missing.ok) {
      throw new Error("unreachable");
    }
    assert.equal(missing.status, "auth_expired");
    assert.match(missing.message, /NTESSTUDYSI|login/i);

    const noSid = await probeSession({ cookie: "FOO=bar", fetchImpl });
    assert.equal(noSid.ok, false);
    if (noSid.ok) {
      throw new Error("unreachable");
    }
    assert.equal(noSid.status, "auth_expired");
    assert.deepEqual(calls, []);
  });

  test("warm-up Set-Cookie STUDY_INFO is success", async () => {
    const { calls, fetchImpl } = recordingFetch(async (url) => {
      if (url === WARMUP_URL) {
        return new Response("<html>ok</html>", {
          status: 200,
          headers: {
            "set-cookie": "STUDY_INFO=test-study-info; Domain=.icourse163.org; Path=/",
          },
        });
      }
      return new Response("should not run", { status: 500 });
    });

    const result = await probeSession({ cookie: SESSION, fetchImpl });
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    assert.match(result.cookie, /NTESSTUDYSI=test-session/);
    assert.match(result.cookie, /STUDY_INFO=test-study-info/);
    assert.deepEqual(
      calls.map((call) => call.url),
      [WARMUP_URL],
    );
  });

  test("warm-up without STUDY_INFO still succeeds when course-list RPC returns code 0", async () => {
    const { fetchImpl } = recordingFetch(async (url) => {
      if (url === WARMUP_URL) {
        return new Response("<html>home</html>", { status: 200 });
      }
      if (url.startsWith(COURSE_LIST_RPC_URL)) {
        return new Response(JSON.stringify({ code: 0, result: { result: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });

    const result = await probeSession({ cookie: SESSION, fetchImpl });
    assert.equal(result.ok, true);
  });

  test("invalid session is auth_expired when warm-up and RPC both fail", async () => {
    const { fetchImpl } = recordingFetch(async (url) => {
      if (url === WARMUP_URL) {
        return new Response("<html>login</html>", { status: 200 });
      }
      return new Response(JSON.stringify({ code: 11, result: null }), { status: 200 });
    });

    const result = await probeSession({ cookie: SESSION, fetchImpl });
    assert.equal(result.ok, false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    assert.equal(result.status, "auth_expired");
    assert.notEqual(result.status, "ok");
  });

  // Regression: for some sessions icourse163 answers HTML pages (including the
  // warm-up) with a logout redirect whose Set-Cookie clears NTESSTUDYSI using a
  // quoted empty value plus an epoch Expires. The warm-up must not let that strip
  // the token, otherwise every later RPC runs with csrfKey="" and fails -1002.
  test("warm-up logout redirect does not strip NTESSTUDYSI from the session", async () => {
    const LOGOUT_URL = "https://www.icourse163.org/passport/member/logout.htm?lgoutp=1";
    const { calls, fetchImpl } = recordingFetch(async (url) => {
      if (url === WARMUP_URL) {
        return new Response("", { status: 302, headers: { location: LOGOUT_URL } });
      }
      if (url.startsWith(LOGOUT_URL)) {
        return new Response("<html>logged out</html>", {
          status: 200,
          headers: {
            "set-cookie":
              'NTESSTUDYSI=""; Domain=icourse163.org; Expires=Thu, 01-Jan-1970 00:00:10 GMT; Path=/',
          },
        });
      }
      if (url.startsWith(COURSE_LIST_RPC_URL)) {
        return new Response(JSON.stringify({ code: 0, result: { result: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });

    const result = await probeSession({ cookie: SESSION, fetchImpl });
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    assert.match(result.cookie, /NTESSTUDYSI=test-session/);
    assert.doesNotMatch(result.cookie, /NTESSTUDYSI=""/);

    const rpcCall = calls.find((call) => call.url.startsWith(COURSE_LIST_RPC_URL));
    assert.ok(rpcCall, "expected a course-list probe call");
    assert.match(rpcCall.url, /csrfKey=test-session/);
    assert.doesNotMatch(rpcCall.url, /csrfKey=%22%22/);
  });
});
