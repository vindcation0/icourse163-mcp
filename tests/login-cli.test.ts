import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { AuthProbeResult } from "../src/auth";
import type { WritableCredentialStore } from "../src/credentials";
import {
  LOGIN_OK,
  SESSION_CLEARED,
  SESSION_OK,
  credentialsFromFlagsAndEnv,
  parseLoginArgv,
  runLoginCli,
} from "../src/login-cli";
import type { PasswordLoginRunner } from "../src/open-login";

const SECRET = "s3cret-value";
const COOKIE = "NTESSTUDYSI=test-session";

function memoryStore(
  cookie: string | null = null,
): WritableCredentialStore & { cookie: string | null } {
  return {
    cookie,
    async getCookie() {
      return this.cookie;
    },
    async setCookie(value: string) {
      this.cookie = value;
    },
    async clearCookie() {
      this.cookie = null;
    },
  };
}

function capturingIo() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
      },
    },
    getStdout() {
      return stdout;
    },
    getStderr() {
      return stderr;
    },
  };
}

const okProbe = async (cookie: string | null): Promise<AuthProbeResult> => {
  if (cookie == null || !cookie.includes("NTESSTUDYSI")) {
    return { ok: false, status: "auth_expired", message: "auth_expired" };
  }
  return { ok: true, cookie };
};

const unusedPasswordLogin: PasswordLoginRunner = {
  async loginWithPassword() {
    throw new Error("should not run");
  },
};

describe("parseLoginArgv", () => {
  test("reads --cookie-file, -u/-p, --check, --clear, -h", () => {
    const parsed = parseLoginArgv([
      "--cookie-file",
      "/tmp/c.txt",
      "-u",
      "alice",
      "-p",
      SECRET,
    ]);
    assert.equal(parsed.error, null);
    assert.equal(parsed.cookieFile, "/tmp/c.txt");
    assert.equal(parsed.username, "alice");
    assert.equal(parsed.password, SECRET);
    assert.equal(parsed.help, false);

    assert.equal(parseLoginArgv(["-h"]).help, true);
    assert.equal(parseLoginArgv(["--check"]).check, true);
    assert.equal(parseLoginArgv(["--clear"]).clear, true);
  });

  test("returns an error for unknown flags", () => {
    const parsed = parseLoginArgv(["--bogus"]);
    assert.notEqual(parsed.error, null);
  });
});

describe("credentialsFromFlagsAndEnv", () => {
  test("uses env when flags are missing; flags override env", () => {
    assert.deepEqual(
      credentialsFromFlagsAndEnv(
        {
          username: undefined,
          password: undefined,
          cookieFile: undefined,
          help: false,
          clear: false,
          check: false,
          showPassword: false,
          error: null,
        },
        { ICOURSE163_USERNAME: "alice", ICOURSE163_PASSWORD: SECRET },
      ),
      { username: "alice", password: SECRET },
    );
    assert.deepEqual(
      credentialsFromFlagsAndEnv(
        {
          username: "bob",
          password: "flag-secret",
          cookieFile: undefined,
          help: false,
          clear: false,
          check: false,
          showPassword: false,
          error: null,
        },
        { ICOURSE163_USERNAME: "alice", ICOURSE163_PASSWORD: SECRET },
      ),
      { username: "bob", password: "flag-secret" },
    );
  });
});

