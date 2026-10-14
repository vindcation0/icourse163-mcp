import type { Browser, Cookie, Page } from "playwright-core";

import {
  describeChromeLaunchFailure,
  launchIcourseChrome,
  newIcourseBrowserContext,
} from "./chrome-launch";
import { parseCookiePairs } from "./cookie";
import { learnReferer } from "./course-rpc";
import type { UnitType } from "./list-term-units";


/** page.evaluate callbacks run in the browser; avoid requiring TypeScript DOM lib. */
type DomMedia = {
  muted: boolean;
  playbackRate: number;
  duration: number;
  currentTime: number;
  ended: boolean;
  play: () => Promise<void>;
  addEventListener: (type: string, listener: () => void, options?: { once?: boolean }) => void;
};


const MEDIA_WAIT_MS = 90_000;
const NAV_TIMEOUT_MS = 60_000;
const QUIZ_SELECTOR = ".u-questionItem";
const MEDIA_SELECTOR = "video, audio";
const PDF_READER_SELECTOR = ".ux-pdf-reader";
const PDF_NEXT_SELECTOR = ".ux-h5pdfreader_container_footer_pages_next";
const PDF_TOTAL_SELECTOR = ".ux-h5pdfreader_container_footer_pages_total";
const PDF_CURRENT_SELECTOR = ".ux-h5pdfreader_container_footer_pages_in";
const DEFAULT_STUDY_TIMEOUT_MS = 10 * 60_000;

export type StudyPlaywrightArgs = {
  cookie: string;
  course_id: string;
  term_id: string;
  school_short_name: string;
  unit_id: string;
  /** 课时 (lesson) id from the term catalog; drives the content-hash deeplink. */
  lesson_id?: string | null;
  /** Optional display name to click in the 课件 tree when deep-link fails. */
  unit_name?: string | null;
  content_id: string | null;
  unit_type: Extract<UnitType, "video" | "doc">;
  content_type: number | null;
  playback_rate: number;
  page_interval_sec: number;
  /**
   * When true (default), seek near the end of long media so automation can finish.
   * Set false to play through at playback_rate (may take wall-clock duration/rate).
   */
  seek_near_end?: boolean;
  headless?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Overall timeout for media/PPT completion (default 10 min). */
  timeout_ms?: number;
};

export type NavStrategy = "tree_click" | "deeplink_fallback" | "warm_learn";

/** School SPOC vs marketplace / non-school (e.g. kaopei). */
export type CourseKind = "school" | "non_school";

export type StudyPlaywrightOutcome =
  | {
      kind: "completed";
      learned_sec: number | null;
      duration_sec: number | null;
      page_count: number | null;
      percent: number;
      nav_strategy?: NavStrategy;
    }
  | {
      kind: "needs_quiz_assist";
      message: string;
      learned_sec: number | null;
      duration_sec: number | null;
      nav_strategy?: NavStrategy;
    }
  | {
      kind: "page_structure_change";
      message: string;
      nav_strategy?: NavStrategy | null;
    }
  | {
      kind: "error";
      message: string;
      nav_strategy?: NavStrategy | null;
    };

export type StudyPlaywrightRunner = {
  studyUnitInBrowser(args: StudyPlaywrightArgs): Promise<StudyPlaywrightOutcome>;
};

export function buildLearnUnitUrl(input: {
  course_id: string;
  term_id: string;
  school_short_name: string;
  unit_id: string;
  /** 课时 (lesson) id — the `id` segment of the content hash. Defaults to unit_id. */
  lesson_id?: string | null;
  /** Optional display name to click in the 课件 tree when deep-link fails. */
  unit_name?: string | null;
  content_id: string | null;
}): string {
  const base = learnReferer({
    course_id: input.course_id,
    term_id: input.term_id,
    school_short_name: input.school_short_name,
  });
  return `${base}${buildLearnContentHash(input.lesson_id ?? input.unit_id, input.unit_id)}`;
}

