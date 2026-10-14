import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  getHomework,
  saveHomeworkAnswers,
  submitHomework,
} from "./homework";
import { listCourses } from "./list-courses";
import { listTermUnits } from "./list-term-units";
import { listTodos } from "./list-todos";
import type { Icourse163Ports } from "./ports";
import { studyUnit } from "./study-unit";

const LIST_TODOS_DESCRIPTION = [
  "List still-open 待办 from 中国大学MOOC (icourse163.org): 未完成 / 未交 / 可作答 homework, quizzes, and exams.",
  "Each item has id, title, course_title, due_at (ISO+08:00 or null), and kind (作业/测验/考试).",
  "status ok with an empty todos list means none are still open.",
  "认证失效 (auth_expired) and other failures are errors (isError), never a successful empty list.",
  "Do not pass accounts or cookies; this tool never returns them.",
  "Log in with the CLI (`npm run login`); MCP never accepts passwords.",
].join(" ");

const LIST_COURSES_DESCRIPTION = [
  "List enrolled 中国大学MOOC courses (MOOC + SPOC).",
  "Each course has id, name, school, type (mooc|spoc), and term_id.",
  "status ok with an empty courses list means none enrolled.",
  "认证失效 (auth_expired) and other failures are errors (isError).",
  "Do not pass accounts or cookies; this tool never returns them.",
  "Log in with the CLI (`npm run login`); MCP never accepts passwords.",
].join(" ");

const LIST_TERM_UNITS_DESCRIPTION = [
  "List the lesson → unit catalog for one enrolled course term (课件目录).",
  "Args: course_id, term_id, optional school_short_name (for Referer).",
  "Each unit has id, name, type (video|doc|quiz|other), and learn_status when available.",
  "Chapter quizzes appear as quiz lessons. Auth failures are auth_expired (isError).",
  "Do not pass accounts or cookies; this tool never returns them.",
  "Log in with the CLI (`npm run login`); MCP never accepts passwords.",
].join(" ");

const STUDY_UNIT_DESCRIPTION = [
  "Advance learning progress for one video/audio/doc 课件 unit on 中国大学MOOC (align OCS watchMedia / readPPT).",
  "Args: course_id, term_id, unit_id from list_courses / list_term_units; optional school_short_name; optional playback_rate (0.5–2, default 1); optional page_interval_sec (0–10, default 1) for doc/PPT; optional transport (auto|rpc|playwright, default auto).",
  "Default auto: try saveMocContentLearn RPC, then Playwright DOM playback when RPC is blocked (-10006 / 本地时间 / 并发限制). Explicit transport=playwright skips RPC save; transport=rpc is RPC-only.",
  "Returns completed, learned_sec/duration_sec (video), page_count (doc), percent, transport=rpc|playwright. Needs system Chrome (see docs/mcp.md).",
  "Distinct failures: non_media_unit, auth_expired, page_structure_change, needs_quiz_assist (video popup — use get_homework → save_homework_answers; never silent-submit).",
  "Detection risk: automation may be flagged; use only on accounts you own. Do not pass cookies/passwords.",
  "Log in with the CLI (`npm run login`); MCP never accepts passwords.",
].join(" ");

const GET_HOMEWORK_DESCRIPTION = [
  "Read structured questions (stem + options) for one list_todos homework/quiz item on 中国大学MOOC.",
  "Args: todo_id (course_id:term_id:quiz|unit|homework|exam:catalog_id from list_todos); optional paper_type (quiz|homework); optional school_short_name.",
  "Pipeline: get_homework (read) → AI fills → save_homework_answers REQUIRED (draft, preview=true) → optional user review → submit_homework ONLY after explicit user confirmation.",
  "Quizzes (in-class / video popup style todos) reuse this same read path. Exam: read is allowed; never auto-submit (submit_homework refuses exam).",
  "Resolves catalog id → paper tid (contentId) via mocTermDto, then mocQuizRpcBean.getOpenQuizPaperDto / getOpenHomeworkPaperDto (mockable). Supports chapter quiz, unit quiz, chapter homework. No cookies/passwords in args.",
].join(" ");

const SAVE_HOMEWORK_DESCRIPTION = [
  "Draft-save answers for a homework/quiz todo. REQUIRED after AI fills answers. Always preview=true — NEVER formally submits.",
  "Args: todo_id; answers[{question_id, option_ids?, text?}]; optional paper_type; optional school_short_name.",
  "Refuse any smuggled submit/preview=false. Formal submit is a separate submit_homework tool after user confirmation.",
  "Exam drafts are allowed via save; exam formal submit is out of scope. No cookies/passwords.",
].join(" ");

const SUBMIT_HOMEWORK_DESCRIPTION = [
  "Formally submit answers for a homework/quiz todo. Explicit opt-in ONLY — call after the user confirms.",
  "Default workflow must use save_homework_answers (draft) first; do not submit without user confirmation.",
  "Args: todo_id; answers[{question_id, option_ids?, text?}]; optional paper_type; optional school_short_name.",
  "Posts mocQuizRpcBean.submitAnswers with preview=false. Refuses exam source todo_ids (考试代交不做).",
  "No cookies/passwords.",
].join(" ");

