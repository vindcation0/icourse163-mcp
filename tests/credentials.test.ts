import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  cookieHasNtesstudysi,
  cookieHasStudyInfo,
  mergeSetCookies,
  normalizeToCookieHeader,
  ntesstudysiFromCookie,
} from "../src/cookie";
import {
  createFileCredentialStore,
  createKeyringCredentialStore,
  defaultSessionFilePath,
  KEYCHAIN_MAX_CREDENTIAL_BYTES,
  type KeychainEntry,
} from "../src/credentials";

const SESSION = "NTESSTUDYSI=test-session";
const WITH_INFO = `${SESSION}; STUDY_INFO=test-study-info`;

describe("cookie helpers", () => {
  test("extracts NTESSTUDYSI from a Cookie header", () => {
    assert.equal(ntesstudysiFromCookie(WITH_INFO), "test-session");
    assert.equal(cookieHasNtesstudysi(WITH_INFO), true);
    assert.equal(cookieHasStudyInfo(WITH_INFO), true);
  });

  test("rejects cookies without NTESSTUDYSI", () => {
    assert.equal(cookieHasNtesstudysi("FOO=bar"), false);
    assert.equal(ntesstudysiFromCookie("FOO=bar"), null);
  });

  test("strips a Cookie: prefix and collapses newlines", () => {
    const header = normalizeToCookieHeader("Cookie: NTESSTUDYSI=test-session\nSTUDY_INFO=x");
    assert.equal(cookieHasNtesstudysi(header), true);
    assert.equal(ntesstudysiFromCookie(header), "test-session");
  });

  test("parses Netscape cookies.txt for icourse163.org", () => {
    const text = [
      "# Netscape HTTP Cookie File",
      ".icourse163.org\tTRUE\t/\tTRUE\t0\tNTESSTUDYSI\ttest-session",
      ".example.com\tTRUE\t/\tTRUE\t0\tNTESSTUDYSI\tother-host",
    ].join("\n");
    const header = normalizeToCookieHeader(text);
    assert.equal(ntesstudysiFromCookie(header), "test-session");
    assert.doesNotMatch(header, /other-host/);
  });

  test("merges Set-Cookie STUDY_INFO and ignores other hosts", () => {
    const merged = mergeSetCookies(SESSION, [
      "STUDY_INFO=test-study-info; Domain=.icourse163.org; Path=/",
      "evil=1; Domain=example.com; Path=/",
    ]);
    assert.equal(cookieHasStudyInfo(merged), true);
    assert.equal(ntesstudysiFromCookie(merged), "test-session");
    assert.doesNotMatch(merged, /evil=/);
  });

  // icourse163 answers HTML pages with a logout redirect whose Set-Cookie clears
  // the session using a quoted empty value plus an epoch Expires. Treating `""`
  // as a real value made a dead session look alive and poisoned the csrfKey.
  test("deletes a cookie cleared by an expired Expires and quoted empty value", () => {
    const merged = mergeSetCookies(`${SESSION}; STUDY_INFO=test-study-info`, [
      'NTESSTUDYSI=""; Domain=icourse163.org; Expires=Thu, 01-Jan-1970 00:00:10 GMT; Path=/',
    ]);
    assert.equal(cookieHasNtesstudysi(merged), false);
    assert.equal(ntesstudysiFromCookie(merged), null);
    assert.equal(cookieHasStudyInfo(merged), true);
    assert.doesNotMatch(merged, /%22|""/);
  });

  test("deletes a cookie cleared with an unquoted empty value", () => {
    const merged = mergeSetCookies(WITH_INFO, [
      "STUDY_INFO=; Domain=.icourse163.org; Expires=Thu, 01-Jan-1970 00:00:10 GMT; Path=/",
    ]);
    assert.equal(cookieHasStudyInfo(merged), false);
    assert.equal(ntesstudysiFromCookie(merged), "test-session");
  });

  test("deletes a cookie cleared by Max-Age=0", () => {
    const merged = mergeSetCookies(WITH_INFO, [
      "STUDY_INFO=x; Domain=.icourse163.org; Max-Age=0; Path=/",
    ]);
    assert.equal(cookieHasStudyInfo(merged), false);
  });

  test("strips surrounding quotes from a live cookie value", () => {
    const merged = mergeSetCookies(SESSION, [
      'STUDY_INFO="live-value"; Domain=.icourse163.org; Path=/',
    ]);
    assert.equal(merged.includes('STUDY_INFO="live-value"'), false);
    assert.match(merged, /STUDY_INFO=live-value(?:;|$)/);
    assert.equal(cookieHasStudyInfo(merged), true);
  });

  test("keeps a cookie whose Expires is in the future", () => {
    const merged = mergeSetCookies(SESSION, [
      "STUDY_INFO=live; Domain=.icourse163.org; Expires=Thu, 01-Jan-2099 00:00:10 GMT; Path=/",
    ]);
    assert.equal(cookieHasStudyInfo(merged), true);
  });
});

describe("file credential store", () => {
  test("roundtrips a cookie at 0600 under an explicit path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "icourse163-session-"));
    const path = join(dir, "session");
    const store = createFileCredentialStore({ path });

    assert.equal(await store.getCookie(), null);
    await store.setCookie(WITH_INFO);
    assert.equal(await store.getCookie(), WITH_INFO);

    if (process.platform !== "win32") {
      const info = await stat(path);
      assert.equal(info.mode & 0o777, 0o600);
    }

    await store.clearCookie();
    assert.equal(await store.getCookie(), null);
  });

  test("defaultSessionFilePath prefers XDG_CONFIG_HOME", () => {
    assert.equal(
      defaultSessionFilePath({ XDG_CONFIG_HOME: join("/tmp", "xdg-config") }, join("/home", "user")),
      join("/tmp", "xdg-config", "icourse163-mcp", "session"),
    );
    assert.equal(
      defaultSessionFilePath({}, join("/home", "user")),
      join("/home", "user", ".config", "icourse163-mcp", "session"),
    );
  });

  test("empty file is treated as missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "icourse163-session-"));
    const path = join(dir, "session");
    await writeFile(path, "  \n", "utf8");
    const store = createFileCredentialStore({ path });
    assert.equal(await store.getCookie(), null);
  });
});

