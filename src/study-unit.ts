import { missingSessionFailure } from "./auth";
import {
  fetchMocTermDto,
  learnReferer,
  resolveSession,
  type ToolError,
} from "./course-rpc";
import {
  asArray,
  asFiniteNumber,
  asId,
  asNonEmptyString,
  asRecord,
  parseJsonObject,
} from "./json-util";
import { mapContentType, type UnitType } from "./list-term-units";
import type { Icourse163Http, Icourse163Ports } from "./ports";
import {
  classifyCourseKind,
  createPlaywrightStudyRunner,
  type CourseKind,
  type NavStrategy,
  type StudyPlaywrightOutcome,
} from "./study-playwright";

export const SAVE_LEARN_RPC_PATH = "/web/j/courseBean.saveMocContentLearn.rpc";
export const SAVE_LEARN_RPC_URL = `https://www.icourse163.org${SAVE_LEARN_RPC_PATH}`;

export const LEARN_VO_RPC_PATH = "/web/j/courseBean.getLessonUnitLearnVo.rpc";
export const LEARN_VO_RPC_URL = `https://www.icourse163.org${LEARN_VO_RPC_PATH}`;

const ORIGIN = "https://www.icourse163.org";
const DEFAULT_PLAYBACK_RATE = 1;
const MIN_PLAYBACK_RATE = 0.5;
const MAX_PLAYBACK_RATE = 2;
const DEFAULT_PAGE_INTERVAL_SEC = 1;
const MIN_PAGE_INTERVAL_SEC = 0;
const MAX_PAGE_INTERVAL_SEC = 10;

export type StudyUnitStatus =
  | "ok"
  | "auth_expired"
  | "non_media_unit"
  | "page_structure_change"
  | "needs_quiz_assist"
  | "error";

/** rpc = saveMocContentLearn only; playwright = browser path; auto = RPC then Playwright on -10006-like blocks. */
export type StudyTransport = "auto" | "rpc" | "playwright";

export type StudyUnitArgs = {
  course_id: string;
  term_id: string;
  unit_id: string;
  school_short_name?: string;
  playback_rate?: number;
  /** Seconds between simulated PPT page turns (OCS readSpeed). Default 1; 0 skips delay. */
  page_interval_sec?: number;
  /** Default auto: try RPC, fall back to Playwright on -10006 / 并发限制 / 本地时间 blocks. */
  transport?: StudyTransport;
};

export type StudyUnitResult = {
  isError: boolean;
  status: StudyUnitStatus;
  course_id: string;
  term_id: string;
  unit_id: string;
  unit_type: UnitType | null;
  completed: boolean;
  learned_sec: number | null;
  duration_sec: number | null;
  percent: number | null;
  playback_rate: number;
  page_count: number | null;
  page_interval_sec: number | null;
  transport: "rpc" | "playwright" | null;
  /** Present on Playwright path: tree_click | deeplink_fallback | warm_learn. */
  nav_strategy: NavStrategy | null;
  /** school SPOC vs non_school (e.g. kaopei) track. */
  course_kind: CourseKind | null;
  errors: ToolError[];
};

export type LocatedUnit = {
  unit_id: string;
  name: string;
  content_type: number | null;
  unit_type: UnitType;
  content_id: string | null;
  duration_sec: number | null;
  lesson_id: string | null;
};

export type VideoLearnDto = {
  unitId: number;
  contentType: number;
  finished: boolean;
  videoDto: {
    videoId: number;
    duration: number;
    currentTime: number;
    learnedTime: number;
  };
};

export type DocLearnDto = {
  unitId: number;
  contentType: number;
  finished: boolean;
  pageNum: number;
};

export function clampPlaybackRate(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return DEFAULT_PLAYBACK_RATE;
  }
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, value));
}

export function clampPageIntervalSec(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return DEFAULT_PAGE_INTERVAL_SEC;
  }
  return Math.min(
    MAX_PAGE_INTERVAL_SEC,
    Math.max(MIN_PAGE_INTERVAL_SEC, value),
  );
}

/** True for saveMocContentLearn failures that OCS bypasses via DOM playback (-10006 / clock / concurrency). */
export function isLearnProgressBlockedMessage(message: string): boolean {
  return (
    /-10006\b/.test(message) ||
    /本地时间/.test(message) ||
    /并发限制/.test(message)
  );
}

