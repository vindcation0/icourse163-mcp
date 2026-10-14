import assert from "node:assert/strict";
import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
} from "node:crypto";
import { describe, test } from "node:test";

import {
  URS_PKID,
  URS_PRODUCT,
  URS_SM4_KEY,
  ursEncryptPassword,
  ursLandSession,
  ursLogin,
  ursPowSign,
  ursSm4Encrypt,
  ursSolvePuzzle,
  type UrsHttp,
  type UrsHttpResponse,
} from "../src/urs-login";

describe("ursSm4Encrypt", () => {
  // A real request the site's own client sent, captured from the browser.
  const CAPTURED =
    "746628c1d80daa15585d90cadd41445fd80bd7c73126c9a49623be514a07a27ed1d900d63d125921f6a73ffdb7c64bf5afdf726003252c5af61bed0fadd5ae40b1e6cecd5374623a7bd48e37ec5e9c62db7e2de2428e97521b82319f78d8813a464277ddb9fc049e063505c072f81910e95b2a6d01896647c1e01fb27630a0824a78b40bf1c1464e4147da93172420ff033baedf336bfc4dda753d616fd849c7";
  const PARAMS = {
    pd: "imooc",
    pkid: "cjJVGQM",
    pkht: "www.icourse163.org",
    channel: 1,
    topURL: "https://www.icourse163.org/",
    rtid: "8eS7nbTDMxOw8qXatjDTYBtGdRZLJR5A",
  };

  test("reproduces a captured request byte for byte", () => {
    assert.equal(ursSm4Encrypt(PARAMS), CAPTURED);
  });

  test("is SM4-ECB with PKCS7 and round-trips", () => {
    const decipher = createDecipheriv("sm4-ecb", Buffer.from(URS_SM4_KEY, "hex"), null);
    const back = Buffer.concat([
      decipher.update(Buffer.from(CAPTURED, "hex")),
      decipher.final(),
    ]).toString("utf8");
    assert.deepEqual(JSON.parse(back), PARAMS);
  });
});

describe("ursPowSign", () => {
  // Vectors produced by the site's own powSign, extracted verbatim from the login
  // bundle. It is MurmurHash3 x86_32; the port matched that reference over 36,400
  // differential cases, and these vectors keep it pinned without shipping the bundle.
  const VECTORS: [string, number, number][] = [
    ["", 0, 0],
    ["a", 1, 1485495528],
    ["hello", 0, 613153351],
    ["abcd", 0xffffffff, 729662808],
    [
      "runTimes=3411457&spendTime=1000&t=3411457&x=399bf33b700a8e460f490779fa4311aedf",
      3411457,
      2479569268,
    ],
  ];

  for (const [key, seed, expected] of VECTORS) {
    test(`matches the site for ${JSON.stringify(key.slice(0, 24))} seed=${seed}`, () => {
      assert.equal(ursPowSign(key, seed), expected);
    });
  }

  test("exercises every tail branch (remainder 0..3)", () => {
    // lengths 0,1,2,3,4 hit the switch cases; all must be stable numbers
    for (const key of ["", "a", "ab", "abc", "abcd"]) {
      const value = ursPowSign(key, 7);
      assert.equal(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, true);
    }
  });
});

describe("ursSolvePuzzle", () => {
  test("squares x repeatedly and stops at maxTime", () => {
    // 1, 2, 4, 8, ... : x=3, mod=0x100 -> 3,9,81,0x91... take the first few steps
    let ticks = 0;
    const now = () => {
      ticks += 1;
      return ticks * 100; // 100ms per call
    };
    const power = ursSolvePuzzle(
      { x: "3", mod: "100", t: 4, minTime: 0, maxTime: 1000 },
      now,
    );
    // mod 0x100 = 256: 3 -> 9 -> 81 -> 6561 % 256 = 161 -> 161^2 % 256 = 65
    assert.equal(power.x, "41");
    assert.equal(power.runTimes, 4);
    // sign must be the murmur of the exact key it reports
    assert.equal(
      power.sign,
      ursPowSign(
        `runTimes=${power.runTimes}&spendTime=${power.spendTime}&t=${power.t}&x=${power.x}`,
        power.runTimes,
      ),
    );
  });

  test("keeps going past t while minTime has not elapsed", () => {
    // The site's loop is `i < t || elapsed < minTime`: minTime is the real constraint,
    // which is why observed runs did ~3.4M squarings against a t of 200000.
    let ticks = 0;
    const now = () => {
      ticks += 1;
      return ticks;
    };
    const power = ursSolvePuzzle(
      { x: "3", mod: "ffffffffffffffff", t: 2, minTime: 1000, maxTime: 1_000_000 },
      now,
    );
    assert.equal(power.runTimes > 2, true);
    assert.equal(power.spendTime >= 1000, true);
    assert.equal(power.spendTime <= 1_000_000, true);
  });
});