export function cookieHeaderToPlaywrightCookies(header: string): Cookie[] {
  const jar = parseCookiePairs(header);
  const cookies: Cookie[] = [];
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  for (const [name, value] of jar.entries()) {
    cookies.push({
      name,
      value,
      domain: ".icourse163.org",
      path: "/",
      expires,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    });
  }
  return cookies;
}

const MISSING_UNIT_SNIPPETS = [
  "该课时数据不存在",
  "该课时数据不存在",
  "课时数据不存在",
] as const;

const COURSEWARE_TREE_SELECTOR = [
  ".j-unitslist",
  ".unitslist",
  ".j-unitctBox",
  ".unit-name",
  "[class*=\"unitslist\"]",
  "[data-cid]",
  ".lsicon",
  ".f-icon.lsicon",
].join(", ");

const MEDIA_OR_PDF_SELECTOR = `${MEDIA_SELECTOR}, ${PDF_READER_SELECTOR}`;

const NON_SCHOOL_SHORT_NAMES = new Set(["", "kaopei"]);

export function classifyCourseKind(schoolShortName: string): CourseKind {
  return NON_SCHOOL_SHORT_NAMES.has(schoolShortName.trim().toLowerCase())
    ? "non_school"
    : "school";
}

/**
 * Learn-content hash fragment. `id` is the 课时 (lesson) id and `cid` is the
 * 课件 (unit) id — verified against the live site, where clicking a tree unit
 * produces e.g. `#/learn/content?type=detail&id=1265444045&cid=1305575068`.
 * Passing the unit id as `id` (or the video content id as `cid`) yields a hash
 * the SPA cannot resolve, so the player never mounts.
 */
export function buildLearnContentHash(lessonId: string, unitId: string): string {
  const id = lessonId.trim();
  const cid = unitId.trim();
  return `#/learn/content?type=detail&id=${encodeURIComponent(id)}&cid=${encodeURIComponent(cid)}`;
}

export function textIndicatesMissingUnit(sample: string): boolean {
  return MISSING_UNIT_SNIPPETS.some((snippet) => sample.includes(snippet));
}

/**
 * Pure navigation decision for unit tests.
 * Prefer tree_click; deeplink_fallback only when soft-hash produced media.
 */
export function chooseNavStrategy(input: {
  treeClickSucceeded: boolean;
  mediaVisible: boolean;
  missingUnitVisible: boolean;
  deeplinkMediaVisible: boolean;
}): NavStrategy | null {
  if (input.treeClickSucceeded && input.mediaVisible) {
    return "tree_click";
  }
  if (input.deeplinkMediaVisible) {
    return "deeplink_fallback";
  }
  if (input.treeClickSucceeded) {
    return "tree_click";
  }
  return null;
}

export function createPlaywrightStudyRunner(): StudyPlaywrightRunner {
  return {
    async studyUnitInBrowser(args) {
      if (process.env.ICOURSE163_DISALLOW_LIVE_PLAYWRIGHT === "1") {
        throw new Error(
          "createPlaywrightStudyRunner invoked while ICOURSE163_DISALLOW_LIVE_PLAYWRIGHT=1 (inject ports.studyPlaywright in tests)",
        );
      }
      return studyUnitWithPlaywright(args);
    },
  };
}

