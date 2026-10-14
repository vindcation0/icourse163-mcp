import { missingSessionFailure } from "./auth";
import {
  fetchMocTermDto,
  resolveSession,
  type ToolError,
} from "./course-rpc";
import {
  asArray,
  asFiniteNumber,
  asId,
  asNonEmptyString,
  asRecord,
} from "./json-util";
import type { Icourse163Ports } from "./ports";

export type ListTermUnitsStatus = "ok" | "auth_expired" | "error";

export type UnitType = "video" | "doc" | "quiz" | "other";

export type TermUnit = {
  id: string;
  name: string;
  type: UnitType;
  learn_status: string | null;
  /**
   * Completion as a 0..1 fraction straight from the term catalog; `1` means done.
   * Exposed so callers can skip finished units instead of re-studying them, since
   * `learn_status` is null on courses whose catalog omits those fields.
   */
  complete_percent: number | null;
};

export type TermLesson = {
  id: string;
  name: string;
  chapter_id: string | null;
  chapter_name: string | null;
  units: TermUnit[];
};

export type ListTermUnitsArgs = {
  course_id: string;
  term_id: string;
  school_short_name?: string;
};

export type ListTermUnitsResult = {
  isError: boolean;
  status: ListTermUnitsStatus;
  course_id: string;
  term_id: string;
  lessons: TermLesson[];
  errors: ToolError[];
};

/** Official contentType: 1 video, 3 PDF doc, 4 rich text, 5 quiz, 6 discuss, 7 live. */
export function mapContentType(contentType: number | null): UnitType {
  switch (contentType) {
    case 1:
      return "video";
    case 3:
    case 4:
      return "doc";
    case 5:
      return "quiz";
    default:
      return "other";
  }
}

export function lessonsFromMocTerm(moc: Record<string, unknown>): TermLesson[] {
  const lessons: TermLesson[] = [];
  for (const chapterRaw of asArray(moc.chapters)) {
    const chapter = asRecord(chapterRaw);
    if (chapter == null) {
      continue;
    }
    const chapterId = asId(chapter.id);
    const chapterName = asNonEmptyString(chapter.name);

    for (const lessonRaw of asArray(chapter.lessons)) {
      const lesson = asRecord(lessonRaw);
      if (lesson == null) {
        continue;
      }
      const lessonId = asId(lesson.id);
      if (lessonId == null) {
        continue;
      }
      const units: TermUnit[] = [];
      for (const unitRaw of asArray(lesson.units)) {
        const unit = unitFromRecord(unitRaw);
        if (unit != null) {
          units.push(unit);
        }
      }
      lessons.push({
        id: lessonId,
        name: asNonEmptyString(lesson.name) ?? "未命名节",
        chapter_id: chapterId,
        chapter_name: chapterName,
        units,
      });
    }

    for (const quizRaw of asArray(chapter.quizs)) {
      const quizLesson = lessonFromChapterQuiz(quizRaw, chapterId, chapterName);
      if (quizLesson != null) {
        lessons.push(quizLesson);
      }
    }
  }
  return lessons;
}

export async function listTermUnits(
  args: ListTermUnitsArgs,
  ports?: Icourse163Ports,
): Promise<ListTermUnitsResult> {
  const courseId = args.course_id.trim();
  const termId = args.term_id.trim();
  const empty = {
    course_id: courseId,
    term_id: termId,
    lessons: [] as TermLesson[],
  };

  if (courseId.length === 0 || termId.length === 0) {
    return {
      isError: true,
      status: "error",
      ...empty,
      errors: [
        {
          where: "args",
          message: "course_id and term_id are required",
        },
      ],
    };
  }

  if (ports == null) {
    return {
      isError: true,
      status: "auth_expired",
      ...empty,
      errors: [{ where: "credentials", message: missingSessionFailure().message }],
    };
  }

  const session = await resolveSession(ports);
  if (!session.ok) {
    return {
      isError: true,
      status: session.status,
      ...empty,
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
      isError: true,
      status: "error",
      ...empty,
      errors: [{ where: "term", message: `Term structure RPC failed: ${detail}` }],
    };
  }

  if (moc == null) {
    const detail = diagnostics.length > 0 ? `: ${diagnostics.join("; ")}` : "";
    return {
      isError: true,
      status: "error",
      ...empty,
      errors: [
        {
          where: "term",
          message: `Term structure RPC returned no mocTermDto${detail}`,
        },
      ],
    };
  }

  return {
    isError: false,
    status: "ok",
    course_id: courseId,
    term_id: termId,
    lessons: lessonsFromMocTerm(moc),
    errors: [],
  };
}

function unitFromRecord(raw: unknown): TermUnit | null {
  const unit = asRecord(raw);
  if (unit == null) {
    return null;
  }
  const id = asId(unit.id);
  if (id == null) {
    return null;
  }
  return {
    id,
    name: asNonEmptyString(unit.name) ?? "未命名单元",
    type: mapContentType(asFiniteNumber(unit.contentType)),
    learn_status: learnStatusFrom(unit),
    complete_percent: asFiniteNumber(unit.completePercent),
  };
}

function lessonFromChapterQuiz(
  raw: unknown,
  chapterId: string | null,
  chapterName: string | null,
): TermLesson | null {
  const quiz = asRecord(raw);
  if (quiz == null) {
    return null;
  }
  const test = asRecord(quiz.test) ?? {};
  const id = asId(quiz.id) ?? asId(test.id);
  if (id == null) {
    return null;
  }
  const name =
    asNonEmptyString(quiz.name) ?? asNonEmptyString(test.name) ?? "未知测验";
  return {
    id: `quiz:${id}`,
    name,
    chapter_id: chapterId,
    chapter_name: chapterName,
    units: [
      {
        id,
        name,
        type: "quiz",
        learn_status: learnStatusFrom(test, quiz),
        complete_percent: asFiniteNumber(quiz.completePercent ?? test.completePercent),
      },
    ],
  };
}

function learnStatusFrom(
  ...records: Record<string, unknown>[]
): string | null {
  for (const record of records) {
    const named =
      asNonEmptyString(record.learnStatusName) ??
      asNonEmptyString(record.statusName) ??
      asNonEmptyString(record.evaluateStatus) ??
      asNonEmptyString(record.evaluateStatusName) ??
      asNonEmptyString(record.testStatus);
    if (named != null) {
      return named;
    }
    if (typeof record.hasLearned === "boolean") {
      return record.hasLearned ? "learned" : "unlearned";
    }
    if (typeof record.learned === "boolean") {
      return record.learned ? "learned" : "unlearned";
    }
    const learnStatus = asFiniteNumber(record.learnStatus);
    if (learnStatus != null) {
      return String(learnStatus);
    }
    const usedTry = asFiniteNumber(record.usedTryCount);
    if (usedTry != null && usedTry > 0) {
      return "submitted";
    }
  }
  return null;
}