// The Windows keychain caps a credential blob at 2560 bytes and the library stores the
// password as UTF-16, so a full icourse163 cookie (1700-2900 chars) can never be written
// there. Reads prefer the keychain, so a surviving older entry silently shadows the file:
// `login` reports success while every catalog tool sees an empty account.
describe("keychain store", () => {
  const SHORT_COOKIE = "NTESSTUDYSI=short-session; STUDY_INFO=short-info";
  // 1512 chars -> 3024 bytes as UTF-16, over the 2560-byte blob limit.
  const LONG_COOKIE = `NTESSTUDYSI=${"a".repeat(1500)}`;
  const STALE_COOKIE = "NTESSTUDYSI=stale-session";

  function fakeKeychain(options: {
    stored?: string | null;
    failSet?: boolean;
    failDelete?: boolean;
  } = {}) {
    const calls: string[] = [];
    let stored: string | null = options.stored ?? null;
    const entry: KeychainEntry = {
      async getPassword() {
        calls.push("get");
        return stored;
      },
      async setPassword(value: string) {
        calls.push("set");
        if (options.failSet === true) {
          throw new Error(
            "Value of 'password encoded as UTF-16' is longer than the platform limit of 2560 chars",
          );
        }
        stored = value;
      },
      async deletePassword() {
        calls.push("delete");
        if (options.failDelete === true) {
          throw new Error("keychain unavailable");
        }
        stored = null;
      },
    };
    return { entry, calls, peek: () => stored };
  }

  /** logStoreError writes to stderr; the failure tests would otherwise spam the run. */
  function muted<T>(run: () => Promise<T>): Promise<T> {
    const original = console.error;
    console.error = () => undefined;
    return run().finally(() => {
      console.error = original;
    });
  }

  async function fileStore(name: string) {
    const dir = await mkdtemp(join(tmpdir(), `icourse163-${name}-`));
    const path = join(dir, "session");
    return { path, store: createFileCredentialStore({ path }) };
  }

  test("the oversize threshold really is under the long-cookie length", () => {
    assert.ok(LONG_COOKIE.length * 2 > KEYCHAIN_MAX_CREDENTIAL_BYTES);
    assert.ok(SHORT_COOKIE.length * 2 < KEYCHAIN_MAX_CREDENTIAL_BYTES);
  });

  test("a failed keychain write drops the stale entry so the file takes effect", async () => {
    const file = await fileStore("shadow");
    const keychain = fakeKeychain({ stored: STALE_COOKIE, failSet: true });
    const store = createKeyringCredentialStore({
      fallback: file.store,
      entry: keychain.entry,
    });

    await muted(() => store.setCookie(SHORT_COOKIE));

    assert.ok(keychain.calls.includes("delete"), "stale keychain value must be removed");
    assert.equal(keychain.peek(), null);
    assert.equal(await file.store.getCookie(), SHORT_COOKIE);
    // The whole point: what getCookie() returns is the cookie just written.
    assert.equal(await store.getCookie(), SHORT_COOKIE);
  });

  test("an over-limit cookie never attempts the keychain write", async () => {
    const file = await fileStore("oversize");
    const keychain = fakeKeychain({ stored: STALE_COOKIE });
    const store = createKeyringCredentialStore({
      fallback: file.store,
      entry: keychain.entry,
    });

    await store.setCookie(LONG_COOKIE);

    assert.equal(keychain.calls.includes("set"), false, "write would be rejected anyway");
    assert.equal(keychain.peek(), null, "older value must not survive");
    assert.equal(await file.store.getCookie(), LONG_COOKIE);
  });

  test("a cookie that fits stays in the keychain and leaves no file behind", async () => {
    const file = await fileStore("fits");
    const keychain = fakeKeychain();
    const store = createKeyringCredentialStore({
      fallback: file.store,
      entry: keychain.entry,
    });

    await store.setCookie(SHORT_COOKIE);

    assert.equal(keychain.peek(), SHORT_COOKIE);
    assert.equal(await file.store.getCookie(), null);
    assert.equal(await store.getCookie(), SHORT_COOKIE);
  });

  test("a failed delete does not fail the write that follows", async () => {
    const file = await fileStore("delete-fails");
    const keychain = fakeKeychain({
      stored: STALE_COOKIE,
      failSet: true,
      failDelete: true,
    });
    const store = createKeyringCredentialStore({
      fallback: file.store,
      entry: keychain.entry,
    });

    await muted(() => store.setCookie(SHORT_COOKIE));
    assert.equal(await file.store.getCookie(), SHORT_COOKIE);
  });

  test("without a file store an over-limit cookie fails loudly", async () => {
    const store = createKeyringCredentialStore({ entry: fakeKeychain().entry });
    await assert.rejects(() => store.setCookie(LONG_COOKIE), /2560/);
  });

  test("without a file store a keychain write failure still throws", async () => {
    const store = createKeyringCredentialStore({
      entry: fakeKeychain({ failSet: true }).entry,
    });
    await muted(() => assert.rejects(() => store.setCookie(SHORT_COOKIE), /keychain/));
  });
});
