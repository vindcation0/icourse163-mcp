import { missingSessionFailure } from "./auth";
import {
  fetchAllCoursePanels,
  fetchMocTermDto,
  resolveSession,
  type ToolError,
} from "./course-rpc";
import type { Icourse163Ports } from "./ports";

export type ListCoursesStatus = "ok" | "auth_expired" | "error";

export type CourseItem = {
  id: string;
  name: string;
  school: string;
  type: "mooc" | "spoc";
  term_id: string;
  /**
   * 开课/结课时间（epoch 毫秒）。只有 `include_schedule: true` 时才有值。
   *
   * 为什么要单独开关：面板接口**不带时间字段**，时间只能从 `mocTermDto` 拿，
   * 而那是**一门课一次**请求。默认关掉，避免让这个本来很快的工具变成 10 次往返。
   * 拿不到时（比如学期已下线）为 null。
   */
  start_time_ms?: number | null;
  end_time_ms?: number | null;
  /** 课程总单元数。只有 `include_progress: true` 时有值。 */
  units_total?: number | null;
  /** 已完成单元数（completePercent >= 0.999 或 viewStatus 已完成）。 */
  units_completed?: number | null;
};

export type ListCoursesArgs = {
  /** 为每门课额外查一次 `mocTermDto` 取开课/结课时间。默认 false。 */
  include_schedule?: boolean;
  /**
   * 同时返回单元总数与已完成数。默认 false。
   *
   * 与 `include_schedule` **共用同一次 `mocTermDto` 请求** —— 那个响应里本来就带着
   * chapters/lessons/units，所以进度是顺带算出来的，不额外发请求。
   */
  include_progress?: boolean;
};

export type ListCoursesResult = {
  isError: boolean;
  status: ListCoursesStatus;
  courses: CourseItem[];
  errors: ToolError[];
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export async function listCourses(
  ports?: Icourse163Ports,
  args: ListCoursesArgs = {},
): Promise<ListCoursesResult> {
  if (ports == null) {
    return {
      isError: true,
      status: "auth_expired",
      courses: [],
      errors: [{ where: "credentials", message: missingSessionFailure().message }],
    };
  }

  const session = await resolveSession(ports);
  if (!session.ok) {
    return {
      isError: true,
      status: session.status,
      courses: [],
      errors: session.errors,
    };
  }

  const panels = await fetchAllCoursePanels({
    http: ports.http,
    cookie: session.cookie,
    csrfKey: session.csrfKey,
  });
  if (!panels.ok) {
    return {
      isError: true,
      status: panels.status,
      courses: [],
      errors: panels.errors,
    };
  }

  const courses: CourseItem[] = panels.courses.map((course) => ({
    id: course.course_id,
    name: course.name,
    school: course.school_short_name,
    type: course.type,
    term_id: course.term_id,
  }));

  if (args.include_schedule === true || args.include_progress === true) {
    // 逐门课取一次 mocTermDto。读接口很轻（实测 50~100ms），10 门课约 3 秒。
    for (const item of courses) {
      try {
        const moc = await fetchMocTermDto({
          http: ports.http,
          cookie: session.cookie,
          csrfKey: session.csrfKey,
          course: { course_id: item.id, term_id: item.term_id, school_short_name: item.school },
        });
        const record = moc as unknown as Record<string, unknown> | null;
        const start = Number(record?.startTime);
        const end = Number(record?.endTime);
        if (args.include_schedule === true) {
          item.start_time_ms = Number.isFinite(start) ? start : null;
          item.end_time_ms = Number.isFinite(end) ? end : null;
        }
        if (args.include_progress === true) {
          // 同一个响应里就有单元，顺手数一遍，不额外发请求。
          let total = 0;
          let completed = 0;
          for (const chapter of asArray(record?.chapters)) {
            const ch = asRecord(chapter);
            for (const lesson of asArray(ch?.lessons)) {
              const ls = asRecord(lesson);
              for (const unit of asArray(ls?.units)) {
                const u = asRecord(unit);
                if (u == null) continue;
                total += 1;
                const pct = Number(u.completePercent ?? 0);
                const view = String(u.viewStatus ?? "");
                if (pct >= 0.999 || view === "completed" || view === "5") {
                  completed += 1;
                }
              }
            }
          }
          item.units_total = total;
          item.units_completed = completed;
        }
      } catch {
        if (args.include_schedule === true) {
          item.start_time_ms = null;
          item.end_time_ms = null;
        }
        if (args.include_progress === true) {
          item.units_total = null;
          item.units_completed = null;
        }
      }
    }
  }

  return { isError: false, status: "ok", courses, errors: [] };
}