describe("ursEncryptPassword", () => {
  test("emits a 128-byte base64 ciphertext under the site's key", () => {
    const b64 = ursEncryptPassword("hunter2");
    const encrypted = Buffer.from(b64, "base64");
    // 1024-bit modulus -> a fixed 128-byte block
    assert.equal(encrypted.length, 128);
    assert.equal(encrypted.toString("base64"), b64);
  });

  // The site's key is public only, so its ciphertext cannot be opened here. Instead,
  // show that RSA_PKCS1_PADDING is really the type-2 construction the bundle's
  // pkcs1pad2 builds — 0x00 0x02 <non-zero padding> 0x00 <message> — by decrypting a
  // probe with a local key using NO_PADDING, which exposes the raw padded block.
  test("uses the same padding shape as the bundle's pkcs1pad2", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const probe = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from("hunter2", "utf8"),
    );
    const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, probe);
    assert.equal(block.length, 128);
    assert.equal(block[0], 0x00);
    assert.equal(block[1], 0x02);
    const separator = block.indexOf(0x00, 2);
    // 0x00 0x02 <padding> 0x00 <message>: the 7-byte message ends at byte 127,
    // so the separator sits one byte before it.
    assert.equal(separator, block.length - 8);
    assert.equal(block.subarray(-7).toString("utf8"), "hunter2");
    assert.equal(block.subarray(2, separator).every((byte) => byte !== 0), true);
    assert.equal(separator >= 8, true);
  });

  test("uses fresh random padding every time", () => {
    assert.notEqual(ursEncryptPassword("hunter2"), ursEncryptPassword("hunter2"));
  });

  test("never emits the plaintext", () => {
    assert.equal(ursEncryptPassword("secret-value").includes("secret-value"), false);
  });
});

// --------------------------------------------------------------------------- //
// Flow tests against a fake URS server
// --------------------------------------------------------------------------- //

type Call = { url: string; params: Record<string, unknown>; cookie: string | undefined };

function fakeUrs(
  handler: (path: string, params: Record<string, unknown>, callIndex: number) => {
    body: Record<string, unknown>;
    setCookie?: string[];
  },
): { http: UrsHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: UrsHttp = {
    async post(url, body, headers): Promise<UrsHttpResponse> {
      const decipher = createDecipheriv("sm4-ecb", Buffer.from(URS_SM4_KEY, "hex"), null);
      const encParams = (JSON.parse(body) as { encParams: string }).encParams;
      const params = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(encParams, "hex")),
          decipher.final(),
        ]).toString("utf8"),
      ) as Record<string, unknown>;
      const path = new URL(url).pathname;
      calls.push({ url, params, cookie: headers.cookie });
      const result = handler(path, params, calls.length);
      return {
        statusCode: 200,
        body: JSON.stringify(result.body),
        setCookie: result.setCookie ?? [],
      };
    },
  };
  return { http, calls };
}

const PUZZLE = {
  sid: "sid-1",
  hashFunc: "VDF_FUNCTION",
  minTime: 0,
  maxTime: 1000,
  args: { x: "3", mod: "100", t: 2 },
};

