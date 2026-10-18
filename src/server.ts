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
import { sessionStatus } from "./session-status";
import { createBrowserSessionStore, listDiscussionUnits, replyDiscussion } from "./discussion";
import { interactiveBrowserLogin } from "./open-login";
import { createLocalCredentialStore } from "./credentials";
import { solveHomework } from "./solve-homework";
import { solveQuiz } from "./solve-quiz";
import { studyUnit } from "./study-unit";

const SESSION_STATUS_DESCRIPTION = [
  "Report whether the stored 中国大学MOOC session can be used, and by which transport.",
  "Returns: stored (a session exists locally), cookies (ntesstudysi / study_info / study_sess present), api (an authenticated read succeeded), course_count, web_session_markers, and a guidance string.",
  "Read-only: it never writes progress and never requests /learn/ (which can trigger a logout and invalidate a working session).",
  "Use it before a batch when tools are failing, to tell an expired or API-only session apart from a code problem.",
  "Key distinction: NTESSTUDYSI alone means API calls and the signed RPC path work. web_session_markers reports whether both web-session cookies exist, but that is only a marker check, NOT proof the Playwright path works: both markers have been observed present while /learn/ still bounced to the logout endpoint, and a logged-in Chrome profile opened /learn/ while carrying neither STUDY_SESS nor NTESSTUDYSI. To use transport=playwright, log in through the browser.",
  "status ok means usable; auth_expired means run `npm run login`; the signed-write path itself is covered by `npm run check:rpc`.",
  "Do not pass accounts or cookies; this tool never returns them.",
].join(" ");

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
  "Args: course_id, term_id, unit_id from list_courses / list_term_units; optional school_short_name; optional playback_rate (0.5–2, default 1); optional page_interval_sec (0–10, default 1) for doc/PPT; optional report_chunk_sec (RPC only, default 0 = one completion report; positive = report that many seconds per signed request, paced by chunk/playback_rate of real time so the platform sees incremental progress instead of a single jump); optional transport (auto|rpc|playwright, default auto).",
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
  "Posts mocQuizRpcBean.submitAnswers with preview=false. Exam source todo_ids are REFUSED unless allow_exam:true is passed explicitly (default OFF).",
  "For a unit-source quiz (a 随堂测试 that is its own unit) it ALSO reports that unit's task point via saveMocContentLearn contentType=5, because submitAnswers alone grades the paper without marking the outline entry done; the result then carries task_point: marked|failed|skipped.",
  "No cookies/passwords.",
].join(" ");

const LOGIN_DESCRIPTION = [
  "Open a VISIBLE Chrome window on the user's desktop and let THEM log in to icourse163 there. Then extract the session and save it.",
  "This tool deliberately takes no username or password. MCP arguments must be produced by the model, so a password passed here would enter the model context and the transcript; instead the typing happens inside the browser and never reaches this process.",
  "On success it stores two things: the URS session (used by the study/quiz tools) and the full browser cookie header (needed by the discussion tools, which reject the URS session).",
  "The browser uses the persistent profile, so if that profile is already logged in the call returns almost immediately without interaction.",
  "The call blocks until login completes or times out, and the returned payload never contains the cookie. Args: timeout_ms (default 180000).",
].join(" ");

const DISCUSSIONS_DESCRIPTION = [
  "List the discussion units of a course/term (read-only).",
  "Uses the site's newer Next.js API (/front-mooc-learn/api/learn/*), which requires a BROWSER login cookie — the npm run login session is rejected by it with 401. The cookie is read from ~/.config/icourse163-mcp/browser-session or ICOURSE163_BROWSER_COOKIE; tools never take cookies or passwords as arguments.",
  "Args: course_id; term_id; optional school_short_name.",
  "Returns each unit's unit_id, lesson_id, content_id (which is the teacher's topic id) and complete_percent.",
].join(" ");

const REPLY_DISCUSSION_DESCRIPTION = [
  "Reply to a discussion unit's own topic. On this platform that reply IS what completes the unit: measured completePercent 0→1 and viewStatus 0→5 in a single call, with no extra progress report.",
  "Creating a standalone post does NOT work even when lessonUnitId is supplied — the server drops that field and returns null — so do not use it for task points.",
  "Refuses when the unit is already complete, because replies are public content and must not be duplicated. Resolves content_id from the course outline itself; callers only pass unit_id.",
  "Same auth requirement as list_discussion_units: a browser login cookie, never the npm run login session.",
  "Args: course_id; term_id; unit_id; content (the reply text, must be specific to that topic, not filler).",
].join(" ");