export async function studyUnitWithPlaywright(
  args: StudyPlaywrightArgs,
): Promise<StudyPlaywrightOutcome> {
  const env = args.env ?? process.env;
  const headless = args.headless ?? shouldStudyHeadless(env);
  const seekNearEnd = args.seek_near_end ?? true;
  const timeoutMs = args.timeout_ms ?? DEFAULT_STUDY_TIMEOUT_MS;

  let browser: Browser | undefined;
  try {
    browser = await launchIcourseChrome({ headless, env });
    const context = await newIcourseBrowserContext(browser);
    await context.addCookies(cookieHeaderToPlaywrightCookies(args.cookie));
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const learnBase = learnReferer({
      course_id: args.course_id,
      term_id: args.term_id,
      school_short_name: args.school_short_name,
    });

    // OCS-aligned: warm learn → hydrate 课件 tree → click unit → wait media.
    // Blind page.goto deep-link is fallback only (issue #30).
    const nav = await navigateToUnitPlayer(page, {
      learnBase,
      unitId: args.unit_id,
      lessonId: args.lesson_id ?? null,
      unitName: args.unit_name ?? null,
    });

    if (args.unit_type === "doc") {
      const outcome = await readPptInPage(
        page,
        args.page_interval_sec,
        args.content_type,
        timeoutMs,
      );
      return attachNavStrategy(outcome, nav.strategy);
    }
    {
      const outcome = await watchMediaInPage(
        page,
        args.playback_rate,
        seekNearEnd,
        timeoutMs,
      );
      return attachNavStrategy(outcome, nav.strategy);
    }
  } catch (error) {
    return {
      kind: "error",
      message: describeChromeLaunchFailure(error),
      nav_strategy: null,
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function dismissLearnDialogs(page: Page): Promise<void> {
  await dismissEvaluationModal(page);
  for (const name of [
    "暂不评价",
    "确定",
    "关闭",
    "我知道了",
    "知道了",
    "开始学习",
    "同意",
    "暂不",
  ]) {
    try {
      const button = page.getByRole("button", { name }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 1000 }).catch(() => undefined);
      }
    } catch {
      // ignore
    }
    try {
      const textNode = page.getByText(name, { exact: true }).first();
      if (await textNode.isVisible().catch(() => false)) {
        await textNode.click({ timeout: 1000 }).catch(() => undefined);
      }
    } catch {
      // ignore
    }
  }
  // Ant Design modal mask often blocks 课件 tree clicks on first entry.
  const modalClose = page.locator(".ant-modal-wrap .ant-modal-close, .ant-modal-wrap button.ant-modal-close").first();
  if (await modalClose.isVisible().catch(() => false)) {
    await modalClose.click({ timeout: 2000 }).catch(() => undefined);
  }
  const modalWrap = page.locator(".ant-modal-wrap").first();
  if (await modalWrap.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await modalWrap.waitFor({ state: "hidden", timeout: 3000 }).catch(() => undefined);
  }
}

/**
 * The course-evaluation popup (`.component-eva-modal`) is a full-viewport
 * overlay (z-index 999) that swallows every click, so no 课件 tree unit can be
 * clicked until it is gone. It is not an Ant Design modal, so the
 * `.ant-modal-wrap` handling above never sees it.
 */
async function dismissEvaluationModal(page: Page): Promise<void> {
  const modal = page.locator(".component-eva-modal").first();
  if (!(await modal.isVisible().catch(() => false))) {
    return;
  }
  for (const target of [
    page.getByText("暂不评价", { exact: false }).first(),
    page.locator(".component-eva-modal_close").first(),
  ]) {
    await target.click({ timeout: 2000 }).catch(() => undefined);
    if (!(await modal.isVisible().catch(() => false))) {
      return;
    }
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  await modal.waitFor({ state: "hidden", timeout: 3000 }).catch(() => undefined);
}

async function navigateToUnitPlayer(
  page: Page,
  input: {
    learnBase: string;
    unitId: string;
    /** 课时 id — the `id` segment of the content hash. */
    lessonId: string | null;
    unitName: string | null;
  },
): Promise<{ strategy: NavStrategy }> {
  // commit is enough for first byte; SPA shell needs an explicit UI wait (domcontentloaded
  // alone can hang or return an empty body under load).
  await page.goto(input.learnBase, {
    waitUntil: "commit",
    timeout: NAV_TIMEOUT_MS,
  });
  await page
    .getByText("课件", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: NAV_TIMEOUT_MS })
    .catch(() => undefined);
  await dismissLearnDialogs(page);
  await openCoursewareTab(page);
  await waitForCoursewareTree(page);
  await dismissLearnDialogs(page);

  const clicked = await clickUnitInTree(page, input.unitId, input.unitName);
  await dismissLearnDialogs(page);

  if (await waitForMediaOrPdf(page, 15_000)) {
    return { strategy: "tree_click" };
  }

  const bodyText = await page.evaluate(
    // new Function avoids tsx keepNames injecting __name into Playwright's serialized callback.
    new Function(
      "return (document.body && document.body.innerText) ? document.body.innerText : '';",
    ) as () => string,
  );
  const missing = textIndicatesMissingUnit(bodyText);

  // Soft in-SPA hash only after tree path failed — never cold page.goto deep-link.
  if (!clicked || missing || !(await mediaOrPdfAttached(page))) {
    await softHashDeeplink(page, input.lessonId ?? input.unitId, input.unitId);
    await dismissLearnDialogs(page);
    if (await waitForMediaOrPdf(page, 20_000)) {
      return { strategy: "deeplink_fallback" };
    }
    await clickUnitInTree(page, input.unitId, input.unitName);
    await dismissLearnDialogs(page);
    if (await waitForMediaOrPdf(page, 15_000)) {
      return { strategy: "deeplink_fallback" };
    }
  }

  return { strategy: clicked ? "tree_click" : "warm_learn" };
}

function attachNavStrategy(
  outcome: StudyPlaywrightOutcome,
  strategy: NavStrategy,
): StudyPlaywrightOutcome {
  return { ...outcome, nav_strategy: strategy };
}

async function openCoursewareTab(page: Page): Promise<void> {
  for (const locator of [
    // Current UI: the tab strip is an Ant Design menu whose items are
    // `<li class="ant-menu-item"><a>课件</a></li>`. The inner <a> has no href,
    // so it exposes no link role and getByRole("link"|"tab") finds nothing.
    page.locator('li.ant-menu-item:has-text("课件")').first(),
    page.locator('[role="menuitem"]:has-text("课件")').first(),
    page.getByRole("link", { name: "课件" }).first(),
    page.getByRole("tab", { name: "课件" }).first(),
    page.getByText("课件", { exact: true }).first(),
  ]) {
    try {
      if (await locator.isVisible().catch(() => false)) {
        await locator.click({ timeout: 3000 });
        await waitForCoursewareTree(page).catch(() => undefined);
        return;
      }
    } catch {
      // try next strategy
    }
  }
}

async function waitForCoursewareTree(page: Page): Promise<void> {
  await page
    .waitForSelector(COURSEWARE_TREE_SELECTOR, {
      state: "attached",
      timeout: 20_000,
    })
    .catch(() => undefined);
}

async function clickUnitInTree(
  page: Page,
  unitId: string,
  unitName: string | null,
): Promise<boolean> {
  await dismissLearnDialogs(page);

  const byAttr = page
    .locator(
      `[data-cid="${unitId}"], [data-id="${unitId}"], [data-unit-id="${unitId}"], a[href*="id=${unitId}"]`,
    )
    .first();
  if ((await byAttr.count().catch(() => 0)) > 0) {
    await byAttr
      .click({ timeout: 5000, force: true })
      .catch(() => undefined);
    await page
      .waitForLoadState("domcontentloaded", { timeout: 5000 })
      .catch(() => undefined);
    return true;
  }

  if (unitName != null && unitName.trim() !== "") {
    const trimmed = unitName.trim();
    // New 课件 UI often puts the title on [data-cid] / .lsicon rather than .unit-name.
    for (const loc of [
      page.locator(`[data-cid][title*="${trimmed}"]`).first(),
      page.locator(".j-unitslist .unit-name", { hasText: trimmed }).first(),
      page.locator(".unitslist .unit-name", { hasText: trimmed }).first(),
      page.locator(".unit-name", { hasText: trimmed }).first(),
      page.locator(".lsicon", { hasText: trimmed }).first(),
    ]) {
      try {
        if (
          (await loc.count()) > 0 &&
          (await loc.isVisible().catch(() => false))
        ) {
          await loc.click({ timeout: 5000, force: true });
          await page
            .waitForLoadState("domcontentloaded", { timeout: 5000 })
            .catch(() => undefined);
          return true;
        }
      } catch {
        // try next
      }
    }
    try {
      const byName = page.getByText(trimmed, { exact: false }).first();
      if (await byName.isVisible().catch(() => false)) {
        await byName.click({ timeout: 5000, force: true });
        await page
          .waitForLoadState("domcontentloaded", { timeout: 5000 })
          .catch(() => undefined);
        return true;
      }
    } catch {
      // not in tree
    }
  }
  return false;
}

async function softHashDeeplink(
  page: Page,
  lessonId: string,
  unitId: string,
): Promise<void> {
  const hash = buildLearnContentHash(lessonId, unitId);
  await page.evaluate(
    new Function("nextHash", "globalThis.location.hash = nextHash") as (
      nextHash: string,
    ) => void,
    hash,
  );
  await page
    .waitForLoadState("domcontentloaded", { timeout: 8000 })
    .catch(() => undefined);
}

async function mediaOrPdfAttached(page: Page): Promise<boolean> {
  return (await page.locator(MEDIA_OR_PDF_SELECTOR).count().catch(() => 0)) > 0;
}

async function waitForMediaOrPdf(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await page.waitForSelector(MEDIA_OR_PDF_SELECTOR, {
      state: "attached",
      timeout: timeoutMs,
    });
    return true;
  } catch {
    return false;
  }
}

