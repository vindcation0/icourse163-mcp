/**
 * Fast RPC capability probe for icourse163.
 *
 * The RPC transport has two gates, and only the second one decides whether
 * `transport=rpc` can ever work:
 *
 *   1. getLessonUnitLearnVo  (read-only) — supplies textPages for docs and
 *      enriches duration/videoId for videos. Videos survive its failure because
 *      the term catalog carries durationInSeconds; docs do not.
 *   2. saveMocContentLearn   (write)     — the actual progress report. When this
 *      is blocked, the whole RPC path is useless.
 *
 * Both are exercised through the same functions study_unit uses, after a real
 * warm-up, because calling these RPCs cold answers -1002 非法跨域请求 regardless
 * of whether the session can actually write.
 *
 * Gate 2 writes progress. The default target is therefore a unit already at
 * completePercent 1, where re-sending 100% is a no-op. Pass --unit-id to pick
 * another one and read the warning it prints.
 *
 * Usage:
 *   npm run check:rpc --silent -- --course-id <id> --term-id <id> [--school XDU] [--unit-id <id>]
 */
import { createLocalCredentialStore } from "./credentials";
import { createFetchIcourse163Http } from "./http";
import { asArray, asFiniteNumber, asId, asNonEmptyString, asRecord, parseJsonObject } from "./json-util";
import { fetchMocTermDto, learnReferer, resolveSession } from "./course-rpc";
import {
  LEARN_VO_RPC_URL,
  buildDocLearnReport,
  buildVideoLearnReport,
  fetchLessonUnitLearnVo,
  saveLearnDto,
} from "./study-unit";

type FlagValue = string | undefined;

function flag(name: string): FlagValue {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return undefined;
}

type Candidate = {
  unitId: string;
  lessonId: string | null;
  name: string;
  contentType: number | null;
  contentId: string | null;
  durationSec: number | null;
  completePercent: number | null;
};

function collectUnits(moc: Record<string, unknown>): Candidate[] {
  const out: Candidate[] = [];
  for (const chapterRaw of asArray(moc.chapters)) {
    const chapter = asRecord(chapterRaw);
    if (chapter == null) continue;
    for (const lessonRaw of asArray(chapter.lessons)) {
      const lesson = asRecord(lessonRaw);
      if (lesson == null) continue;
      for (const unitRaw of asArray(lesson.units)) {
        const unit = asRecord(unitRaw);
        if (unit == null) continue;
        const unitId = asId(unit.id);
        if (unitId == null) continue;
        out.push({
          unitId,
          lessonId: asId(lesson.id),
          name: asNonEmptyString(unit.name) ?? "未命名",
          contentType: asFiniteNumber(unit.contentType),
          contentId: asId(unit.contentId) ?? asId(unit.videoId) ?? asId(unit.resourceId),
          durationSec: asFiniteNumber(unit.durationInSeconds),
          completePercent: asFiniteNumber(unit.completePercent),
        });
      }
    }
  }
  return out;
}

const courseId = flag("course-id");
const termId = flag("term-id");
if (courseId == null || termId == null) {
  console.error(
    "usage: npm run check:rpc --silent -- --course-id <id> --term-id <id> [--school XDU] [--unit-id <id>]",
  );
  process.exit(2);
}
const school = flag("school") ?? "";
const wantUnit = flag("unit-id");

const ports = {
  credentials: createLocalCredentialStore(),
  http: createFetchIcourse163Http(),
};

console.log("icourse163 RPC capability check");
console.log("===============================");

const session = await resolveSession(ports);
if (!session.ok) {
  console.log("session      : FAILED");
  for (const error of session.errors) console.log(`               ${error.where}: ${error.message}`);
  process.exit(1);
}
console.log("session      : ok (warm-up + probe passed)");

const course = { course_id: courseId, term_id: termId, school_short_name: school };
const referer = learnReferer(course);

let moc: Record<string, unknown> | null = null;
try {
  moc = await fetchMocTermDto({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
    course,
  });
} catch (error) {
  console.log(`term catalog : request failed (${error instanceof Error ? error.message : String(error)})`);
  process.exit(1);
}
if (moc == null) {
  console.log("term catalog : no mocTermDto (check course/term/school ids)");
  process.exit(1);
}

const units = collectUnits(moc);
console.log(`term catalog : ok (${units.length} units)`);