describe("ursLandSession", () => {
  test("merges the icourse163 session cookies and drops the useless URS ones", async () => {
    const seen: string[] = [];
    const http: UrsHttp = {
      async post() {
        throw new Error("not used");
      },
      async get(url, headers) {
        seen.push(`${url} cookie=${headers.cookie}`);
        // mirrors what /passport/logingate/changeCookie.htm and /member/login.htm set
        return {
          statusCode: 200,
          body: "",
          finalUrl: "https://www.icourse163.org/passport/logingate/changeCookie.htm",
          setCookie: [
            'STUDY_INFO="yd.x@163.com|8|1|2"; path=/',
            'STUDY_SESS="abc"; path=/',
            `STUDY_PERSIST="def"; path=/`,
            ...(url.includes("member/login.htm") ? ["NTESSTUDYSI=token-1; path=/"] : []),
          ],
        };
      },
    };

    const result = await ursLandSession({
      cookie: "NTES_YD_PASSPORT=urs-passport; NTES_YD_SESS=urs-sess; URS_ONLY=noise; S_INFO=x",
      http,
    });

    assert.equal(result.ok, true);
    assert.equal(result.hasApiToken, true);
    assert.equal(result.hasWebSession, true);
    assert.equal(seen.length, 2, "both landing URLs must be requested");
    assert.match(seen[0] ?? "", /NTES_YD_PASSPORT=urs-passport/);
    assert.match(seen[1] ?? "", /STUDY_INFO=/);
    // the URS-only cookies are dropped: keeping them pushed the stored value past the
    // Windows keychain's 2560-byte limit, so the write fell back to a file and the
    // keychain kept serving a stale cookie.
    assert.doesNotMatch(result.cookie, /URS_ONLY/);
    assert.doesNotMatch(result.cookie, /NTES_YD_SESS/);
    assert.match(result.cookie, /NTESSTUDYSI=token-1/);
    assert.match(result.cookie, /STUDY_SESS="abc"/);
    assert.match(result.cookie, /NTES_YD_PASSPORT=urs-passport/);
  });

  test("reports failure when the landing yields no API token", async () => {
    const http: UrsHttp = {
      async post() {
        throw new Error("not used");
      },
      async get() {
        return { statusCode: 200, body: "", finalUrl: "", setCookie: [] };
      },
    };
    const result = await ursLandSession({ cookie: "NTES_YD_PASSPORT=x", http });
    assert.equal(result.ok, false);
    assert.equal(result.hasApiToken, false);
    assert.match(result.message, /NTESSTUDYSI/);
  });
});

