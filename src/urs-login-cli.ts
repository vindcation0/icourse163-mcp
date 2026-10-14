import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

import { createLocalCredentialStore } from "./credentials";
import { redactLoginSecrets } from "./open-login";
import { ursLogin, type UrsChannel } from "./urs-login";

/**
 * Pure-HTTP login for URS (no browser). Shares the credential store with the
 * Playwright login, so a success here is usable by the MCP tools immediately.
 *
 * Kept separate from `npm run login` on purpose: the browser flow is the reliable
 * path and this one is the fast path, and they fail in different ways. The one
 * outcome that matters for the user is the slider-captcha demand, which is reported
 * by name rather than as a generic failure.
 */

const USAGE = `Usage: npm run login:http --silent -- [-u|--username <account>] [--channel phone|mail]

Logs in to icourse163.org over plain HTTP (no browser) by reproducing the URS
component's requests: SM4-encrypted parameters, a VDF proof of work, and an
RSA-encrypted password.

  -u, --username <account>   phone number or email (else ICOURSE163_USERNAME, else prompt)
      --password <password>  discouraged: visible in the process list; prefer the prompt
      --channel <kind>       phone (default) or mail

The password is read from a hidden prompt unless ICOURSE163_PASSWORD is set, and is
only ever sent RSA-encrypted inside an SM4 envelope.

If the site answers 401/dt=02 it is asking for a slider captcha; this command cannot
solve one, so it exits non-zero and tells you to use \`npm run login\` instead.
`;

export type UrsLoginCliIo = {
  stdout: Writable;
  stderr: Writable;
  promptUsername?: () => Promise<string>;
  promptPassword?: () => Promise<string>;
};

function readHiddenPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  stdout.write(prompt);
  if (typeof stdin.setRawMode !== "function") {
    const rl = createInterface({ input: stdin, output: stdout });
    return new Promise((resolve) => {
      rl.question("", (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
  const previousRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return new Promise((resolve, reject) => {
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
        reject(new Error("cancelled"));
        return;
      }
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          restore();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function ttyPrompter(): Pick<UrsLoginCliIo, "promptUsername" | "promptPassword"> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return {};
  }
  return {
    async promptUsername() {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await new Promise<string>((resolve) => {
          rl.question("账号（手机号或邮箱）: ", (answer) => resolve(answer));
        });
      } finally {
        rl.close();
      }
    },
    promptPassword: () => readHiddenPassword("密码（不显示）: "),
  };
}

export function parseUrsLoginArgs(argv: readonly string[]): {
  username: string;
  password: string;
  channel: UrsChannel;
  help: boolean;
} {
  let username = "";
  let password = "";
  let channel: UrsChannel = 1;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      i += 1;
      return argv[i] ?? "";
    };
    if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "-u" || arg === "--username") username = next();
    else if (arg.startsWith("--username=")) username = arg.slice(11);
    else if (arg === "-p" || arg === "--password") password = next();
    else if (arg.startsWith("--password=")) password = arg.slice(11);
    else if (arg === "--channel") {
      const value = next().toLowerCase();
      channel = value === "mail" || value === "email" || value === "0" ? 0 : 1;
    } else if (arg.startsWith("--channel=")) {
      const value = arg.slice(10).toLowerCase();
      channel = value === "mail" || value === "email" || value === "0" ? 0 : 1;
    }
  }
  return { username, password, channel, help };
}

export async function runUrsLoginCli(input: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  io: UrsLoginCliIo;
}): Promise<number> {
  const flags = parseUrsLoginArgs(input.argv);
  if (flags.help) {
    input.io.stdout.write(USAGE);
    return 0;
  }

  let username = flags.username || (input.env.ICOURSE163_USERNAME ?? "");
  let password = flags.password || (input.env.ICOURSE163_PASSWORD ?? "");
  try {
    if (username.trim().length === 0 && input.io.promptUsername != null) {
      username = (await input.io.promptUsername()).trim();
    }
    if (password.length === 0 && input.io.promptPassword != null) {
      password = await input.io.promptPassword();
    }
  } catch (error) {
    input.io.stderr.write(`${redactLoginSecrets(String(error), { username, password })}\n`);
    return 1;
  }
  if (username.trim().length === 0 || password.length === 0) {
    input.io.stderr.write(
      "需要账号和密码：用 -u 或 ICOURSE163_USERNAME 提供账号，密码走隐藏输入或 ICOURSE163_PASSWORD。\n",
    );
    return 1;
  }

  const credentials = { username, password };
  input.io.stdout.write(
    `正在用纯 HTTP 登录（${flags.channel === 1 ? "手机号通道" : "邮箱通道"}），不需要浏览器…\n`,
  );
  try {
    const result = await ursLogin({ account: username.trim(), password, channel: flags.channel });
    const safe = (text: string) => redactLoginSecrets(text, credentials);
    if (result.ok) {
      const store = createLocalCredentialStore({ env: input.env });
      await store.setCookie(result.cookie);
      input.io.stdout.write(`LOGIN_OK has_cookie=true\n`);
      input.io.stdout.write(`  获得的 cookie：${result.cookie.replace(/=([^;]{4})[^;]*/g, "=$1…")}\n`);
      if (!/NTESSTUDYSI=/.test(result.cookie)) {
        input.io.stdout.write(
          "  注意：这次响应里没有 NTESSTUDYSI，URS 通常还需要一步跳转才会把会话种到 icourse163.org；\n" +
            "  请用 `npm run login --silent -- --check` 确认会话是否真的可用。\n",
        );
      }
      return 0;
    }
    input.io.stderr.write(`${safe(result.message)}\n`);
    input.io.stderr.write(`  阶段=${result.stage} ret=${result.ret ?? "-"} dt=${result.dt ?? "-"}\n`);
    if (result.needsCaptcha) {
      input.io.stderr.write(
        "  该账号被要求滑动验证码。这是站点的自适应风控，不是请求构造错误；\n" +
          "  请改用浏览器登录：npm run login\n",
      );
    }
    return 1;
  } catch (error) {
    input.io.stderr.write(`${redactLoginSecrets(String(error), credentials)}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  const code = await runUrsLoginCli({
    argv: process.argv.slice(2),
    env: process.env,
    io: { stdout: process.stdout, stderr: process.stderr, ...ttyPrompter() },
  });
  process.exitCode = code;
}

const invokedDirectly =
  process.argv[1] != null && /urs-login-cli\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  void main();
}