const answerItemSchema = z.object({
  question_id: z.string().describe("Question id from get_homework"),
  option_ids: z
    .array(z.string())
    .optional()
    .describe("Selected option id(s) for objective questions"),
  text: z.string().optional().describe("Free-text answer for subjective questions"),
});

export function createIcourse163McpServer(ports?: Icourse163Ports): McpServer {
  const server = new McpServer({
    name: "icourse163-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_todos",
    {
      title: "List 待办",
      description: LIST_TODOS_DESCRIPTION,
    },
    async () => {
      const result = await listTodos(ports);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: result.isError,
      };
    },
  );

  server.registerTool(
    "list_courses",
    {
      title: "List 已选课程",
      description: LIST_COURSES_DESCRIPTION,
    },
    async () => {
      const result = await listCourses(ports);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: result.isError,
      };
    },
  );

  server.registerTool(
    "list_term_units",
    {
      title: "List 课件目录",
      description: LIST_TERM_UNITS_DESCRIPTION,
      inputSchema: {
        course_id: z.string().describe("Course id from list_courses"),
        term_id: z.string().describe("Term id from list_courses"),
        school_short_name: z
          .string()
          .optional()
          .describe("Optional school shortName for learn Referer (e.g. SJTU)"),
      },
    },
    async (args) => {
      const result = await listTermUnits(
        {
          course_id: args.course_id,
          term_id: args.term_id,
          school_short_name: args.school_short_name,
        },
        ports,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: result.isError,
      };
    },
  );

  server.registerTool(
    "study_unit",
    {
      title: "Study video/audio/doc unit",
      description: STUDY_UNIT_DESCRIPTION,
      inputSchema: {
        course_id: z.string().describe("Course id from list_courses"),
        term_id: z.string().describe("Term id from list_courses"),
        unit_id: z.string().describe("Video/audio/doc unit id from list_term_units"),
        school_short_name: z
          .string()
          .optional()
          .describe("Optional school shortName for learn Referer (e.g. SJTU)"),
        playback_rate: z
          .number()
          .optional()
          .describe("Playback rate 0.5–2 (default 1); recorded with RPC progress"),
        page_interval_sec: z
          .number()
          .optional()
          .describe("Doc/PPT page-turn interval seconds 0–10 (default 1)"),
        skip_to_end: z
          .boolean()
          .optional()
          .describe(
            "Default true: seek straight to the end of the media. Fast, but the platform does not credit that progress. Set false to play through at playback_rate (takes duration/rate) so the learning is actually recorded.",
          ),
        transport: z
          .enum(["auto", "rpc", "playwright"])
          .optional()
          .describe(
            "auto (default): RPC then Playwright on -10006-like blocks; rpc: RPC only; playwright: browser path only",
          ),
      },
    },
    async (args) => {
      const result = await studyUnit(
        {
          course_id: args.course_id,
          term_id: args.term_id,
          unit_id: args.unit_id,
          school_short_name: args.school_short_name,
          playback_rate: args.playback_rate,
          page_interval_sec: args.page_interval_sec,
          skip_to_end: args.skip_to_end,
          transport: args.transport,
        },
        ports,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: result.isError,
      };
    },
  );

  server.registerTool(
    "get_homework",
    {
      title: "Get homework/quiz questions",
      description: GET_HOMEWORK_DESCRIPTION,
      inputSchema: {
        todo_id: z
          .string()
          .describe("list_todos id: course_id:term_id:quiz|unit|exam:content_id"),
        paper_type: z
          .enum(["quiz", "homework"])
          .optional()
          .describe("Force quiz vs homework paper RPC (default quiz)"),
        school_short_name: z
          .string()
          .optional()
          .describe("Optional school shortName for learn Referer"),
      },
    },
    async (args) => {
      const result = await getHomework(
        {
          todo_id: args.todo_id,
          paper_type: args.paper_type,
          school_short_name: args.school_short_name,
        },
        ports,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: result.isError,
      };
    },
  );

  server.registerTool(
    "save_homework_answers",
    {
      title: "Save homework/quiz draft answers",
      description: SAVE_HOMEWORK_DESCRIPTION,
      inputSchema: {
        todo_id: z.string().describe("list_todos id"),
        answers: z.array(answerItemSchema).describe("Answers keyed by question_id"),
        paper_type: z.enum(["quiz", "homework"]).optional(),
        school_short_name: z.string().optional(),
      },
    },
    async (args) => {
      const result = await saveHomeworkAnswers(
        {
          todo_id: args.todo_id,
          answers: args.answers,
          paper_type: args.paper_type,
          school_short_name: args.school_short_name,
        },
        ports,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: result.isError,
      };
    },
  );

  server.registerTool(
    "submit_homework",
    {
      title: "Submit homework/quiz (explicit)",
      description: SUBMIT_HOMEWORK_DESCRIPTION,
      inputSchema: {
        todo_id: z.string().describe("list_todos id (non-exam)"),
        answers: z.array(answerItemSchema).describe("Answers keyed by question_id"),
        paper_type: z.enum(["quiz", "homework"]).optional(),
        school_short_name: z.string().optional(),
      },
    },
    async (args) => {
      const result = await submitHomework(
        {
          todo_id: args.todo_id,
          answers: args.answers,
          paper_type: args.paper_type,
          school_short_name: args.school_short_name,
        },
        ports,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: result.isError,
      };
    },
  );

  return server;
}