describe("ursLogin", () => {
  test("walks ini -> powGetP -> gt -> submit and returns the session cookie", async () => {
    const { http, calls } = fakeUrs((path) => {
      if (path.endsWith("/ini")) {
        return { body: { ret: "201", capFlag: 0, pv: true, capId: "" }, setCookie: ["l_s_imooc=abc; path=/"] };
      }
      if (path.endsWith("/powGetP")) return { body: { ret: "201", pVInfo: PUZZLE } };
      if (path.endsWith("/gt")) return { body: { ret: "201", tk: "ticket-1" } };
      if (path.endsWith("/pwd/l")) {
        return { body: { ret: "201" }, setCookie: ["NTESSTUDYSI=session-1; path=/"] };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await ursLogin({
      account: "13800000000",
      password: "pw",
      channel: 1,
      http,
      now: (() => { let t = 0; return () => (t += 50); })(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.stage, "submit");
    assert.equal(result.ticket, "ticket-1");
    assert.match(result.cookie, /NTESSTUDYSI=session-1/);
    assert.deepEqual(
      calls.map((c) => new URL(c.url).pathname),
      ["/dl/zj/yd/ini", "/dl/zj/yd/powGetP", "/dl/zj/yd/gt", "/dl/zj/yd/pwd/l"],
    );
    // the cookie handed out by ini must be replayed, or powGetP answers dt=07
    assert.equal(calls[0]?.cookie, undefined);
    assert.match(calls[1]?.cookie ?? "", /l_s_imooc=abc/);
    // the submit carries the RSA-encrypted password, the ticket and the solved power
    const submit = calls[3]?.params ?? {};
    assert.equal(submit.pkid, URS_PKID);
    assert.equal(submit.pd, URS_PRODUCT);
    assert.equal(submit.tk, "ticket-1");
    assert.equal(submit.pw === "pw", false);
    const power = submit.pVParam as {
      puzzle?: unknown;
      spendTime?: unknown;
      runTimes?: unknown;
      sid?: unknown;
      args?: unknown;
    };
    // pVParam is the nested OBJECT the real client sends, with `args` as a JSON string
    // inside it — not a flat JSON string. Getting that wrong is what produced 401/dt=02
    // for an entire round (see docs/adr/0005-urs-http-login.md).
    assert.equal(typeof power, "object");
    assert.equal(power.sid, "sid-1");
    assert.equal(power.runTimes, 2);
    assert.equal(typeof power.args, "string");
    const inner = JSON.parse(String(power.args)) as { x: string; t: number; sign: number };
    // x=3, mod=0x100, t=2: 3 -> 9 -> 81 = 0x51
    assert.equal(inner.x, "51");
    assert.equal(inner.t, 2);
    assert.equal(typeof inner.sign, "number");
    // the real client always sends the 十天内免登录 pair
    assert.equal(submit.l, 1);
    assert.equal(submit.d, 10);
    // the ticket request must not leak the password
    assert.equal(JSON.stringify(calls.slice(0, 3)).includes('"pw"'), false);
  });

  test("uses the mail endpoints for channel 0", async () => {
    const { http, calls } = fakeUrs((path) => {
      if (path.endsWith("/ini")) return { body: { ret: "201" } };
      if (path.endsWith("/powGetP")) return { body: { ret: "201", pVInfo: PUZZLE } };
      if (path.endsWith("/gt")) return { body: { ret: "201", tk: "tk" } };
      return { body: { ret: "201" } };
    });
    const result = await ursLogin({
      account: "a@example.com",
      password: "pw",
      channel: 0,
      http,
      now: () => 0,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      calls.map((c) => new URL(c.url).pathname),
      ["/dl/zj/mail/ini", "/dl/zj/mail/powGetP", "/dl/zj/mail/gt", "/dl/zj/mail/l"],
    );
  });

  test("rejects 401/dt=02 with the corrected reading, not 'captcha'", async () => {
    const { http } = fakeUrs((path) => {
      if (path.endsWith("/ini")) return { body: { ret: "201" } };
      if (path.endsWith("/powGetP")) return { body: { ret: "201", pVInfo: PUZZLE } };
      if (path.endsWith("/gt")) return { body: { ret: "201", tk: "tk" } };
      return { body: { ret: "401", dt: "02" } };
    });
    const result = await ursLogin({ account: "x", password: "y", http, now: () => 0 });
    assert.equal(result.ok, false);
    assert.equal(result.ret, "401");
    // 401 is NOT one of the captcha codes: the client's slide handler runs for every
    // code, which is what made this look like a captcha demand.
    assert.equal(result.needsCaptcha, false);
    assert.match(result.message, /--channel phone/);
    assert.match(result.message, /hides the 网易邮箱账号登录/);
  });

  test("flags the codes the bundle treats as a captcha demand", async () => {
    for (const code of ["441", "444", "445", "447"]) {
      const { http } = fakeUrs((path) => {
        if (path.endsWith("/ini")) return { body: { ret: "201" } };
        if (path.endsWith("/powGetP")) return { body: { ret: "201", pVInfo: PUZZLE } };
        if (path.endsWith("/gt")) return { body: { ret: "201", tk: "tk" } };
        return { body: { ret: code } };
      });
      const result = await ursLogin({ account: "x", password: "y", http, now: () => 0 });
      assert.equal(result.needsCaptcha, true, `code ${code} should be a captcha code`);
    }
  });

  test("a non-captcha rejection is not flagged as one", async () => {
    const { http } = fakeUrs((path) => {
      if (path.endsWith("/ini")) return { body: { ret: "201" } };
      if (path.endsWith("/powGetP")) return { body: { ret: "201", pVInfo: PUZZLE } };
      if (path.endsWith("/gt")) return { body: { ret: "201", tk: "tk" } };
      return { body: { ret: "423" } };
    });
    const result = await ursLogin({ account: "x", password: "y", http, now: () => 0 });
    assert.equal(result.needsCaptcha, false);
    assert.equal(result.ret, "423");
  });

  test("explains a powGetP rejection as a missing cookie", async () => {
    const { http } = fakeUrs((path) => {
      if (path.endsWith("/ini")) return { body: { ret: "201" } };
      return { body: { ret: "401", dt: "07" } };
    });
    const result = await ursLogin({ account: "x", password: "y", http, now: () => 0 });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "powGetP");
    assert.equal(result.dt, "07");
    assert.match(result.message, /cookie/);
  });

  test("refuses an unsupported hashFunc instead of producing a wrong solution", async () => {
    const { http } = fakeUrs((path) => {
      if (path.endsWith("/ini")) return { body: { ret: "201" } };
      return { body: { ret: "201", pVInfo: { ...PUZZLE, hashFunc: "RECUR_HASHCASH" } } };
    });
    const result = await ursLogin({ account: "x", password: "y", http, now: () => 0 });
    assert.equal(result.ok, false);
    assert.match(result.message, /RECUR_HASHCASH/);
  });
});