export function shouldStudyHeadless(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32" || platform === "darwin") {
    return env.ICOURSE163_STUDY_HEADED !== "1";
  }
  const display = env.DISPLAY;
  if (display == null || display.trim() === "") {
    return true;
  }
  return env.ICOURSE163_STUDY_HEADED !== "1";
}

async function watchMediaInPage(
  page: Page,
  playbackRate: number,
  seekNearEnd: boolean,
  timeoutMs: number,
): Promise<StudyPlaywrightOutcome> {
  try {
    await page.waitForSelector(MEDIA_SELECTOR, {
      state: "attached",
      timeout: MEDIA_WAIT_MS,
    });
  } catch {
    return {
      kind: "page_structure_change",
      message:
        "Playwright study: video/audio element not found (page/API structure may have changed)",
    };
  }

  await page.evaluate(
    new Function(
      "rate",
      "var el = document.querySelector('video, audio'); if (!el) return; el.muted = true; el.playbackRate = rate; try { el.play(); } catch (e) {}",
    ) as (rate: number) => void,
    playbackRate,
  );

  if (seekNearEnd) {
    await seekMediaNearEnd(page);
  }

  const deadline = Date.now() + timeoutMs;
  let lastSeekAt = 0;
  while (Date.now() < deadline) {
    if (await isQuizVisible(page)) {
      const progress = await readMediaProgress(page);
      return {
        kind: "needs_quiz_assist",
        message:
          "Video popup quiz detected (.u-questionItem). Do not silent-submit; use get_homework → AI → save_homework_answers, then retry study_unit.",
        learned_sec: progress.current,
        duration_sec: progress.duration,
      };
    }

    const progress = await readMediaProgress(page);
    const nearEnd =
      progress.duration != null &&
      progress.current != null &&
      progress.duration > 0 &&
      progress.current >= Math.max(0, progress.duration - 2);
    if (progress.ended || nearEnd) {
      const duration = progress.duration ?? progress.current;
      return {
        kind: "completed",
        learned_sec: duration,
        duration_sec: duration,
        page_count: null,
        percent: 100,
      };
    }
    // Re-assert seek periodically — some players reset currentTime after UI init.
    if (seekNearEnd && Date.now() - lastSeekAt > 4000) {
      await seekMediaNearEnd(page);
      lastSeekAt = Date.now();
    }

    await sleepMs(500);
  }

  return {
    kind: "error",
    message: `Playwright study: media did not reach ended within ${timeoutMs}ms`,
  };
}

