import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { probeSession, type AuthProbeResult } from "./auth";
import { cookieHasNtesstudysi, normalizeToCookieHeader } from "./cookie";
import type { WritableCredentialStore } from "./credentials";
import {
  createPlaywrightPasswordLogin,
  describeLoginFailure,
  passwordPromptLabel,
  redactLoginSecrets,
  showPasswordEnabled,
  type PasswordCredentials,
  type PasswordLoginRunner,
} from "./open-login";

export const LOGIN_OK = "LOGIN_OK has_cookie=true";
export const SESSION_OK = "SESSION_OK has_cookie=true";
export const SESSION_CLEARED = "SESSION_CLEARED";

const USAGE = `Usage: npm run login --silent -- [--cookie-file <path>] [-u|--username <user>]

Store a 中国大学MOOC (icourse163.org) session locally. MCP tools never take
passwords or cookies.

Cookie paste (reliable last resort):
  --cookie-file <path>   Cookie header or Netscape cookies.txt (must include NTESSTUDYSI)
  env ICOURSE163_COOKIE  Same as --cookie-file, but from the environment.
                         Takes precedence over password env when valid. If the
                         env cookie lacks NTESSTUDYSI or fails the session probe
                         and username/password are also set, falls through to
                         Playwright password login.

Password login (Playwright; needs Chrome/Chromium):
  env ICOURSE163_USERNAME / ICOURSE163_PASSWORD
  Flags -u/--username and -p/--password override env. Prefer env or a hidden
  prompt; npm may reprint -p unless you pass --silent.
  --hide-password        do not echo the password (also ICOURSE163_HIDE_PASSWORD=1).
                         Visible is the default; visible input stays in the scrollback.
  Optional ICOURSE163_CHROME = path to a Chrome/Chromium binary.

Does not implement institutional SSO. Does not scrape answers or auto-submit.

Other:
  --check   Probe the stored session (no secrets printed)
  --clear   Delete the stored session (keychain and file fallback)
  -h/--help

On success prints "${LOGIN_OK}" (or "${SESSION_OK}" / "${SESSION_CLEARED}").
Never prints the password or cookie value.
Session is stored in the OS keychain (service icourse163.mcp) with a 0600
file fallback under $XDG_CONFIG_HOME/icourse163-mcp/session or
~/.config/icourse163-mcp/session.
`;

export type ParsedLoginFlags = {
  username: string | undefined;
  password: string | undefined;
  cookieFile: string | undefined;
  help: boolean;
  clear: boolean;
  check: boolean;
  hidePassword: boolean;
  error: string | null;
};

export type LoginCliIo = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  promptUsername?: () => Promise<string>;
  promptPassword?: () => Promise<string>;
};

export type SessionProbe = (cookie: string | null) => Promise<AuthProbeResult>;

export function parseLoginArgv(argv: string[]): ParsedLoginFlags {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        username: { type: "string", short: "u" },
        password: { type: "string", short: "p" },
        "cookie-file": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        clear: { type: "boolean", default: false },
        check: { type: "boolean", default: false },
        "hide-password": { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    return {
      username: values.username,
      password: values.password,
      cookieFile: values["cookie-file"],
      help: values.help === true,
      clear: values.clear === true,
      check: values.check === true,
      hidePassword: values["hide-password"] === true,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      username: undefined,
      password: undefined,
      cookieFile: undefined,
      help: false,
      clear: false,
      check: false,
      hidePassword: false,
      error: message,
    };
  }
}

export function credentialsFromFlagsAndEnv(
  flags: ParsedLoginFlags,
  env: NodeJS.ProcessEnv,
): { username: string; password: string } {
  const username = flags.username?.trim() || env.ICOURSE163_USERNAME?.trim() || "";
  const password =
    flags.password !== undefined && flags.password.length > 0
      ? flags.password
      : (env.ICOURSE163_PASSWORD ?? "");
  return { username, password };
}

export function expandUserPath(path: string, home: string = homedir()): string {
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/")) {
    return resolve(home, path.slice(2));
  }
  return resolve(path);
}

