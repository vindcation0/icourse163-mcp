import { homedir } from "node:os";
import { join } from "node:path";

import {
  chromium,
  type BrowserContext,
  type Cookie,
  type FrameLocator,
  type Locator,
  type Page,
} from "playwright-core";

import { cookieHasNtesstudysi, cookieHasStudyInfo } from "./cookie";
import { createFileCredentialStore, type WritableCredentialStore } from "./credentials";

export type PasswordCredentials = {
  username: string;
  password: string;
};

export type PasswordLoginRunner = {
  loginWithPassword(credentials: PasswordCredentials): Promise<void>;
};

const HOMEPAGE = "https://www.icourse163.org/";
const LOGIN_IFRAME = "iframe[src*='reg.icourse163.org'][src*='index_dl2']";
const PASSWORD_LOGIN_TIMEOUT_MS = 60_000;
const LOGIN_UI_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;

export const PASSWORD_MODE_SWITCH_LABEL = /密码登录|账号登录|邮箱登录/;

/**
 * Whether the password prompt should echo what is typed.
 *
 * Visible is the default here, chosen deliberately: hidden input is hard to get right
 * with special characters or an IME, and this is a local tool on the user's own machine.
 * The tradeoff is real though — visible input stays in the terminal scrollback and in
 * anything recording or screenshotting the screen — so hiding stays one flag away:
 * `--hide-password` or ICOURSE163_HIDE_PASSWORD=1.
 *
 * ICOURSE163_SHOW_PASSWORD=1 still forces visible, so a wrapper that sets HIDE globally
 * can be overridden per run.
 */
export function showPasswordEnabled(
  hideFlag: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.ICOURSE163_SHOW_PASSWORD === "1") {
    return true;
  }
  if (hideFlag || env.ICOURSE163_HIDE_PASSWORD === "1") {
    return false;
  }
  return true;
}

/** The prompt states which mode is active, so the two are distinguishable on screen. */
export function passwordPromptLabel(visible: boolean, english = false): string {
  if (english) {
    return visible ? "Password (visible): " : "Password (hidden): ";
  }
  return visible ? "密码（可见）: " : "密码（不显示）: ";
}

/** True for a bare password-form submit label (登录 / 登 录); false for mode-switch / mailModule headings. */
export function isPasswordSubmitLabel(text: string): boolean {
  return text.replace(/\s+/g, "") === "登录";
}

const MISSING_CHROME_MESSAGE =
  "Chrome/Chromium is not installed or the chrome channel is missing. Password login needs Google Chrome or Playwright Chromium (see docs/login.md).";

const NO_DISPLAY_MESSAGE =
  "Cannot open icourse163 login UI (no display / headless). Password login will try headless Chrome; install Chrome/Chromium, or paste a cookie with --cookie-file / ICOURSE163_COOKIE.";

export function cannotOpenLoginUiMessage(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "win32" || platform === "darwin") {
    return null;
  }
  const display = env.DISPLAY;
  if (display == null || display.trim() === "") {
    return NO_DISPLAY_MESSAGE;
  }
  return null;
}

export function passwordLoginHeadless(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.ICOURSE163_LOGIN_HEADLESS === "1") {
    return true;
  }
  return cannotOpenLoginUiMessage(env, platform) != null;
}

export function describeLoginFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.trim();
  if (
    /chromium distribution ['"]?chrome['"]? is not found/i.test(text) ||
    /executable doesn't exist/i.test(text) ||
    /browserType\.launch.*chrome/i.test(text)
  ) {
    return MISSING_CHROME_MESSAGE;
  }
  if (
    /missing x server/i.test(text) ||
    /headed browser without having a xserver/i.test(text) ||
    /no display/i.test(text) ||
    /\$DISPLAY/i.test(text)
  ) {
    return NO_DISPLAY_MESSAGE;
  }
  return text.length > 0 ? text : "认证失效";
}

export function redactLoginSecrets(
  message: string,
  credentials: PasswordCredentials,
  extra: readonly string[] = [],
): string {
  let result = message;
  for (const secret of [credentials.password, credentials.username, ...extra]) {
    if (secret.length === 0) {
      continue;
    }
    result = result.split(secret).join("[已隐藏]");
  }
  return result;
}

export function createPlaywrightPasswordLogin(
  credentials: WritableCredentialStore,
  options: {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  },
): PasswordLoginRunner {
  return {
    async loginWithPassword(passwordCreds) {
      const headless = passwordLoginHeadless(options.env, options.platform);
      let context: BrowserContext | undefined;
      try {
        context = await launchBrowserContext(options.env, headless);
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(HOMEPAGE, {
          waitUntil: "domcontentloaded",
          timeout: PASSWORD_LOGIN_TIMEOUT_MS,
        });
        await fillHomepageLogin(page, passwordCreds);
        const cookie = await waitForSessionCookie(context, PASSWORD_LOGIN_TIMEOUT_MS);
        await credentials.setCookie(cookie);
      } finally {
        await context?.close();
      }
    },
  };
}