async function readPptInPage(
  page: Page,
  pageIntervalSec: number,
  contentType: number | null,
  timeoutMs: number,
): Promise<StudyPlaywrightOutcome> {
  // Rich text (contentType 4): OCS reloads once; treat as complete after load.
  if (contentType === 4) {
    await sleepMs(1500);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await sleepMs(1500);
    return {
      kind: "completed",
      learned_sec: null,
      duration_sec: null,
      page_count: 1,
      percent: 100,
    };
  }

  try {
    await page.waitForSelector(PDF_READER_SELECTOR, {
      state: "attached",
      timeout: MEDIA_WAIT_MS,
    });
  } catch {
    return {
      kind: "page_structure_change",
      message:
        "Playwright study: PDF reader (.ux-pdf-reader) not found (page/API structure may have changed)",
    };
  }

  const pages = await page.evaluate(
    ({ totalSel, currentSel }) => {
      const doc = (globalThis as unknown as {
        document: {
          querySelector: (s: string) => {
            childNodes?: { textContent?: string | null }[];
            textContent?: string | null;
            value?: string;
          } | null;
        };
      }).document;
      const totalNode = doc.querySelector(totalSel);
      const totalText =
        totalNode?.childNodes?.[1]?.textContent?.replace(/\s/g, "") ??
        totalNode?.textContent?.replace(/\D/g, "") ??
        "0";
      const total = Number.parseInt(totalText, 10);
      const currentEl = doc.querySelector(currentSel);
      const start = Number.parseInt(currentEl?.value ?? "1", 10);
      return {
        total: Number.isFinite(total) ? total : 0,
        start: Number.isFinite(start) && start > 0 ? start : 1,
      };
    },
    { totalSel: PDF_TOTAL_SELECTOR, currentSel: PDF_CURRENT_SELECTOR },
  );

  if (pages.total <= 0) {
    return {
      kind: "page_structure_change",
      message: "Playwright study: could not read PPT total page count",
    };
  }

  const deadline = Date.now() + timeoutMs;
  for (let index = pages.start; index <= pages.total; index++) {
    if (Date.now() > deadline) {
      return {
        kind: "error",
        message: `Playwright study: PPT page turns exceeded ${timeoutMs}ms`,
      };
    }
    if (index < pages.total) {
      const next = page.locator(PDF_NEXT_SELECTOR).first();
      if ((await next.count()) === 0) {
        return {
          kind: "page_structure_change",
          message: "Playwright study: PPT next-page control not found",
        };
      }
      await next.click();
    }
    if (pageIntervalSec > 0) {
      await sleepMs(pageIntervalSec * 1000);
    }
  }

  return {
    kind: "completed",
    learned_sec: null,
    duration_sec: null,
    page_count: pages.total,
    percent: 100,
  };
}

