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
import { buildSignedRpcRequest } from "./rpc-sign";
import {
  classifyCourseKind,
  createPlaywrightStudyRunner,
  type CourseKind,
  type NavStrategy,
  type StudyPlaywrightOutcome,
} from "./study-playwright";

// The live client posts to `courseRpcBean`, not `courseBean`; the latter is a stale
// variant. The request must also carry an auth-signature — see ./rpc-sign.
export const SAVE_LEARN_RPC_PATH = "/web/j/courseRpcBean.saveMocContentLearn.rpc";
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
/** Backoff for the server's 并发限制 throttle on saveMocContentLearn. */
const SAVE_CONCURRENCY_RETRY_ATTEMPTS = 4;
const SAVE_CONCURRENCY_RETRY_BASE_MS = 700;

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
  /**
   * Default true: the browser path seeks straight to the end of the media, which is
   * fast but the platform does not credit it. Set false to play the media through at
   * playback_rate, which takes wall-clock duration/rate but is actually recorded.
   */
  skip_to_end?: boolean;
  /**
   * RPC transport only. 0 (default) sends one completion report, ~1.4s per unit, leaving
   * the platform a single 0->100 jump in its logs. A positive value reports that many
   * seconds per signed request, spaced by chunk/playback_rate of real time, so the
   * platform sees the same shape of incremental progress a real player produces.
   *
   * It genuinely costs the wall-clock time -- that is the entire point -- so a 10 minute
   * video at chunk 60 and rate 2 takes about 5 minutes.
   */
  report_chunk_sec?: number;
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
  /**
   * RPC transport only: how many signed reports this run sent. 1 is the one-shot
   * completion report; more means the chunked path was used.
   */
  report_chunks?: number;
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

/** Floor/ceiling for a chunked report, in seconds. 0 means "one-shot" and is preserved. */
export const MIN_REPORT_CHUNK_SEC = 0;
export const MAX_REPORT_CHUNK_SEC = 600;

/**
 * A chunk below 5s would mean more requests than a real player ever sends (the platform's
 * own client uses 60), so anything smaller is lifted to the floor rather than rejected.
 */