export function normalizeStudyTransport(
  value: StudyTransport | undefined,
): StudyTransport {
  if (value === "rpc" || value === "playwright" || value === "auto") {
    return value;
  }
  return "auto";
}

export function findUnitInMocTerm(
  moc: Record<string, unknown>,
  unitId: string,
): LocatedUnit | null {
  const want = unitId.trim();
  if (want.length === 0) {
    return null;
  }
  for (const chapterRaw of asArray(moc.chapters)) {
    const chapter = asRecord(chapterRaw);
    if (chapter == null) {
      continue;
    }
    for (const lessonRaw of asArray(chapter.lessons)) {
      const lesson = asRecord(lessonRaw);
      if (lesson == null) {
        continue;
      }
      const lessonId = asId(lesson.id);
      for (const unitRaw of asArray(lesson.units)) {
        const unit = asRecord(unitRaw);
        if (unit == null) {
          continue;
        }
        const id = asId(unit.id);
        if (id == null || id !== want) {
          continue;
        }
        const contentType = asFiniteNumber(unit.contentType);
        return {
          unit_id: id,
          name: asNonEmptyString(unit.name) ?? "未命名单元",
          content_type: contentType,
          unit_type: mapContentType(contentType),
          content_id:
            asId(unit.contentId) ?? asId(unit.videoId) ?? asId(unit.resourceId),
          duration_sec: firstPositiveDuration(unit),
          lesson_id: lessonId,
        };
      }
    }
  }
  return null;
}

export function buildVideoLearnDto(input: {
  unit_id: string;
  content_id: string;
  duration_sec: number;
}): VideoLearnDto {
  const duration = Math.max(0, Math.floor(input.duration_sec));
  return {
    unitId: Number(input.unit_id),
    contentType: 1,
    finished: true,
    videoDto: {
      videoId: Number(input.content_id),
      duration,
      currentTime: duration,
      learnedTime: duration,
    },
  };
}

export function buildDocLearnDto(input: {
  unit_id: string;
  content_type: number;
  page_count: number;
}): DocLearnDto {
  const pageNum = Math.max(1, Math.floor(input.page_count));
  return {
    unitId: Number(input.unit_id),
    contentType: input.content_type,
    finished: true,
    pageNum,
  };
}