async function launchBrowserContext(
  env: NodeJS.ProcessEnv,
  headless: boolean,
): Promise<BrowserContext> {
  const profile = join(homedir(), ".icourse163-mcp", "chrome-profile");
  const common = {
    headless,
    viewport: { width: 1280, height: 860 },
  };
  const chromePath = env.ICOURSE163_CHROME?.trim();
  if (chromePath != null && chromePath.length > 0) {
    return chromium.launchPersistentContext(profile, {
      ...common,
      executablePath: chromePath,
    });
  }
  try {
    return await chromium.launchPersistentContext(profile, {
      ...common,
      channel: "chrome",
    });
  } catch (error) {
    if (!looksLikeMissingChrome(error)) {
      throw error;
    }
    return chromium.launchPersistentContext(profile, common);
  }
}

function looksLikeMissingChrome(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (
    /chromium distribution ['"]?chrome['"]? is not found/i.test(text) ||
    /executable doesn't exist/i.test(text)
  );
}

async function fillHomepageLogin(page: Page, credentials: PasswordCredentials): Promise<void> {
  try {
    await page.keyboard.press("Escape");
  } catch {
    // Popups are optional.
  }

  const iframe = page.locator(LOGIN_IFRAME);
  if ((await iframe.count()) === 0) {
    await clickLoginTrigger(page);
    await page.waitForSelector(LOGIN_IFRAME, { timeout: LOGIN_UI_TIMEOUT_MS });
  }

  const frame = page.frameLocator(LOGIN_IFRAME).first();
  await ensurePasswordMode(frame);

  const userField = frame
    .locator("input[type='text'], input[type='tel']")
    .filter({ visible: true })
    .first();
  await userField.waitFor({ state: "visible", timeout: LOGIN_UI_TIMEOUT_MS });
  await userField.fill(credentials.username);

  const passwordField = frame.locator("input[type='password']").filter({ visible: true }).first();
  await passwordField.waitFor({ state: "visible", timeout: LOGIN_UI_TIMEOUT_MS });
  await passwordField.fill(credentials.password);

  await clickPasswordSubmit(frame, passwordField);
}

async function clickPasswordSubmit(
  frame: FrameLocator,
  passwordField: Locator,
): Promise<void> {
  const primary = frame
    .locator("a.u-loginbtn, button[type='submit'], input[type='submit'], #dologin")
    .filter({ visible: true })
    .first();
  if ((await primary.count()) > 0) {
    await primary.click();
    return;
  }

  const roleSubmit = frame
    .getByRole("button", { name: /^\s*登\s*录\s*$/ })
    .filter({ visible: true })
    .first();
  if ((await roleSubmit.count()) > 0) {
    await roleSubmit.click();
    return;
  }

  const candidates = frame.getByText(/登\s*录/, { exact: false });
  const total = await candidates.count();
  for (let i = 0; i < total; i++) {
    const candidate = candidates.nth(i);
    if (!(await candidate.isVisible())) {
      continue;
    }
    let label = "";
    try {
      label = (await candidate.innerText()).trim();
    } catch {
      continue;
    }
    if (!isPasswordSubmitLabel(label)) {
      continue;
    }
    await candidate.click();
    return;
  }

  await passwordField.press("Enter");
}

async function clickLoginTrigger(page: Page): Promise<void> {
  const candidates = [
    page.getByRole("link", { name: /登录/ }),
    page.getByRole("button", { name: /登录/ }),
    page.getByText("登录", { exact: false }),
  ];
  for (const locator of candidates) {
    const first = locator.first();
    try {
      await first.waitFor({ state: "visible", timeout: LOGIN_UI_TIMEOUT_MS });
      await first.click();
      return;
    } catch {
      // Homepage 登录 may be a link, button, or text; SPA hydrates one of them.
    }
  }
  throw new Error("password login: login control not found on homepage");
}

async function ensurePasswordMode(frame: FrameLocator): Promise<void> {
  const visiblePassword = frame.locator("input[type='password']").filter({ visible: true }).first();
  if (await visiblePassword.isVisible().catch(() => false)) {
    return;
  }
  // The live UI labels its SMS tab 短信快捷登录, i.e. the opposite direction from the
  // password labels below, so there is nothing here to switch *to*. Try anyway in
  // case a password tab exists, then report precisely rather than letting the
  // caller wait out the 60s session timeout for a login that cannot happen.
  const modeSwitch = frame.getByText(PASSWORD_MODE_SWITCH_LABEL).filter({ visible: true }).first();
  await modeSwitch.click({ timeout: LOGIN_UI_TIMEOUT_MS }).catch(() => undefined);
  if (await visiblePassword.isVisible().catch(() => false)) {
    return;
  }
  const labels = await frame
    .locator("a.tab1, .tab1, [class*='tab']")
    .allInnerTexts()
    .catch(() => [] as string[]);
  const seen = labels
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0)
    .slice(0, 5);
  throw new Error(
    `password login: the login frame has no visible password field and no switchable password tab` +
      `${seen.length > 0 ? ` (visible tabs: ${seen.join(" / ")})` : ""}. ` +
      "The site is most likely in SMS or QR mode; use --cookie-file / ICOURSE163_COOKIE instead.",
  );
}