export function clampReportChunkSec(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(MAX_REPORT_CHUNK_SEC, Math.max(5, Math.floor(value)));
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

/**
 * Body for `saveMocContentLearn` on a video unit.
 *
 * Captured from the platform's own client: flat fields (no `videoDto` nesting),
 * `action: "LEARN_TIME_COUNT"`, and a per-report `learnedVideoTimeCount`. The real
 * client sends one report per ~60s of playback and progress accumulates; reporting
 * the whole duration in a single call marks the unit complete at once, which is
 * what this tool wants.
 *
 * `userId` appears in the browser payload but is NOT required — omitting it still
 * returns code 0 (verified).
 */
export function buildVideoLearnReport(input: {
  course_id: string;
  term_id: string;
  lesson_id: string;
  unit_id: string;
  video_id: string;
  duration_sec: number;
  learned_sec?: number;
  /**
   * The playback position this report claims, in seconds.
   *
   * `videoTime` is the POSITION, not the total duration. Measured: the platform credits a
   * report only when `videoTime` advances past what it already recorded. Sending the same
   * value every time — including the full duration — gets `{"code":0,"result":true}` and
   * credits nothing. Advancing it 60/120/180/240 on a 559s unit got every report credited,
   * +60s each, even though they were only 2.5s apart, so no rate limit is involved.
   *
   * Defaults to the full duration, which is right for the one-shot completion report.
   */
  video_time_sec?: number;
  /** Default true. An in-progress segment must send false; the final report sets true. */
  finished?: boolean;
}): Record<string, unknown> {
  const duration = Math.max(0, Math.floor(input.duration_sec));
  const learned = Math.max(0, Math.min(duration, Math.floor(input.learned_sec ?? duration)));
  const videoTime = Math.max(0, Math.min(duration, Math.floor(input.video_time_sec ?? duration)));
  return {
    unitId: Number(input.unit_id),
    finished: input.finished ?? true,
    index: 1,
    duration: learned * 1000,
    courseId: Number(input.course_id),
    lessonId: Number(input.lesson_id),
    videoId: Number(input.video_id),
    termId: Number(input.term_id),
    contentType: 1,
    action: "LEARN_TIME_COUNT",
    videoTime,
    learnedVideoTimeCount: learned,
  };
}

/** One report in a chunked video run. Pure, so the sequence is testable without HTTP. */
export type VideoChunk = { learned_sec: number; position_sec: number; finished: boolean };

/**
 * Split a video into the reports a chunked run sends.
 *
 * `learned_sec` is per-segment (the platform adds it to what it already holds) while
 * `position_sec` is the running position and MUST increase every report or nothing is
 * credited. The last report is always `finished: true`, which is what completes the unit.
 *
 * A chunk of 0, or one covering the whole video, yields the single one-shot report.
 */
export function planVideoChunks(durationSec: number, chunkSec: number): VideoChunk[] {
  const duration = Math.max(0, Math.floor(durationSec));
  if (duration === 0) {
    return [];
  }
  const chunk = Math.max(0, Math.floor(chunkSec));
  if (chunk === 0 || chunk >= duration) {
    return [{ learned_sec: duration, position_sec: duration, finished: true }];
  }
  const out: VideoChunk[] = [];
  let position = 0;
  while (position < duration) {
    const step = Math.min(chunk, duration - position);
    position += step;
    out.push({ learned_sec: step, position_sec: position, finished: position >= duration });
  }
  return out;
}

/**
 * Body for `saveMocContentLearn` on a doc (PDF / PPT / rich text) unit, captured
 * from the platform's own client. `pageNum` is included when the page count is
 * known, but the server does not validate it — an incomplete doc reaches
 * completePercent 1 even with pageNum omitted — so an unknown page count is not
 * fatal (unlike the old shape, which required textPages from a broken RPC).
 */
export function buildDocLearnReport(input: {
  course_id: string;
  term_id: string;
  lesson_id: string;
  unit_id: string;
  content_type: number;
  page_count?: number | null;
  learned_sec?: number;
  now?: number;
}): Record<string, unknown> {
  const dto: Record<string, unknown> = {
    unitId: Number(input.unit_id),
    finished: true,
    contentType: input.content_type,
    index: 0,
    courseId: Number(input.course_id),
    lessonId: Number(input.lesson_id),
    termId: Number(input.term_id),
    lastLearnTime: input.now ?? Date.now(),
    learnedVideoTimeCount: Math.max(1, Math.floor(input.learned_sec ?? 2)),
  };
  if (input.page_count != null && input.page_count > 0) {
    dto.pageNum = Math.max(1, Math.floor(input.page_count));
  }
  return dto;
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
  const skipToEnd = args.skip_to_end !== false;
  const reportChunkSec = clampReportChunkSec(args.report_chunk_sec);

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
      skipToEnd,
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
    skipToEnd,
    transport,
    reportChunkSec,
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

export async function fetchLessonUnitLearnVo(input: {
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


export type SaveLearnOutcome =
  | { kind: "saved" }
  | { kind: "auth_expired"; message: string }
  | { kind: "page_structure_change"; message: string }
  | { kind: "error"; message: string; where: string };

export async function saveLearnDto(input: {
  http: Icourse163Http;
  cookie: string;
  csrfKey: string;
  referer: string;
  dto: unknown;
}): Promise<SaveLearnOutcome> {
  // Firing signed saves back to back trips the server's throttle: a 7-unit batch
  // observed 3 successes and 4 "并发限制，请稍后再试" in 5 seconds. Retry those with
  // backoff, rebuilding the signature each time because it covers timestamp/nonce.
  let last: SaveLearnOutcome | null = null;
  for (let attempt = 1; attempt <= SAVE_CONCURRENCY_RETRY_ATTEMPTS; attempt += 1) {
    const outcome = await saveLearnOnce(input);
    if (outcome.kind === "saved" || outcome.kind === "auth_expired") {
      return outcome;
    }
    if (outcome.kind === "page_structure_change" || !/并发限制/.test(outcome.message)) {
      return outcome;
    }
    last = outcome;
    if (attempt < SAVE_CONCURRENCY_RETRY_ATTEMPTS) {
      await sleepMs(SAVE_CONCURRENCY_RETRY_BASE_MS * attempt);
    }
  }
  return (
    last ?? { kind: "error", where: "save_learn", message: "saveMocContentLearn failed" }
  );
}

async function saveLearnOnce(input: {
  http: Icourse163Http;
  cookie: string;
  csrfKey: string;
  referer: string;
  dto: unknown;
}): Promise<SaveLearnOutcome> {
  // Signed JSON body. The signature covers these exact bytes, so send them raw.
  const signed = buildSignedRpcRequest({
    dto: input.dto,
    csrfKey: input.csrfKey,
    origin: ORIGIN,
    referer: input.referer,
  });
  let saveBody: string;
  try {
    const response = await input.http.request({
      url: `${SAVE_LEARN_RPC_URL}?csrfKey=${encodeURIComponent(input.csrfKey)}`,
      cookie: input.cookie,
      method: "POST",
      raw: signed.body,
      headers: signed.headers,
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
        ? `${apiMessage} (signature rejected — the site may have rotated the key or digest; see docs/adr/0004-rpc-request-signing.md)`
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
  skipToEnd: boolean;
  transport: StudyTransport;
  reportChunkSec: number;
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
    skipToEnd,
    transport,
    reportChunkSec,
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
      skipToEnd,
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

  if (located.lesson_id == null) {
    return {
      ...base,
      isError: true,
      status: "page_structure_change",
      unit_type: "video",
      errors: [
        {
          where: "term",
          message:
            "Unit has no lesson id in the term catalog, so the signed learn report cannot be built",
        },
      ],
    };
  }

  // Chunked reporting: send the same shape of incremental progress a real player sends.
  // This is the only mode that makes the platform's logs look like playback rather than a
  // single 0->100 jump, and it costs real time by construction.
  const chunks = planVideoChunks(durationSec, reportChunkSec);
  if (chunks.length > 1) {
    let reported = 0;
    for (const [index, chunk] of chunks.entries()) {
      const dto = buildVideoLearnReport({
        course_id: courseId,
        term_id: termId,
        lesson_id: located.lesson_id,
        unit_id: unitId,
        video_id: contentId,
        duration_sec: durationSec,
        learned_sec: chunk.learned_sec,
        video_time_sec: chunk.position_sec,
        finished: chunk.finished,
      });
      const res = await saveLearnDto({
        http: ports.http,
        cookie: session.cookie,
        csrfKey: session.csrfKey,
        referer,
        dto,
      });
      if (res.kind !== "saved") {
        // Progress already reported is genuinely recorded, so surface how far it got
        // instead of pretending the whole run failed.
        const where =
          res.kind === "error" ? res.where : res.kind === "auth_expired" ? "credentials" : "save_learn";
        return {
          ...base,
          isError: true,
          status: res.kind === "auth_expired" ? "auth_expired" : "error",
          unit_type: "video",
          completed: false,
          learned_sec: reported,
          duration_sec: durationSec,
          percent: durationSec > 0 ? Math.round((reported / durationSec) * 100) : 0,
          playback_rate: playbackRate,
          transport: "rpc",
          report_chunks: index,
          errors: [
            {
              where,
              message: `chunked report ${index + 1}/${chunks.length} failed after ${reported}s of ${durationSec}s: ${res.message}`,
            },
          ],
        };
      }
      reported += chunk.learned_sec;
      const isLast = index === chunks.length - 1;
      if (!isLast) {
        // The pacing is the point: chunk/rate seconds of real time, like a player at rate.
        await sleepMs((chunk.learned_sec / playbackRate) * 1000);
      }
    }
    return {
      ...base,
      isError: false,
      status: "ok",
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
      report_chunks: chunks.length,
      errors: [],
    };
  }

  const dto = buildVideoLearnReport({
    course_id: courseId,
    term_id: termId,
    lesson_id: located.lesson_id,
    unit_id: unitId,
    video_id: contentId,
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
      ...base,
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
      report_chunks: 1,
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
      skipToEnd,
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
  skipToEnd: boolean;
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
    skipToEnd,
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
      skipToEnd,
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

  // pageNum is OPTIONAL in the real contract: the server does not validate it
  // (verified with 18 / 1 / 9999 / omitted, all code 0), and an incomplete doc
  // goes to completePercent 1 with it omitted entirely. So a missing textPages is
  // no longer fatal — it only means we cannot echo the page count back.
  let pageCount = learnVo?.textPages ?? null;
  if (pageCount == null && contentType === 4) {
    pageCount = 1;
  }

  if (pageIntervalSec > 0 && pageCount != null && pageCount > 1) {
    const turns = pageCount - 1;
    await sleepMs(turns * pageIntervalSec * 1000);
  }

  if (located.lesson_id == null) {
    return {
      ...base,
      isError: true,
      status: "page_structure_change",
      unit_type: "doc",
      page_interval_sec: pageIntervalSec,
      errors: [
        {
          where: "term",
          message:
            "Unit has no lesson id in the term catalog, so the signed learn report cannot be built",
        },
      ],
    };
  }

  const dto = buildDocLearnReport({
    course_id: courseId,
    term_id: termId,
    lesson_id: located.lesson_id,
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
      skipToEnd,
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
  skipToEnd: boolean;
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
    skipToEnd,
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
      duration_sec: located.duration_sec,
      // seek_near_end means "jump to the end"; skip_to_end is its positive form.
      seek_near_end: skipToEnd,
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