async function isQuizVisible(page: Page): Promise<boolean> {
  try {
    const loc = page.locator(QUIZ_SELECTOR).first();
    if ((await loc.count()) === 0) {
      return false;
    }
    return loc.isVisible();
  } catch {
    return false;
  }
}


async function seekMediaNearEnd(page: Page): Promise<void> {
  await page.evaluate(
    new Function(
      "var el = document.querySelector('video, audio');" +
        "if (!el) {" +
        "  var iframes = document.querySelectorAll('iframe');" +
        "  for (var i = 0; i < iframes.length; i++) {" +
        "    try {" +
        "      el = iframes[i].contentDocument && iframes[i].contentDocument.querySelector('video, audio');" +
        "    } catch (e) {}" +
        "    if (el) break;" +
        "  }" +
        "}" +
        "if (!el) return;" +
        "el.muted = true;" +
        "try { el.play(); } catch (e) {}" +
        "var jump = function () {" +
        "  if (Number.isFinite(el.duration) && el.duration > 1) {" +
        "    el.currentTime = Math.max(0, el.duration - 1.5);" +
        "    try { el.play(); } catch (e2) {}" +
        "  }" +
        "};" +
        "if (Number.isFinite(el.duration) && el.duration > 0) { jump(); }" +
        "else { el.addEventListener('loadedmetadata', jump, { once: true }); }",
    ) as () => void,
  );
}

async function readMediaProgress(page: Page): Promise<{
  ended: boolean;
  current: number | null;
  duration: number | null;
}> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { querySelector: (s: string) => DomMedia | null } }).document;
    const el = doc.querySelector("video, audio");
    if (el == null) {
      return { ended: false, current: null, duration: null };
    }
    const duration =
      Number.isFinite(el.duration) && el.duration > 0 ? Math.floor(el.duration) : null;
    const current =
      Number.isFinite(el.currentTime) && el.currentTime >= 0
        ? Math.floor(el.currentTime)
        : null;
    return { ended: el.ended === true, current, duration };
  });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