export async function runLoginCli(input: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  credentials: WritableCredentialStore;
  probe: SessionProbe;
  passwordLogin: PasswordLoginRunner;
  io: LoginCliIo;
  readFile?: (path: string) => Promise<string>;
}): Promise<number> {
  const flags = parseLoginArgv(input.argv);
  if (flags.help) {
    input.io.stdout.write(USAGE);
    return 0;
  }
  if (flags.error != null) {
    input.io.stderr.write(`${flags.error}\n${USAGE}`);
    return 1;
  }
  if (flags.clear) {
    await input.credentials.clearCookie();
    input.io.stdout.write(`${SESSION_CLEARED}\n`);
    return 0;
  }
  if (flags.check) {
    const stored = await input.credentials.getCookie();
    const probed = await input.probe(stored);
    if (!probed.ok) {
      input.io.stderr.write(`${probed.message}\n`);
      return 1;
    }
    input.io.stdout.write(`${SESSION_OK}\n`);
    return 0;
  }

  const cookieSource = await readCookieSource(flags, input);
  if (cookieSource.error != null) {
    input.io.stderr.write(`${cookieSource.error}\n`);
    return 1;
  }
  if (cookieSource.cookie != null) {
    const cookieOutcome = await tryFinishWithCookie(cookieSource.cookie, input);
    if (cookieOutcome.ok) {
      return 0;
    }
    const preview = credentialsFromFlagsAndEnv(flags, input.env);
    const canFallThrough =
      cookieSource.source === "env" &&
      preview.username.length > 0 &&
      preview.password.length > 0;
    if (!canFallThrough) {
      input.io.stderr.write(`${cookieOutcome.message}\n`);
      return 1;
    }
    // Stale/incomplete ICOURSE163_COOKIE: fall through to Playwright password login.
  }

  let resolved = credentialsFromFlagsAndEnv(flags, input.env);
  try {
    if (resolved.username.length === 0 && input.io.promptUsername != null) {
      resolved = {
        ...resolved,
        username: (await input.io.promptUsername()).trim(),
      };
    }
    if (resolved.password.length === 0 && input.io.promptPassword != null) {
      resolved = { ...resolved, password: await input.io.promptPassword() };
    }
  } catch (error) {
    const message = redactLoginSecrets(describeLoginFailure(error), resolved);
    input.io.stderr.write(`${message}\n`);
    return 1;
  }

  if (resolved.username.length === 0 || resolved.password.length === 0) {
    input.io.stderr.write(
      "Provide a cookie (--cookie-file / ICOURSE163_COOKIE) or username and password via -u/-p or ICOURSE163_USERNAME/ICOURSE163_PASSWORD.\n",
    );
    return 1;
  }

  const creds: PasswordCredentials = resolved;
  try {
    await input.passwordLogin.loginWithPassword(creds);
    const cookie = await input.credentials.getCookie();
    if (cookie == null || cookie.trim() === "") {
      input.io.stderr.write(
        "Password login failed: no cookie was stored. Chrome/Chromium must be available, or paste a cookie instead.\n",
      );
      return 1;
    }
    return finishWithStoredCookie(cookie, input, creds);
  } catch (error) {
    const message = redactLoginSecrets(describeLoginFailure(error), creds);
    input.io.stderr.write(`${message}\n`);
    return 1;
  }
}