const SOLVE_HOMEWORK_DESCRIPTION = [
  "Pipeline for 单元作业 / subjective homework: read the paper, validate that every question has an acceptable answer, then either save a draft or submit.",
  "Homework on this platform is 1-2 essay questions with no options (type 10, bank subjective), so a question bank cannot help — the text must come from the caller. This tool does not invent answers; it refuses when any question is unanswered and reports exactly which ones.",
  "Call it with todo_id only to get the question list; call it again with answers to write. `submit` is the user's choice: omitted or false saves a draft, true submits formally. Drafts are the safer default because some papers reject them and some cannot be undone.",
  "Args: todo_id; answers[{question_id, text?, option_ids?}]; optional submit, paper_type, school_short_name, allow_exam (default false).",
].join(" ");

const SOLVE_QUIZ_DESCRIPTION = [
  "Read a quiz/homework paper, query a question bank for each question, and optionally submit.",
  "Read + submit are verified over plain HTTP (no browser, no request signing). Session cookies never leave for the bank: the bank call uses a separate fetch with credentials omitted.",
  "Args: todo_id (from list_todos); tiku_config (JSON array of OCS AnswererWrapper entries); optional submit (default FALSE), min_coverage (default 0.8), paper_type, school_short_name.",
  "Default behaviour is a dry run: it returns every question with the bank's answer, the matched option ids and the coverage, and writes nothing. Submission happens only with submit:true AND coverage >= min_coverage.",
  "Exam source todo_ids are refused unless allow_exam:true is passed explicitly (default OFF). Reports attempts read from the course catalog (used/limit/timed) and refuses when attempts are exhausted; note unit-level 随堂测试 have no attempt fields at all, so that check cannot apply to them.",
  "Objective questions (single/multiple/judgement) are answerable from a bank. Subjective questions are skipped: their type maps to unknown and the result says so, because a bank cannot answer an essay.",
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

  // 讨论区走的是新版 API，只认浏览器登录的会话 —— 与工具自己的 URS 会话分开存放。
  const browserSession = createBrowserSessionStore();

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
    "session_status",
    {
      title: "Session status",
      description: SESSION_STATUS_DESCRIPTION,
    },
    async () => {
      const result = await sessionStatus(ports);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: result.isError,
      };
    },
  );

  server.registerTool(
    "login",
    {
      title: "Log in via a visible browser (no password argument)",
      description: LOGIN_DESCRIPTION,
      inputSchema: {
        timeout_ms: z
          .number()
          .optional()
          .describe("How long to wait for the user to finish logging in (default 180000). The call blocks until then."),
      },
    },
    async (args) => {
      const result = await interactiveBrowserLogin({
        credentials: createLocalCredentialStore(),
        browserSessionPath: browserSession.path,
        env: process.env,
        platform: process.platform,
        timeoutMs: args.timeout_ms,
      });
      // 绝不让 cookie 进入返回值/日志。
      const payload = {
        ok: result.ok,
        status: result.ok ? ("ok" as const) : ("failed" as const),
        browser_session_saved_to: result.browserSessionPath,
        message: result.message,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: { ...payload },
        isError: !result.ok,
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
        report_chunk_sec: z
          .number()
          .optional()
          .describe(
            "RPC transport only. 0 (default) sends one completion report (~1.4s/unit), which shows up as a single 0->100 jump. A positive value reports that many seconds per signed request, spaced by chunk/playback_rate of real time, so the platform sees the incremental progress a real player produces. Costs the real time by design: 10 minutes of video at chunk 60 with playback_rate 2 takes about 5 minutes. The platform credits a report only when videoTime advances, so chunks must be at least 5s.",
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
          report_chunk_sec: args.report_chunk_sec,
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
        allow_exam: z
          .boolean()
          .optional()
          .describe(
            "Default false. Exam submission stays OFF unless this is explicitly true. Exams usually allow one attempt, cannot be undone, and may carry anti-cheat counters (allowSwitchPageCount). Drafts are unaffected.",
          ),
      },
    },
    async (args) => {
      const result = await submitHomework(
        {
          todo_id: args.todo_id,
          answers: args.answers,
          paper_type: args.paper_type,
          school_short_name: args.school_short_name,
          allow_exam: args.allow_exam,
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
    "solve_quiz",
    {
      title: "Answer a quiz from a question bank (opt-in submit)",
      description: SOLVE_QUIZ_DESCRIPTION,
      inputSchema: {
        todo_id: z.string().describe("list_todos id (non-exam)"),
        tiku_config: z
          .string()
          .optional()
          .describe(
            "Question-bank config as JSON: an array of {url,name?,method?,contentType?,headers?,data?,handler}, OCS AnswererWrapper compatible. Placeholders ${title} ${type} ${options} are substituted; handler is evaluated as `return (res) => [question, answer]`.",
          ),
        submit: z
          .boolean()
          .optional()
          .describe(
            "Default false. Only true actually submits, and only when coverage >= min_coverage. Submitting spends a real attempt; for a 随堂测试 the draft step does not exist at all.",
          ),
        min_coverage: z.number().optional().describe("Minimum answered ratio to allow submit (default 0.8)"),
        paper_type: z.enum(["quiz", "homework"]).optional(),
        school_short_name: z.string().optional(),
        allow_exam: z
          .boolean()
          .optional()
          .describe(
            "Default false. Exam answering/submission stays OFF unless explicitly true; submit:true and min_coverage still apply on top of it.",
          ),
      },
    },
    async (args) => {
      const result = await solveQuiz(
        {
          todo_id: args.todo_id,
          tiku_config: args.tiku_config,
          submit: args.submit,
          min_coverage: args.min_coverage,
          paper_type: args.paper_type,
          school_short_name: args.school_short_name,
          allow_exam: args.allow_exam,
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
    "solve_homework",
    {
      title: "Read/answer a subjective homework (draft by default)",
      description: SOLVE_HOMEWORK_DESCRIPTION,
      inputSchema: {
        todo_id: z.string().describe("list_todos id with kind 作业"),
        answers: z
          .array(answerItemSchema)
          .optional()
          .describe("Omit to only read the questions. Subjective questions need text."),
        submit: z
          .boolean()
          .optional()
          .describe("false/omitted = save a draft (default); true = submit formally. The user decides."),
        paper_type: z.enum(["quiz", "homework"]).optional(),
        school_short_name: z.string().optional(),
        allow_exam: z.boolean().optional().describe("Default false; same gate as submit_homework."),
      },
    },
    async (args) => {
      const result = await solveHomework(
        {
          todo_id: args.todo_id,
          answers: args.answers,
          submit: args.submit,
          paper_type: args.paper_type,
          school_short_name: args.school_short_name,
          allow_exam: args.allow_exam,
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
    "list_discussion_units",
    {
      title: "List discussion units (needs browser session)",
      description: DISCUSSIONS_DESCRIPTION,
      inputSchema: {
        course_id: z.string().describe("Course id, e.g. 1449647163"),
        term_id: z.string().describe("Term id, e.g. 1488389457"),
        school_short_name: z.string().optional().describe("School short name, e.g. CUPES"),
      },
    },
    async (args) => {
      const result = await listDiscussionUnits(
        { course_id: args.course_id, term_id: args.term_id, school_short_name: args.school_short_name },
        { browserCookie: () => browserSession.getCookie() },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: result.isError,
      };
    },
  );

  server.registerTool(
    "reply_discussion",
    {
      title: "Reply to a discussion unit's topic",
      description: REPLY_DISCUSSION_DESCRIPTION,
      inputSchema: {
        course_id: z.string().describe("Course id"),
        term_id: z.string().describe("Term id"),
        unit_id: z.string().describe("Discussion unit id (contentType 6)"),
        content: z.string().describe("Reply text, specific to that unit's topic"),
        school_short_name: z.string().optional().describe("School short name"),
      },
    },
    async (args) => {
      const result = await replyDiscussion(
        {
          course_id: args.course_id,
          term_id: args.term_id,
          unit_id: args.unit_id,
          content: args.content,
          school_short_name: args.school_short_name,
        },
        { browserCookie: () => browserSession.getCookie() },
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
