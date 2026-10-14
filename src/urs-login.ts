import { createCipheriv, publicEncrypt, constants } from "node:crypto";

/**
 * Pure-HTTP login for the 网易 URS component that icourse163.org embeds.
 *
 * Reverse-engineered from `webzj.netstatic.net/webzj_cdn101/pp_index_dl_<hash>.js`
 * (the bundle the login iframe loads for pkid=cjJVGQM / product=imooc). Every
 * constant and algorithm below was checked against captured traffic or against the
 * site's own code; see docs/adr/0005-urs-http-login.md for the evidence, the
 * verification method, and the one step that remains unknown.
 *
 * Flow (all POST, body `{"encParams": <SM4 hex>}` unless noted):
 *   1. /dl/zj/{yd|mail}/ini      -> {ret, capFlag, pv, capId}
 *   2. /dl/zj/{yd|mail}/powGetP  -> {pVInfo:{sid,hashFunc,minTime,maxTime,args}}
 *   3. solve the VDF locally
 *   4. /dl/zj/{yd|mail}/gt       -> {tk}
 *   5. /dl/zj/yd/pwd/l | /dl/zj/mail/l with the RSA-encrypted password and pVParam
 *
 * The flow needs a cookie jar: powGetP is rejected with `{ret:"401",dt:"07"}` unless
 * the cookie set by `ini` (e.g. `l_yd_s_imooccjJVGQM`) is sent back.
 */

/** Hard-coded SM4 key from the bundle: `var _sm4pubkey = "..."`. */
export const URS_SM4_KEY = "BC60B8B9E4FFEFFA219E5AD77F11F9E2";