async function tryFinishWithCookie(
  rawCookie: string,
  input: {
    credentials: WritableCredentialStore;
    probe: SessionProbe;
    io: LoginCliIo;
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const cookie = normalizeToCookieHeader(rawCookie);
  if (!cookieHasNtesstudysi(cookie)) {
    return {
      ok: false,
      message:
        "Cookie is missing NTESSTUDYSI. Paste the Cookie header from an icourse163.org request after login.",
    };
  }
  const probed = await input.probe(cookie);
  if (!probed.ok) {
    return { ok: false, message: probed.message };
  }
  await input.credentials.setCookie(probed.cookie);
  input.io.stdout.write(`${LOGIN_OK}\n`);
  return { ok: true };
}

async function finishWithStoredCookie(
  cookie: string,
  input: {
    credentials: WritableCredentialStore;
    probe: SessionProbe;
    io: LoginCliIo;
  },
  creds: PasswordCredentials,
): Promise<number> {
  const probed = await input.probe(cookie);
  if (!probed.ok) {
    input.io.stderr.write(
      `${redactLoginSecrets(probed.message, creds, [cookie])}\n`,
    );
    return 1;
  }
  await input.credentials.setCookie(probed.cookie);
  input.io.stdout.write(`${LOGIN_OK}\n`);
  return 0;
}

async function readCookieSource(
  flags: ParsedLoginFlags,
  input: {
    env: NodeJS.ProcessEnv;
    io: LoginCliIo;
    readFile?: (path: string) => Promise<string>;
  },
): Promise<{
  cookie: string | null;
  error: string | null;
  source: "file" | "env" | null;
}> {
  if (flags.cookieFile != null && flags.cookieFile.trim() !== "") {
    const path = expandUserPath(flags.cookieFile);
    try {
      const read = input.readFile ?? ((filePath: string) => readFile(filePath, "utf8"));
      const raw = await read(path);
      if (raw.trim().length === 0) {
        return { cookie: null, error: "Cookie file is empty.", source: null };
      }
      return { cookie: raw, error: null, source: "file" };
    } catch (error) {
      if (isNotFound(error)) {
        return { cookie: null, error: "Cookie file not found.", source: null };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return {
        cookie: null,
        error: `Failed to read cookie file: ${detail}`,
        source: null,
      };
    }
  }
  const fromEnv = input.env.ICOURSE163_COOKIE;
  if (fromEnv != null && fromEnv.trim() !== "") {
    return { cookie: fromEnv, error: null, source: "env" };
  }
  return { cookie: null, error: null, source: null };
}

function isNotFound(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function ttyPrompter(
  // Visible by default, matching showPasswordEnabled; callers pass the resolved value.
  showPassword = true,
): Pick<LoginCliIo, "promptUsername" | "promptPassword"> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return {};
  }
  return {
    async promptUsername() {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await rl.question("Username: ");
      } finally {
        rl.close();
      }
    },
    async promptPassword() {
      // Visible unless the caller opts out: hidden input is awkward for passwords that are
      // hard to type blind, but visible input stays in the scrollback and in recordings.
      const label = passwordPromptLabel(showPassword, true);
      if (!showPassword) {
        return readHiddenPassword(label);
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(label);
      } finally {
        rl.close();
      }
    },
  };
}

async function readHiddenPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  stdout.write(prompt);
  if (typeof stdin.setRawMode !== "function") {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question("");
    } finally {
      rl.close();
    }
  }

  const previousRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return new Promise((resolvePromise, reject) => {
    const restore = () => {
      stdin.off("data", onData);
      stdin.setRawMode(previousRaw);
      stdin.pause();
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text === "\u0003") {
        restore();
        stdout.write("\n");
        reject(new Error("login cancelled"));
        return;
      }
      if (text === "\n" || text === "\r" || text === "\r\n") {
        restore();
        stdout.write("\n");
        resolvePromise(value);
        return;
      }
      if (text === "\u007f" || text === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += text;
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const { createLocalCredentialStore } = await import("./credentials");
  const store = createLocalCredentialStore();
  const fetchImpl = globalThis.fetch;
  const flags = parseLoginArgv(process.argv.slice(2));
  // Visible by default; --hide-password or ICOURSE163_HIDE_PASSWORD=1 turns it off.
  const showPassword = showPasswordEnabled(flags.hidePassword, process.env);
  const code = await runLoginCli({
    argv: process.argv.slice(2),
    env: process.env,
    credentials: store,
    probe: (cookie) => probeSession({ cookie, fetchImpl }),
    passwordLogin: createPlaywrightPasswordLogin(store, {
      env: process.env,
      platform: process.platform,
    }),
    io: {
      stdout: process.stdout,
      stderr: process.stderr,
      ...ttyPrompter(showPassword),
    },
  });
  process.exit(code);
}

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
