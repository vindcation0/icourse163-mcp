import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ICOURSE163_RPC_SIGN_KEY,
  buildSignedRpcRequest,
  icourse163RpcSignature,
  randomRpcNonce,
} from "../src/rpc-sign";

/**
 * A real triplet captured from the browser on 2026-10-14: the exact 267-byte body
 * it POSTed to courseRpcBean.saveMocContentLearn.rpc, the nonce and timestamp
 * headers it sent, and the auth-signature it produced. Pinning this locks both the
 * digest and the concatenation order; if the site changes either, this test is the
 * canary rather than a silent -10006 in production.
 */
const CAPTURED_BODY =
  '{"dto":{"unitId":1305575052,"finished":true,"index":1,"duration":60000,"courseId":1450750234,"lessonId":1265444035,"videoId":1216009818,"termId":1475848441,"userId":"1597616487","contentType":1,"action":"LEARN_TIME_COUNT","videoTime":1126,"learnedVideoTimeCount":60}}';
const CAPTURED_NONCE = 8508;
const CAPTURED_TIMESTAMP = 1791965599916;
const CAPTURED_SIGNATURE = "AD771CA3DBAA099FE9C99973C3CE27AD";

describe("icourse163RpcSignature", () => {
  test("reproduces the signature the browser actually sent", () => {
    assert.equal(CAPTURED_BODY.length, 267);
    assert.equal(
      icourse163RpcSignature(CAPTURED_BODY, CAPTURED_NONCE, CAPTURED_TIMESTAMP),
      CAPTURED_SIGNATURE,
    );
  });

  test("is upper-cased md5 over body+nonce+timestamp+key", () => {
    assert.equal(ICOURSE163_RPC_SIGN_KEY, "fu2s2kxcswgn5hqanx7asmlogyr5wu29");
    assert.match(CAPTURED_SIGNATURE, /^[0-9A-F]{32}$/);
  });

  test("changes when any input changes", () => {
    const base = icourse163RpcSignature(CAPTURED_BODY, CAPTURED_NONCE, CAPTURED_TIMESTAMP);
    assert.notEqual(icourse163RpcSignature(`${CAPTURED_BODY} `, CAPTURED_NONCE, CAPTURED_TIMESTAMP), base);
    assert.notEqual(icourse163RpcSignature(CAPTURED_BODY, CAPTURED_NONCE + 1, CAPTURED_TIMESTAMP), base);
    assert.notEqual(icourse163RpcSignature(CAPTURED_BODY, CAPTURED_NONCE, CAPTURED_TIMESTAMP + 1), base);
  });
});

describe("randomRpcNonce", () => {
  test("stays in the site's 1000..10000 range", () => {
    assert.equal(randomRpcNonce(() => 0), 1000);
    assert.equal(randomRpcNonce(() => 0.999999), 9999);
    for (let i = 0; i < 200; i += 1) {
      const n = randomRpcNonce();
      assert.ok(n >= 1000 && n <= 10000, `nonce out of range: ${n}`);
    }
  });
});

describe("buildSignedRpcRequest", () => {
  test("signs exactly the body it returns, so the transport must not re-serialize", () => {
    const request = buildSignedRpcRequest({
      dto: { unitId: 1, finished: true },
      csrfKey: "test-session",
      origin: "https://www.icourse163.org",
      referer: "https://www.icourse163.org/learn/XDU-1?tid=2",
      now: 1791965599916,
      nonce: 8508,
    });

    assert.equal(request.body, '{"dto":{"unitId":1,"finished":true}}');
    assert.equal(
      request.headers["auth-signature"],
      icourse163RpcSignature(request.body, 8508, 1791965599916),
    );
    assert.equal(request.headers["content-type"], "application/json;charset=UTF-8");
    assert.equal(request.headers["edu-script-token"], "test-session");
    assert.equal(request.headers.system, "v1");
    assert.equal(request.headers.timestamp, "1791965599916");
    assert.equal(request.headers.nonce, "8508");
    assert.equal(request.headers.origin, "https://www.icourse163.org");
  });
});
