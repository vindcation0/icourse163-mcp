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
};

export type ListCoursesArgs = {
  /** 为每门课额外查一次 `mocTermDto` 取开课/结课时间。默认 false。 */
  include_schedule?: boolean;
};

export type ListCoursesResult = {
  isError: boolean;
  status: ListCoursesStatus;
  courses: CourseItem[];
  errors: ToolError[];
};

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

  if (args.include_schedule === true) {
    // 逐门课取一次 mocTermDto。读接口很轻（实测 50~100ms），10 门课约 1 秒。
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
        item.start_time_ms = Number.isFinite(start) ? start : null;
        item.end_time_ms = Number.isFinite(end) ? end : null;
      } catch {
        item.start_time_ms = null;
        item.end_time_ms = null;
      }
    }
  }

  return { isError: false, status: "ok", courses, errors: [] };
}
