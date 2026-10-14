import { createHash } from "node:crypto";

/**
 * Request signing for icourse163's JSON RPCs (`/web/j/*.rpc`).
 *
 * Several endpoints — notably `saveMocContentLearn`, the one that records learning
 * progress — reject unsigned requests. The rejection messages are actively
 * misleading and cost this project a long detour: they read as anti-abuse bans
 * rather than as signature failures.
 *
 *   未签名  → {"code":-2,"message":"请检查本地时间是否和北京时间一致-10006"}
 *   错误签名 → {"code":-2,"message":"并发限制，请稍后再试"}
 *   正确签名 → {"code":0,"result":true}
 *
 * The scheme was recovered from the site bundle
 * `mc.stu.126.net/rc/main/assets/reactBase-49d0a293.fa9b5e55.js`:
 *
 *   g = function (t) {
 *     var a = t.Timestamp || +new Date,
 *         u = t.Nonce || (Math.floor(9000 * Math.random()) + 1000),
 *         c = t.body ? JSON.stringify(t.body) : "",
 *         s = c + u + a + "fu2s2kxcswgn5hqanx7asmlogyr5wu29";
 *     return HASH(s).toLocaleUpperCase();
 *   };
 *
 * so the digest is MD5 over the exact body bytes, the nonce, the timestamp, and a
 * hard-coded key, upper-cased. Verified against a captured triplet: the 267-byte
 * body plus nonce 8508 and timestamp 1791965599916 reproduces the signature the
 * browser actually sent, byte for byte.
 *
 * See docs/adr/0004-rpc-request-signing.md. If the site rotates the key or the
 * digest, this is the file to update.
 */

/** Hard-coded signing key shipped in the site bundle. */
export const ICOURSE163_RPC_SIGN_KEY = "fu2s2kxcswgn5hqanx7asmlogyr5wu29";

/** Nonce range used by the site: Math.floor(9000 * rand()) + 1000. */
export function randomRpcNonce(random: () => number = Math.random): number {
  return Math.floor(9000 * random()) + 1000;
}

/** MD5(body + nonce + timestamp + key), upper-cased. */
export function icourse163RpcSignature(body: string, nonce: number, timestamp: number): string {
  return createHash("md5")
    .update(`${body}${nonce}${timestamp}${ICOURSE163_RPC_SIGN_KEY}`, "utf8")
    .digest("hex")
    .toUpperCase();
}

export type SignedRpcRequest = {
  /** Body to send verbatim. Signing covers these exact bytes. */
  body: string;
  headers: Record<string, string>;
};

/**
 * Builds the signed body and headers for a JSON RPC call.
 *
 * `now` and `nonce` are injectable so tests can assert a fixed signature; the
 * body must be sent exactly as returned or the signature will not verify.
 */
export function buildSignedRpcRequest(input: {
  dto: unknown;
  csrfKey: string;
  origin: string;
  referer: string;
  now?: number;
  nonce?: number;
}): SignedRpcRequest {
  const body = JSON.stringify({ dto: input.dto });
  const timestamp = input.now ?? Date.now();
  const nonce = input.nonce ?? randomRpcNonce();
  return {
    body,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "edu-script-token": input.csrfKey,
      origin: input.origin,
      referer: input.referer,
      timestamp: String(timestamp),
      nonce: String(nonce),
      system: "v1",
      "auth-signature": icourse163RpcSignature(body, nonce, timestamp),
    },
  };
}