export async function studyUnit(
  args: StudyUnitArgs,
  ports?: Icourse163Ports,
): Promise<StudyUnitResult> {
  const courseId = args.course_id.trim();
  const termId = args.term_id.trim();
  const unitId = args.unit_id.trim();
  const playbackRate = clampPlaybackRate(args.playback_rate);
  const base = emptyResult(courseId, termId, unitId, playbackRate);

  if (courseId.length === 0 || termId.length === 0 || unitId.length === 0) {
    return {
      ...base,
      isError: true,
      status: "error",
      errors: [
        {
          where: "args",
          message: "course_id, term_id, and unit_id are required",
        },
      ],
    };
  }

  if (ports == null) {
    return {
      ...base,
      isError: true,
      status: "auth_expired",
      errors: [
        { where: "credentials", message: missingSessionFailure().message },
      ],
    };
  }

  const session = await resolveSession(ports);
  if (!session.ok) {
    return {
      ...base,
      isError: true,
      status: session.status,
      errors: session.errors,
    };
  }

  const course = {
    course_id: courseId,
    term_id: termId,
    school_short_name: (args.school_short_name ?? "").trim(),
  };

  const diagnostics: string[] = [];
  let moc: Record<string, unknown> | null;
  try {
    moc = await fetchMocTermDto({
      http: ports.http,
      cookie: session.cookie,
      csrfKey: session.csrfKey,
      course,
      diagnostics,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      isError: true,
      status: "error",
      errors: [{ where: "term", message: `Term structure RPC failed: ${detail}` }],
    };
  }

  if (moc == null) {
    const detail = diagnostics.length > 0 ? `: ${diagnostics.join("; ")}` : "";
    return {
      ...base,
      isError: true,
      status: "page_structure_change",
      errors: [
        {
          where: "term",
          message:
            `Term structure RPC returned no mocTermDto${detail} (page/API structure may have changed)`,
        },
      ],
    };
  }

  const located = findUnitInMocTerm(moc, unitId);
  if (located == null) {
    return {
      ...base,
      isError: true,
      status: "page_structure_change",
      errors: [
        {
          where: "unit",
          message: `Unit ${unitId} not found in term catalog (wrong id or page/API structure change)`,
        },
      ],
    };
  }

  const transport = normalizeStudyTransport(args.transport);
  const pageIntervalSec = clampPageIntervalSec(args.page_interval_sec);

  if (located.unit_type === "doc") {
    return studyDocUnit({
      base,
      courseId,
      termId,
      unitId,
      located,
      course,
      session,
      ports,
      playbackRate,
      pageIntervalSec,
      transport,
    });
  }

  if (located.unit_type !== "video") {
    return {
      ...base,
      isError: true,
      status: "non_media_unit",
      unit_type: located.unit_type,
      errors: [
        {
          where: "unit",
          message: `Unit ${unitId} is type ${located.unit_type}, not video/audio/doc media`,
        },
      ],
    };
  }

  return studyVideoUnit({
    base,
    courseId,
    termId,
    unitId,
    located,
    course,
    session,
    ports,
    playbackRate,
    pageIntervalSec,
    transport,
  });
}

function emptyResult(
  courseId: string,
  termId: string,
  unitId: string,
  playbackRate: number,
): Omit<StudyUnitResult, "isError" | "status" | "errors"> {
  return {
    course_id: courseId,
    term_id: termId,
    unit_id: unitId,
    unit_type: null,
    completed: false,
    learned_sec: null,
    duration_sec: null,
    percent: null,
    playback_rate: playbackRate,
    page_count: null,
    page_interval_sec: null,
    transport: null,
    nav_strategy: null,
    course_kind: null,
  };
}

function firstPositiveDuration(unit: Record<string, unknown>): number | null {
  // Catalog units often expose durationInSeconds (seconds, not ms). Prefer it so
  // long videos (>10000s) are not mis-scaled by the ms heuristic below.
  const secondsField = asFiniteNumber(unit.durationInSeconds);
  if (secondsField != null && secondsField > 0) {
    return Math.floor(secondsField);
  }
  const raw = firstNumber(
    unit.duration,
    unit.videoTime,
    unit.videoSeconds,
    unit.length,
    unit.timeLength,
  );
  if (raw == null || raw <= 0) {
    return null;
  }
  if (raw > 10_000) {
    return Math.floor(raw / 1000);
  }
  return Math.floor(raw);
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = asFiniteNumber(value);
    if (parsed != null) {
      return parsed;
    }
  }
  return null;
}

async function fetchLessonUnitLearnVo(input: {
  http: Icourse163Http;
  cookie: string;
  csrfKey: string;
  contentId: string;
  unitId: string;
  contentType: number;
  referer: string;
}): Promise<{
  durationSec: number | null;
  videoId: string | null;
  textPages: number | null;
} | null> {
  try {
    const response = await input.http.request({
      url: `${LEARN_VO_RPC_URL}?csrfKey=${encodeURIComponent(input.csrfKey)}`,
      cookie: input.cookie,
      method: "POST",
      form: {
        contentId: input.contentId,
        unitId: input.unitId,
        contentType: String(input.contentType),
      },
      headers: {
        origin: ORIGIN,
        referer: input.referer,
      },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return null;
    }
    const json = parseJsonObject(response.body);
    if (json == null || json.code !== 0) {
      return null;
    }
    const result = asRecord(json.result) ?? json;
    const textPages = firstPositivePageCount(result);
    return {
      durationSec: firstPositiveDuration(result),
      videoId: asId(result.videoId) ?? asId(result.contentId) ?? asId(result.id),
      textPages,
    };
  } catch {
    return null;
  }
}

function firstPositivePageCount(record: Record<string, unknown>): number | null {
  const raw = firstNumber(record.textPages, record.pageCount, record.pages);
  if (raw == null || raw <= 0) {
    return null;
  }
  return Math.floor(raw);
}


type SaveLearnOutcome =
  | { kind: "saved" }
  | { kind: "auth_expired"; message: string }
  | { kind: "page_structure_change"; message: string }
  | { kind: "error"; message: string; where: string };

async function saveLearnDto(input: {
  http: Icourse163Http;
  cookie: string;
  csrfKey: string;
  referer: string;
  dto: unknown;
}): Promise<SaveLearnOutcome> {
  let saveBody: string;
  try {
    const response = await input.http.request({
      url: `${SAVE_LEARN_RPC_URL}?csrfKey=${encodeURIComponent(input.csrfKey)}`,
      cookie: input.cookie,
      method: "POST",
      form: { dto: JSON.stringify(input.dto) },
      headers: {
        origin: ORIGIN,
        referer: input.referer,
      },
    });
    if (response.statusCode === 401 || response.statusCode === 403) {
      return {
        kind: "auth_expired",
        message:
          "icourse163 session is missing or expired (auth_expired). Run `npm run login` again.",
      };
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        kind: "error",
        where: "save_learn",
        message: `saveMocContentLearn HTTP ${response.statusCode}`,
      };
    }
    saveBody = response.body;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "error", where: "save_learn", message: detail };
  }

  const saveJson = parseJsonObject(saveBody);
  if (saveJson == null) {
    return {
      kind: "page_structure_change",
      message:
        "saveMocContentLearn returned non-JSON (page/API structure may have changed)",
    };
  }
  if (saveJson.code !== 0) {
    const apiMessage = asNonEmptyString(saveJson.message) ?? "";
    const detail =
      apiMessage.includes("10006") || String(saveJson.code) === "-10006"
        ? `${apiMessage} (API anti-abuse; box clock matching Beijing does not clear this — see docs/mcp.md)`
        : apiMessage;
    return {
      kind: "error",
      where: "save_learn",
      message: `saveMocContentLearn code=${String(saveJson.code)} ${detail}`.trim(),
    };
  }
  return { kind: "saved" };
}