describe("runLoginCli", () => {
  test("cookie-file path stores the session, probes, and prints LOGIN_OK without secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "icourse163-login-"));
    const cookieFile = join(dir, "cookie.txt");
    await writeFile(cookieFile, `${COOKIE}\n`, "utf8");
    const store = memoryStore();
    const io = capturingIo();
    let probed: string | null = null;

    const code = await runLoginCli({
      argv: ["--cookie-file", cookieFile],
      env: {},
      credentials: store,
      probe: async (cookie) => {
        probed = cookie;
        return okProbe(cookie);
      },
      passwordLogin: unusedPasswordLogin,
      io,
    });

    assert.equal(code, 0);
    assert.match(io.getStdout(), new RegExp(`^${LOGIN_OK}\\n$`));
    assert.doesNotMatch(io.getStdout(), /test-session/);
    assert.doesNotMatch(io.getStderr(), /test-session/);
    assert.equal(store.cookie, COOKIE);
    assert.equal(probed, COOKIE);
  });

  test("ICOURSE163_COOKIE env is used when no cookie-file flag is given", async () => {
    const store = memoryStore();
    const io = capturingIo();
    const code = await runLoginCli({
      argv: [],
      env: { ICOURSE163_COOKIE: COOKIE },
      credentials: store,
      probe: okProbe,
      passwordLogin: unusedPasswordLogin,
      io,
    });
    assert.equal(code, 0);
    assert.match(io.getStdout(), /LOGIN_OK has_cookie=true/);
    assert.equal(store.cookie, COOKIE);
  });

  test("rejects a cookie file without NTESSTUDYSI and does not store it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "icourse163-login-"));
    const cookieFile = join(dir, "cookie.txt");
    await writeFile(cookieFile, "FOO=bar\n", "utf8");
    const store = memoryStore();
    const io = capturingIo();
    const code = await runLoginCli({
      argv: ["--cookie-file", cookieFile],
      env: {},
      credentials: store,
      probe: okProbe,
      passwordLogin: unusedPasswordLogin,
      io,
    });
    assert.equal(code, 1);
    assert.equal(io.getStdout(), "");
    assert.match(io.getStderr(), /NTESSTUDYSI/);
    assert.equal(store.cookie, null);
  });

  test("probe failure after cookie paste is auth_expired, not LOGIN_OK", async () => {
    const store = memoryStore();
    const io = capturingIo();
    const code = await runLoginCli({
      argv: [],
      env: { ICOURSE163_COOKIE: COOKIE },
      credentials: store,
      probe: async () => ({
        ok: false,
        status: "auth_expired",
        message: "auth_expired: session rejected",
      }),
      passwordLogin: unusedPasswordLogin,
      io,
    });
    assert.equal(code, 1);
    assert.equal(io.getStdout(), "");
    assert.match(io.getStderr(), /auth_expired/);
    assert.equal(store.cookie, null);
  });

  test("fake password login prints LOGIN_OK without cookie or password", async () => {
    const store = memoryStore();
    const io = capturingIo();
    const passwordLogin: PasswordLoginRunner = {
      async loginWithPassword(credentials) {
        assert.equal(credentials.username, "alice");
        assert.equal(credentials.password, SECRET);
        await store.setCookie(COOKIE);
      },
    };

    const code = await runLoginCli({
      argv: ["-u", "alice", "-p", SECRET],
      env: {},
      credentials: store,
      probe: okProbe,
      passwordLogin,
      io,
    });

    assert.equal(code, 0);
    assert.match(io.getStdout(), new RegExp(`^${LOGIN_OK}\\n$`));
    assert.doesNotMatch(io.getStdout(), /test-session/);
    assert.doesNotMatch(io.getStdout(), new RegExp(SECRET));
    assert.doesNotMatch(io.getStderr(), new RegExp(SECRET));
    assert.equal(store.cookie, COOKIE);
  });

  test("password login failure is redacted", async () => {
    const io = capturingIo();
    const code = await runLoginCli({
      argv: ["-u", "alice", "-p", SECRET],
      env: {},
      credentials: memoryStore(),
      probe: okProbe,
      passwordLogin: {
        async loginWithPassword() {
          throw new Error(`passport rejected ${SECRET}`);
        },
      },
      io,
    });
    assert.equal(code, 1);
    assert.equal(io.getStdout(), "");
    assert.match(io.getStderr(), /passport|failed|rejected/i);
    assert.doesNotMatch(io.getStderr(), new RegExp(SECRET));
  });

  test("--check probes the stored session without printing it", async () => {
    const store = memoryStore(COOKIE);
    const io = capturingIo();
    const code = await runLoginCli({
      argv: ["--check"],
      env: {},
      credentials: store,
      probe: okProbe,
      passwordLogin: unusedPasswordLogin,
      io,
    });
    assert.equal(code, 0);
    assert.match(io.getStdout(), new RegExp(`^${SESSION_OK}\\n$`));
    assert.doesNotMatch(io.getStdout(), /test-session/);
  });

  test("--clear deletes the stored session", async () => {
    const store = memoryStore(COOKIE);
    const io = capturingIo();
    const code = await runLoginCli({
      argv: ["--clear"],
      env: {},
      credentials: store,
      probe: okProbe,
      passwordLogin: unusedPasswordLogin,
      io,
    });
    assert.equal(code, 0);
    assert.match(io.getStdout(), new RegExp(`^${SESSION_CLEARED}\\n$`));
    assert.equal(store.cookie, null);
  });

  test("usage mentions cookie-file, env names, and that MCP never takes passwords", async () => {
    const io = capturingIo();
    const code = await runLoginCli({
      argv: ["-h"],
      env: {},
      credentials: memoryStore(),
      probe: okProbe,
      passwordLogin: unusedPasswordLogin,
      io,
    });
    assert.equal(code, 0);
    assert.match(io.getStdout(), /--cookie-file/);
    assert.match(io.getStdout(), /ICOURSE163_COOKIE/);
    assert.match(io.getStdout(), /ICOURSE163_PASSWORD/);
    assert.match(io.getStdout(), /never take/);
    assert.match(io.getStdout(), /--silent/);
    assert.match(io.getStdout(), /Chromium|Chrome/);
  });


  test("stale ICOURSE163_COOKIE without NTESSTUDYSI falls through to password when creds exist", async () => {
    const store = memoryStore();
    const io = capturingIo();
    let passwordRan = false;
    const code = await runLoginCli({
      argv: [],
      env: {
        ICOURSE163_COOKIE: "FOO=bar",
        ICOURSE163_USERNAME: "alice",
        ICOURSE163_PASSWORD: SECRET,
      },
      credentials: store,
      probe: okProbe,
      passwordLogin: {
        async loginWithPassword(credentials) {
          passwordRan = true;
          assert.equal(credentials.username, "alice");
          assert.equal(credentials.password, SECRET);
          await store.setCookie(COOKIE);
        },
      },
      io,
    });
    assert.equal(code, 0);
    assert.equal(passwordRan, true);
    assert.match(io.getStdout(), /LOGIN_OK has_cookie=true/);
    assert.equal(store.cookie, COOKIE);
  });

  test("ICOURSE163_COOKIE that fails probe falls through to password when creds exist", async () => {
    const store = memoryStore();
    const io = capturingIo();
    let passwordRan = false;
    let probeCalls = 0;
    const code = await runLoginCli({
      argv: [],
      env: {
        ICOURSE163_COOKIE: COOKIE,
        ICOURSE163_USERNAME: "alice",
        ICOURSE163_PASSWORD: SECRET,
      },
      credentials: store,
      probe: async (cookie) => {
        probeCalls += 1;
        if (probeCalls === 1) {
          return {
            ok: false,
            status: "auth_expired",
            message: "auth_expired: session rejected",
          };
        }
        return okProbe(cookie);
      },
      passwordLogin: {
        async loginWithPassword() {
          passwordRan = true;
          await store.setCookie(COOKIE);
        },
      },
      io,
    });
    assert.equal(code, 0);
    assert.equal(passwordRan, true);
    assert.match(io.getStdout(), /LOGIN_OK has_cookie=true/);
  });

  test("cookie-file without NTESSTUDYSI does not fall through even with password env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "icourse163-login-"));
    const cookieFile = join(dir, "cookie.txt");
    await writeFile(cookieFile, "FOO=bar\n", "utf8");
    const store = memoryStore();
    const io = capturingIo();
    let passwordRan = false;
    const code = await runLoginCli({
      argv: ["--cookie-file", cookieFile],
      env: { ICOURSE163_USERNAME: "alice", ICOURSE163_PASSWORD: SECRET },
      credentials: store,
      probe: okProbe,
      passwordLogin: {
        async loginWithPassword() {
          passwordRan = true;
        },
      },
      io,
    });
    assert.equal(code, 1);
    assert.equal(passwordRan, false);
    assert.match(io.getStderr(), /NTESSTUDYSI/);
    assert.equal(store.cookie, null);
  });

  test("exits non-zero when credentials are missing and there is no prompt", async () => {
    const io = capturingIo();
    const code = await runLoginCli({
      argv: [],
      env: {},
      credentials: memoryStore(),
      probe: okProbe,
      passwordLogin: unusedPasswordLogin,
      io,
    });
    assert.equal(code, 1);
    assert.match(io.getStderr(), /cookie-file|ICOURSE163_/);
  });
});
