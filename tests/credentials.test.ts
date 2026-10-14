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
  defaultSessionFilePath,
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
      defaultSessionFilePath({ XDG_CONFIG_HOME: "/tmp/xdg-config" }, "/home/user"),
      "/tmp/xdg-config/icourse163-mcp/session",
    );
    assert.equal(
      defaultSessionFilePath({}, "/home/user"),
      "/home/user/.config/icourse163-mcp/session",
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