async function studyVideoUnit(input: {
  base: Omit<StudyUnitResult, "isError" | "status" | "errors">;
  courseId: string;
  termId: string;
  unitId: string;
  located: LocatedUnit;
  course: { course_id: string; term_id: string; school_short_name: string };
  session: { cookie: string; csrfKey: string };
  ports: Icourse163Ports;
  playbackRate: number;
  pageIntervalSec: number;
  transport: StudyTransport;
}): Promise<StudyUnitResult> {
  const {
    base,
    courseId,
    termId,
    unitId,
    located,
    course,
    session,
    ports,
    playbackRate,
    pageIntervalSec,
    transport,
  } = input;

  const referer = learnReferer(course);
  let durationSec = located.duration_sec;
  let contentId = located.content_id;

  const learnVo = await fetchLessonUnitLearnVo({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    contentId: contentId ?? unitId,
    unitId,
    contentType: 1,
    referer,
  });
  if (learnVo != null) {
    if (learnVo.durationSec != null) {
      durationSec = learnVo.durationSec;
    }
    if (learnVo.videoId != null) {
      contentId = learnVo.videoId;
    }
  }

  if (transport === "playwright") {
    return runPlaywrightStudy({
      base,
      courseId,
      termId,
      unitId,
      located: { ...located, content_id: contentId, duration_sec: durationSec },
      course,
      session,
      ports,
      playbackRate,
      pageIntervalSec,
      unitType: "video",
      priorErrors: [],
    });
  }

  if (contentId == null || durationSec == null) {
    return {
      ...base,
      isError: true,
      status: "page_structure_change",
      unit_type: "video",
      errors: [
        {
          where: "learn_vo",
          message:
            "Could not resolve video contentId/duration (page/API structure may have changed)",
        },
      ],
    };
  }

  const dto = buildVideoLearnDto({
    unit_id: unitId,
    content_id: contentId,
    duration_sec: durationSec,
  });

  const saved = await saveLearnDto({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    referer,
    dto,
  });
  if (saved.kind === "saved") {
    return {
      isError: false,
      status: "ok",
      course_id: courseId,
      term_id: termId,
      unit_id: unitId,
      unit_type: "video",
      completed: true,
      learned_sec: durationSec,
      duration_sec: durationSec,
      percent: 100,
      playback_rate: playbackRate,
      page_count: null,
      page_interval_sec: null,
      transport: "rpc",
      nav_strategy: null,
      course_kind: classifyCourseKind(course.school_short_name),
      errors: [],
    };
  }

  const where =
    saved.kind === "error"
      ? saved.where
      : saved.kind === "auth_expired"
        ? "credentials"
        : "save_learn";
  const rpcError = { where, message: saved.message };

  if (
    transport === "auto" &&
    saved.kind === "error" &&
    isLearnProgressBlockedMessage(saved.message)
  ) {
    return runPlaywrightStudy({
      base,
      courseId,
      termId,
      unitId,
      located: { ...located, content_id: contentId, duration_sec: durationSec },
      course,
      session,
      ports,
      playbackRate,
      pageIntervalSec,
      unitType: "video",
      priorErrors: [rpcError],
    });
  }

  return {
    ...base,
    isError: true,
    status: saved.kind,
    unit_type: "video",
    errors: [rpcError],
  };
}