/** Hard-coded RSA public key (X.509 / rsaEncryption) from the bundle. */
export const URS_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC5gsH+AA4XWONB5TDcUd+xCz7ejOFHZKlcZDx+pF1i7Gsvi1vjyJoQhRtRSn950x498VUkx7rUxg1/ScBVfrRxQOZ8xFBye3pjAzfb22+RCuYApSVpJ3OO3KsEuKExftz9oFBv3ejxPlYc5yq7YiBO8XlTnQN0Sa4R4qhPO3I2MQIDAQAB
-----END PUBLIC KEY-----`;

export const URS_HOST = "https://reg.icourse163.org";
export const URS_PRODUCT = "imooc";
export const URS_PKID = "cjJVGQM";
export const URS_TOP_URL = "https://www.icourse163.org/";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Channels the site uses on the URS endpoints. */
export type UrsChannel = 0 | 1; // 0 = email ("mail"), 1 = phone ("yd")

export type UrsHttpResponse = {
  statusCode: number;
  body: string;
  /** Raw Set-Cookie lines (name=value; ...), in order. */
  setCookie: string[];
};

export type UrsHttp = {
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<UrsHttpResponse>;
};

/** 32 random alphanumerics, matching the bundle's `_p.getRtid`. */
export function ursRtid(): string {
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  }
  return out;
}

/** `_p._$sm4Encrypt`: SM4-ECB + PKCS7 over JSON, hex-encoded. */
export function ursSm4Encrypt(params: unknown, keyHex: string = URS_SM4_KEY): string {
  const cipher = createCipheriv("sm4-ecb", Buffer.from(keyHex, "hex"), null);
  const json = JSON.stringify(params);
  return Buffer.concat([cipher.update(Buffer.from(json, "utf8")), cipher.final()]).toString("hex");
}

/**
 * The bundle's `powSign`: MurmurHash3 x86_32 over the key string's char codes.
 *
 * Verified equivalent to the site's own function over 36,400 differential cases
 * (every length remainder 0..3, plus realistic `runTimes=..&spendTime=..` keys).
 */
export function ursPowSign(key: string, seed: number): number {
  const remainder = key.length & 3;
  const bytes = key.length - remainder;
  let h1 = seed | 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let i = 0;
  while (i < bytes) {
    let k1 =
      (key.charCodeAt(i) & 0xff) |
      ((key.charCodeAt(++i) & 0xff) << 8) |
      ((key.charCodeAt(++i) & 0xff) << 16) |
      ((key.charCodeAt(++i) & 0xff) << 24);
    i += 1;
    k1 = ((k1 & 0xffff) * c1 + ((((k1 >>> 16) * c1) & 0xffff) << 16)) & 0xffffffff;
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = ((k1 & 0xffff) * c2 + ((((k1 >>> 16) * c2) & 0xffff) << 16)) & 0xffffffff;
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    const h1b = ((h1 & 0xffff) * 5 + ((((h1 >>> 16) * 5) & 0xffff) << 16)) & 0xffffffff;
    h1 = (h1b & 0xffff) + 0x6b64 + ((((h1b >>> 16) + 0xe654) & 0xffff) << 16);
  }
  let k1 = 0;
  switch (remainder) {
    case 3:
      k1 ^= (key.charCodeAt(i + 2) & 0xff) << 16;
    // falls through
    case 2:
      k1 ^= (key.charCodeAt(i + 1) & 0xff) << 8;
    // falls through
    case 1:
      k1 ^= key.charCodeAt(i) & 0xff;
      k1 = ((k1 & 0xffff) * c1 + ((((k1 >>> 16) * c1) & 0xffff) << 16)) & 0xffffffff;
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = ((k1 & 0xffff) * c2 + ((((k1 >>> 16) * c2) & 0xffff) << 16)) & 0xffffffff;
      h1 ^= k1;
  }
  h1 ^= key.length;
  h1 ^= h1 >>> 16;
  h1 = ((h1 & 0xffff) * 0x85ebca6b + ((((h1 >>> 16) * 0x85ebca6b) & 0xffff) << 16)) & 0xffffffff;
  h1 ^= h1 >>> 13;
  h1 = ((h1 & 0xffff) * 0xc2b2ae35 + ((((h1 >>> 16) * 0xc2b2ae35) & 0xffff) << 16)) & 0xffffffff;
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

export type UrsPuzzle = { x: string; mod: string; t: number; minTime: number; maxTime: number };
export type UrsPower = { x: string; t: number; sign: number; spendTime: number; runTimes: number };

/**
 * The bundle's `vdfAsync`: repeated squaring `x = x*x mod N`, continuing until both
 * `t` iterations and `minTime` have elapsed, and giving up at `maxTime`.
 *
 * `minTime` (~1000ms) is the real constraint, not `t`: observed runs did ~3.4M
 * squarings against a `t` of 200000. The submitted `t` is the achieved count.
 */
export function ursSolvePuzzle(
  puzzle: UrsPuzzle,
  now: () => number = Date.now,
): UrsPower {
  let value = BigInt(`0x${puzzle.x}`);
  const modulus = BigInt(`0x${puzzle.mod}`);
  const start = now();
  let count = 0;
  for (let i = 0; i < puzzle.t || now() - start < puzzle.minTime; i += 1) {
    value = (value * value) % modulus;
    count += 1;
    if (now() - start > puzzle.maxTime) {
      break;
    }
  }
  const spendTime = now() - start;
  const signKey = `runTimes=${count}&spendTime=${spendTime}&t=${count}&x=${value.toString(16)}`;
  return {
    x: value.toString(16),
    t: count,
    sign: ursPowSign(signKey, count),
    spendTime,
    runTimes: count,
  };
}

/**
 * The bundle's `RSA.encrypt(data, publicKey)`: PKCS#1 v1.5 padding, then
 * `Base64.encode(Hex.decode(cipher.toString(16)))`. Node's publicEncrypt with
 * RSA_PKCS1_PADDING produces the same 128 bytes for a 1024-bit key.
 */
export function ursEncryptPassword(password: string): string {
  return publicEncrypt(
    { key: URS_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, "utf8"),
  ).toString("base64");
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Default transport: global fetch, with redirects left for the caller to see. */
export function createUrsHttp(): UrsHttp {
  return {
    async post(url, body, headers) {
      const response = await fetch(url, { method: "POST", headers, body, redirect: "manual" });
      const text = await response.text();
      const setCookie =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [];
      return { statusCode: response.status, body: text, setCookie };
    },
  };
}

type Jar = Map<string, string>;

function absorbCookies(jar: Jar, setCookie: readonly string[]): void {
  for (const line of setCookie) {
    const pair = line.split(";")[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) {
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
  }
}

function jarHeader(jar: Jar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

export type UrsLoginStage = "ini" | "powGetP" | "gt" | "submit";

export type UrsLoginResult = {
  ok: boolean;
  /** Where the flow stopped when it did not succeed. */
  stage: UrsLoginStage;
  ret: string | null;
  dt: string | null;
  message: string;
  /** `401` + `dt:"02"` is the server asking for a slider captcha, not a bad request. */
  needsCaptcha: boolean;
  /** The session cookie header produced by a successful login, or "". */
  cookie: string;
  ticket: string | null;
  power: UrsPower | null;
};

export type UrsLoginOptions = {
  account: string;
  password: string;
  channel?: UrsChannel;
  http?: UrsHttp;
  /** Injectable clock, so tests can make the VDF loop deterministic. */
  now?: () => number;
};

const RESPONSE_MESSAGES: Record<string, string> = {
  "201": "登录成功",
  "401": "参数错误或被要求额外验证",
  "402": "指纹错误",
  "423": "风控账号",
};

/**
 * Runs the whole login over HTTP. Performs no request beyond the five URS calls, and
 * never sends the password in clear: it is RSA-encrypted, then SM4-wrapped.
 */
export async function ursLogin(options: UrsLoginOptions): Promise<UrsLoginResult> {
  const channel: UrsChannel = options.channel ?? 1;
  const prefix = channel === 1 ? "yd" : "mail";
  const http = options.http ?? createUrsHttp();
  const now = options.now ?? Date.now;
  const jar: Jar = new Map();
  const rtid = ursRtid();

  const base = {
    pd: URS_PRODUCT,
    pkid: URS_PKID,
    channel,
    topURL: URS_TOP_URL,
  };

  const call = async (
    path: string,
    params: Record<string, unknown>,
  ): Promise<{ statusCode: number; json: Record<string, unknown> | null; body: string }> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      origin: "https://www.icourse163.org",
      referer: URS_TOP_URL,
      "user-agent": USER_AGENT,
    };
    const cookie = jarHeader(jar);
    if (cookie.length > 0) {
      headers.cookie = cookie;
    }
    const response = await http.post(
      `${URS_HOST}${path}`,
      JSON.stringify({ encParams: ursSm4Encrypt(params) }),
      headers,
    );
    absorbCookies(jar, response.setCookie);
    return { statusCode: response.statusCode, json: parseJson(response.body), body: response.body };
  };

  const baseResult = { cookie: "", ticket: null, power: null } as const;
  const retOf = (json: Record<string, unknown> | null): string | null =>
    json?.ret == null ? null : String(json.ret);
  const dtOf = (json: Record<string, unknown> | null): string | null =>
    json?.dt == null ? null : String(json.dt);

  // 1. init
  const ini = await call(`/dl/zj/${prefix}/ini`, {
    ...base,
    pkht: "www.icourse163.org",
    rtid,
  });
  if (retOf(ini.json) !== "201") {
    const ret = retOf(ini.json);
    return {
      ok: false,
      stage: "ini",
      ret,
      dt: dtOf(ini.json),
      message: `URS ini failed: HTTP ${ini.statusCode} ret=${ret} ${ini.body.slice(0, 200)}`,
      needsCaptcha: ret === "401",
      ...baseResult,
    };
  }

  // 2. proof-of-work challenge
  const powResponse = await call(`/dl/zj/${prefix}/powGetP`, {
    ...base,
    un: options.account,
    rtid,
  });
  const pvInfo = powResponse.json?.pVInfo as
    | { sid?: string; hashFunc?: string; minTime?: number; maxTime?: number; args?: Record<string, unknown> }
    | undefined;
  const args = pvInfo?.args;
  if (retOf(powResponse.json) !== "201" || args == null) {
    const ret = retOf(powResponse.json);
    return {
      ok: false,
      stage: "powGetP",
      ret,
      dt: dtOf(powResponse.json),
      message:
        `URS powGetP failed: HTTP ${powResponse.statusCode} ret=${ret} ` +
        `dt=${dtOf(powResponse.json) ?? ""} — dt=07 usually means the ` +
        `cookie from the ini call was not sent back`,
      needsCaptcha: false,
      ...baseResult,
    };
  }
  const hashFunc = String(pvInfo?.hashFunc ?? "");
  if (hashFunc !== "VDF_FUNCTION") {
    // RECUR_HASHCASH and the fallback (sequFun) are other formats this build does not implement.
    return {
      ok: false,
      stage: "powGetP",
      ret: "201",
      dt: null,
      message: `URS powGetP returned an unsupported hashFunc: ${hashFunc || "(missing)"}`,
      needsCaptcha: false,
      ...baseResult,
    };
  }
  const power = ursSolvePuzzle(
    {
      x: String(args.x ?? ""),
      mod: String(args.mod ?? ""),
      t: Number(args.t ?? 0),
      minTime: Number(pvInfo?.minTime ?? 0),
      maxTime: Number(pvInfo?.maxTime ?? 0),
    },
    now,
  );

  // 3. ticket
  const gt = await call(`/dl/zj/${prefix}/gt`, { ...base, un: options.account, rtid });
  const ticket = gt.json?.tk == null ? null : String(gt.json.tk);
  if (retOf(gt.json) !== "201" || ticket == null) {
    const ret = retOf(gt.json);
    return {
      ok: false,
      stage: "gt",
      ret,
      dt: dtOf(gt.json),
      message: `URS gt failed: HTTP ${gt.statusCode} ret=${ret} ${gt.body.slice(0, 200)}`,
      needsCaptcha: ret === "401",
      cookie: "",
      ticket: null,
      power,
    };
  }

  // 4. submit. The phone channel is /yd/pwd/l; the email channel is /mail/l.
  const submitPath = channel === 1 ? "/dl/zj/yd/pwd/l" : "/dl/zj/mail/l";
  const submit = await call(submitPath, {
    ...base,
    un: options.account,
    pw: ursEncryptPassword(options.password),
    tk: ticket,
    domains: "",
    pVParam: JSON.stringify({ x: power.x, t: power.t, sign: power.sign }),
    pkht: "www.icourse163.org",
    rtid,
  });
  const ret = retOf(submit.json);
  const dt = dtOf(submit.json);
  const needsCaptcha = ret === "401" && dt === "02";
  const cookie = jarHeader(jar);
  if (ret === "201") {
    return {
      ok: true,
      stage: "submit",
      ret,
      dt,
      message: "登录成功",
      needsCaptcha: false,
      cookie,
      ticket,
      power,
    };
  }
  return {
    ok: false,
    stage: "submit",
    ret,
    dt,
    message: needsCaptcha
      ? "URS asked for a slider captcha (401/dt=02) before accepting the password. " +
        "This is the site's adaptive risk control, not a malformed request; use the " +
        "browser login (`npm run login`) for this account."
      : `URS login failed: HTTP ${submit.statusCode} ret=${ret} — ` +
        `${RESPONSE_MESSAGES[ret ?? ""] ?? submit.body.slice(0, 200)}`,
    needsCaptcha,
    cookie,
    ticket,
    power,
  };
}