let target: Candidate | undefined;
if (wantUnit != null) {
  target = units.find((unit) => unit.unitId === wantUnit);
  if (target == null) {
    console.log(`target unit  : ${wantUnit} NOT FOUND in this term`);
    process.exit(1);
  }
  if (target.completePercent !== 1) {
    console.log(
      `               WARNING: gate 2 writes progress; this unit is at completePercent ${String(target.completePercent)}, so the value below may change it.`,
    );
  }
} else {
  target = units.find((unit) => unit.completePercent === 1 && unit.contentType === 1);
  if (target == null) {
    target = units.find((unit) => unit.completePercent === 1);
  }
  if (target == null) {
    console.log("target unit  : no completed unit found to probe safely; pass --unit-id");
    process.exit(1);
  }
  console.log("               (auto-picked a unit already at completePercent 1, so re-saving is a no-op)");
}
console.log(
  `target unit  : ${target.unitId}  type=${String(target.contentType)}  completePercent=${String(target.completePercent)}  duration=${String(target.durationSec)}s  ${target.name}`,
);

// ---- gate 1: getLessonUnitLearnVo (read-only) ----
console.log("\n--- gate 1: getLessonUnitLearnVo (read-only) ---");
const contentType = target.contentType ?? 1;
const contentId = target.contentId ?? target.unitId;
let rawGate1 = "(request threw)";
try {
  const response = await ports.http.request({
    url: `${LEARN_VO_RPC_URL}?csrfKey=${encodeURIComponent(session.csrfKey)}`,
    cookie: session.cookie,
    method: "POST",
    form: { contentId, unitId: target.unitId, contentType: String(contentType) },
    headers: { origin: "https://www.icourse163.org", referer },
  });
  const json = parseJsonObject(response.body);
  const message = json == null ? "" : (asNonEmptyString(json.message) ?? "");
  const code = json == null ? "unparseable" : String(json.code);
  rawGate1 = `code=${code}${message.length > 0 ? ` message=${message}` : ""}`;
} catch (error) {
  rawGate1 = `threw: ${error instanceof Error ? error.message : String(error)}`;
}
console.log(`raw response : ${rawGate1}`);

const learnVo = await fetchLessonUnitLearnVo({
  http: ports.http,
  cookie: session.cookie,
  csrfKey: session.csrfKey,
  contentId,
  unitId: target.unitId,
  contentType,
  referer,
});
console.log(
  `parsed       : durationSec=${String(learnVo?.durationSec ?? null)} videoId=${String(learnVo?.videoId ?? null)} textPages=${String(learnVo?.textPages ?? null)}`,
);
console.log(
  learnVo == null
    ? "verdict      : USELESS but no longer blocking — videos fall back to the catalog durationInSeconds, and docs no longer need a page count because pageNum is not validated"
    : "verdict      : usable",
);

// ---- gate 2: saveMocContentLearn (write) ----
console.log("\n--- gate 2: saveMocContentLearn (writes progress) ---");
let dto: unknown;
if (contentType === 3 || contentType === 4) {
  if (target.lessonId == null) {
    console.log("dto          : skipped — catalog lacks a lessonId for this unit");
    console.log("verdict      : INCONCLUSIVE");
    process.exit(0);
  }
  // pageNum is optional; the server does not validate it.
  dto = buildDocLearnReport({
    course_id: courseId,
    term_id: termId,
    lesson_id: target.lessonId,
    unit_id: target.unitId,
    content_type: contentType,
    page_count: learnVo?.textPages ?? null,
  });
} else {
  if (target.durationSec == null || target.contentId == null || target.lessonId == null) {
    console.log("dto          : skipped — catalog lacks duration/contentId/lessonId for this unit");
    console.log("verdict      : INCONCLUSIVE");
    process.exit(0);
  }
  dto = buildVideoLearnReport({
    course_id: courseId,
    term_id: termId,
    lesson_id: target.lessonId,
    unit_id: target.unitId,
    video_id: target.contentId,
    duration_sec: target.durationSec,
  });
}
console.log(`dto          : ${JSON.stringify(dto)}`);

const saved = await saveLearnDto({
  http: ports.http,
  cookie: session.cookie,
  csrfKey: session.csrfKey,
  referer,
  dto,
});
if (saved.kind === "saved") {
  console.log("result       : saved (code 0)");
  console.log("verdict      : usable");
  console.log("\n=== OVERALL ===");
  console.log("RPC progress reporting WORKS. This build signs its requests (src/rpc-sign.ts), so");
  console.log("transport=rpc is viable and takes about a second, versus ~30s and a live browser");
  console.log("session for the Playwright path.");
} else {
  const where = saved.kind === "error" ? saved.where : "credentials";
  console.log(`result       : ${saved.kind} [${where}] ${saved.message}`);
  console.log("verdict      : REJECTED — not an anti-abuse ban");
  console.log("\n=== OVERALL ===");
  console.log("-10006 (请检查本地时间是否和北京时间一致) and 并发限制 are what the server says when");
  console.log("the auth-signature does not verify. They do NOT mean the account is blocked.");
  console.log("This build DOES sign its requests (src/rpc-sign.ts), so a rejection here means");
  console.log("the site changed the key or the digest construction — update that file.");
  console.log("Meanwhile transport=auto still falls back to the browser, which keeps working.");
}