async function studyDocUnit(input: {
  base: Omit<StudyUnitResult, "isError" | "status" | "errors">;
  courseId: string;
  termId: string;
  unitId: string;
  located: LocatedUnit;
  course: { course_id: string; term_id: string; school_short_name: string };
  session: { cookie: string; csrfKey: string };
  ports: Icourse163Ports;
  playbackRate: number;
  pageIntervalSec: number;
  transport: StudyTransport;
}): Promise<StudyUnitResult> {
  const {
    base,
    courseId,
    termId,
    unitId,
    located,
    course,
    session,
    ports,
    playbackRate,
    pageIntervalSec,
    transport,
  } = input;
  const contentType = located.content_type ?? 3;
  const referer = learnReferer(course);
  const contentId = located.content_id ?? unitId;

  if (transport === "playwright") {
    return runPlaywrightStudy({
      base,
      courseId,
      termId,
      unitId,
      located,
      course,
      session,
      ports,
      playbackRate,
      pageIntervalSec,
      unitType: "doc",
      priorErrors: [],
    });
  }

  const learnVo = await fetchLessonUnitLearnVo({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    contentId,
    unitId,
    contentType,
    referer,
  });

  // PDF (3): need textPages. Rich text (4): OCS reloads; mark finished with pageNum 1.
  let pageCount = learnVo?.textPages ?? null;
  if (pageCount == null && contentType === 4) {
    pageCount = 1;
  }
  if (pageCount == null || pageCount <= 0) {
    return {
      ...base,
      isError: true,
      status: "page_structure_change",
      unit_type: "doc",
      page_interval_sec: pageIntervalSec,
      errors: [
        {
          where: "learn_vo",
          message:
            "Could not resolve doc textPages (page/API structure may have changed)",
        },
      ],
    };
  }

  if (pageIntervalSec > 0 && pageCount > 1) {
    const turns = pageCount - 1;
    await sleepMs(turns * pageIntervalSec * 1000);
  }

  const dto = buildDocLearnDto({
    unit_id: unitId,
    content_type: contentType,
    page_count: pageCount,
  });

  const saved = await saveLearnDto({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    referer,
    dto,
  });
  if (saved.kind === "saved") {
    return {
      isError: false,
      status: "ok",
      course_id: courseId,
      term_id: termId,
      unit_id: unitId,
      unit_type: "doc",
      completed: true,
      learned_sec: null,
      duration_sec: null,
      percent: 100,
      playback_rate: playbackRate,
      page_count: pageCount,
      page_interval_sec: pageIntervalSec,
      transport: "rpc",
      nav_strategy: null,
      course_kind: classifyCourseKind(course.school_short_name),
      errors: [],
    };
  }

  const where =
    saved.kind === "error"
      ? saved.where
      : saved.kind === "auth_expired"
        ? "credentials"
        : "save_learn";
  const rpcError = { where, message: saved.message };

  if (
    transport === "auto" &&
    saved.kind === "error" &&
    isLearnProgressBlockedMessage(saved.message)
  ) {
    return runPlaywrightStudy({
      base,
      courseId,
      termId,
      unitId,
      located,
      course,
      session,
      ports,
      playbackRate,
      pageIntervalSec,
      unitType: "doc",
      priorErrors: [rpcError],
    });
  }

  return {
    ...base,
    isError: true,
    status: saved.kind,
    unit_type: "doc",
    page_count: pageCount,
    page_interval_sec: pageIntervalSec,
    errors: [rpcError],
  };
}