async function waitForSessionCookie(
  context: BrowserContext,
  timeoutMs: number,
): Promise<string> {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    const header = cookieHeaderFrom(await context.cookies());
    if (header != null) {
      return header;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    "login wait timeout: no authenticated session appeared. The site writes a " +
      "placeholder NTESSTUDYSI for anonymous visitors, so a real login must also " +
      "produce STUDY_INFO. Check the account and password; if the site asks for SMS " +
      "or QR verification, use --cookie-file / ICOURSE163_COOKIE instead.",
  );
}

export function cookieHeaderFrom(cookies: Cookie[]): string | null {
  const hostCookies = cookies.filter((cookie) =>
    /(^|\.)icourse163\.org$/i.test(cookie.domain),
  );
  if (hostCookies.length === 0) {
    return null;
  }
  const header = hostCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  // NTESSTUDYSI alone is NOT proof of a login. The site's own JS writes a
  // hard-coded fallback value for anonymous visitors:
  //
  //   if (!r.NTESSTUDYSI) document.cookie = "NTESSTUDYSI=" + y + ";path=/"
  //   // y = "fa2c35db81bb400a97f5ed9465e22b9d"
  //
  // so accepting it made a bogus account report LOGIN_OK and overwrite a valid
  // stored session. STUDY_INFO is only set by a real URS login.
  return cookieHasNtesstudysi(header) && cookieHasStudyInfo(header) ? header : null;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export type InteractiveLoginResult = {
  ok: boolean;
  /** 提取到的完整 cookie header；失败为 null。**不要打印它。** */
  cookie: string | null;
  /** 完整 header 同时写到了这个文件，讨论区工具从那里读。 */
  browserSessionPath: string;
  /** 给调用方看的说明（不含任何 cookie 内容）。 */
  message: string;
};

/** 交互式登录的默认等待上限。要够用户在浏览器里输完手机号 + 密码 + 可能的验证。 */
export const INTERACTIVE_LOGIN_DEFAULT_TIMEOUT_MS = 180_000;

/**
 * 交互式登录：**弹出一个有头浏览器，让用户自己登录**，然后提取 cookie。
 *
 * 为什么不收密码参数：MCP 工具的参数必须先由模型产出，密码一旦作为参数传入就会进入
 * 模型上下文与会话记录。这个函数反过来把输入交给浏览器，密码只存在于浏览器进程里。
 *
 * 顺带解决两件事：
 *  1. 讨论区需要的完整 cookie 也一起写进 `browser-session`，用户不用再手抄；
 *  2. 用同一个持久化 profile，所以已登录时会立刻返回（不会真的弹窗等人）。
 */
export async function interactiveBrowserLogin(options: {
  credentials: WritableCredentialStore;
  /** 浏览器会话文件；讨论区工具从这里读。 */
  browserSessionPath: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  timeoutMs?: number;
}): Promise<InteractiveLoginResult> {
  const timeoutMs = options.timeoutMs ?? INTERACTIVE_LOGIN_DEFAULT_TIMEOUT_MS;
  let context: BrowserContext | undefined;
  try {
    // 强制有头：用户必须在可见窗口里输入，否则这功能没有意义。
    context = await launchBrowserContext(options.env, false);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(HOMEPAGE, { waitUntil: "domcontentloaded", timeout: PASSWORD_LOGIN_TIMEOUT_MS });

    const cookie = await waitForSessionCookie(context, timeoutMs);
    // ① URS 会话（刷课/读题/交卷用），交给原有存储，可能是裁剪后的
    await options.credentials.setCookie(cookie);
    // ② 完整 header 单独存一份，给新版 API（讨论区）用
    const browserStore = createFileCredentialStore({ path: options.browserSessionPath, env: options.env });
    await browserStore.setCookie(cookie);

    return {
      ok: true,
      cookie,
      browserSessionPath: options.browserSessionPath,
      message:
        "登录成功，会话已保存（URS 会话 + 浏览器会话）。password 从未经过本工具的参数。",
    };
  } catch (error) {
    return {
      ok: false,
      cookie: null,
      browserSessionPath: options.browserSessionPath,
      message: describeLoginFailure(error),
    };
  } finally {
    await context?.close().catch(() => undefined);
  }
}