async function runPlaywrightStudy(input: {
  base: Omit<StudyUnitResult, "isError" | "status" | "errors">;
  courseId: string;
  termId: string;
  unitId: string;
  located: LocatedUnit;
  course: { course_id: string; term_id: string; school_short_name: string };
  session: { cookie: string; csrfKey: string };
  ports: Icourse163Ports;
  playbackRate: number;
  pageIntervalSec: number;
  unitType: "video" | "doc";
  priorErrors: ToolError[];
}): Promise<StudyUnitResult> {
  const {
    base,
    courseId,
    termId,
    unitId,
    located,
    course,
    session,
    ports,
    playbackRate,
    pageIntervalSec,
    unitType,
    priorErrors,
  } = input;

  const runner = ports.studyPlaywright ?? createPlaywrightStudyRunner();
  let outcome: StudyPlaywrightOutcome;
  try {
    outcome = await runner.studyUnitInBrowser({
      cookie: session.cookie,
      course_id: course.course_id,
      term_id: course.term_id,
      school_short_name: course.school_short_name,
      unit_id: unitId,
      lesson_id: located.lesson_id,
      unit_name: located.name,
      content_id: located.content_id,
      unit_type: unitType,
      content_type: located.content_type,
      playback_rate: playbackRate,
      page_interval_sec: pageIntervalSec,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      isError: true,
      status: "error",
      unit_type: unitType,
      page_interval_sec: unitType === "doc" ? pageIntervalSec : null,
      errors: [
        ...priorErrors,
        { where: "playwright", message: detail },
      ],
    };
  }

  return mapPlaywrightOutcome({
    base,
    courseId,
    termId,
    unitId,
    unitType,
    playbackRate,
    pageIntervalSec,
    outcome,
    priorErrors,
    courseKind: classifyCourseKind(course.school_short_name),
  });
}

function mapPlaywrightOutcome(input: {
  base: Omit<StudyUnitResult, "isError" | "status" | "errors">;
  courseId: string;
  termId: string;
  unitId: string;
  unitType: "video" | "doc";
  playbackRate: number;
  pageIntervalSec: number;
  outcome: StudyPlaywrightOutcome;
  priorErrors: ToolError[];
  courseKind: CourseKind;
}): StudyUnitResult {
  const {
    base,
    courseId,
    termId,
    unitId,
    unitType,
    playbackRate,
    pageIntervalSec,
    outcome,
    priorErrors,
    courseKind,
  } = input;

  const navStrategy = outcome.nav_strategy ?? null;

  if (outcome.kind === "completed") {
    return {
      isError: false,
      status: "ok",
      course_id: courseId,
      term_id: termId,
      unit_id: unitId,
      unit_type: unitType,
      completed: true,
      learned_sec: outcome.learned_sec,
      duration_sec: outcome.duration_sec,
      percent: outcome.percent,
      playback_rate: playbackRate,
      page_count: outcome.page_count,
      page_interval_sec: unitType === "doc" ? pageIntervalSec : null,
      transport: "playwright",
      nav_strategy: navStrategy,
      course_kind: courseKind,
      errors: [],
    };
  }

  if (outcome.kind === "needs_quiz_assist") {
    return {
      ...base,
      isError: true,
      status: "needs_quiz_assist",
      unit_type: unitType,
      completed: false,
      learned_sec: outcome.learned_sec,
      duration_sec: outcome.duration_sec,
      transport: "playwright",
      nav_strategy: navStrategy,
      course_kind: courseKind,
      errors: [
        ...priorErrors,
        { where: "playwright_quiz", message: outcome.message },
      ],
    };
  }

  if (outcome.kind === "page_structure_change") {
    return {
      ...base,
      isError: true,
      status: "page_structure_change",
      unit_type: unitType,
      page_interval_sec: unitType === "doc" ? pageIntervalSec : null,
      transport: "playwright",
      nav_strategy: navStrategy,
      course_kind: courseKind,
      errors: [
        ...priorErrors,
        { where: "playwright", message: outcome.message },
      ],
    };
  }

  return {
    ...base,
    isError: true,
    status: "error",
    unit_type: unitType,
    page_interval_sec: unitType === "doc" ? pageIntervalSec : null,
    transport: "playwright",
    nav_strategy: navStrategy,
    course_kind: courseKind,
    errors: [
      ...priorErrors,
      { where: "playwright", message: outcome.message },
    ],
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
