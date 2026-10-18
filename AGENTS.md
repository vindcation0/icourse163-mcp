# AGENTS.md

This is a Node/TypeScript **stdio MCP** for 中国大学MOOC ([icourse163.org](https://www.icourse163.org)). Issues live in [K4F7/icourse163-mcp](https://github.com/K4F7/icourse163-mcp).

> **READ [`docs/STATUS.md`](docs/STATUS.md) FIRST.** It is the handoff entry point: what is
> verified (everything below is now live-tested, not speculation), what is missing, the hard
> facts you must not re-derive, and the list of actions that damage real course data.
> Two facts that contradict older text in this file:
> **`submitAnswers` does NOT need a signature** (verified 8/8), and
> **`preview:true` is NOT universal** — some papers reject drafts and can only be submitted.
> Priority order and costs: [`docs/ROADMAP.md`](docs/ROADMAP.md).

- Start: `npm start` (`node --import tsx src/stdio.ts`). Do not put secrets, cookies, or passwords in tools, tests, or docs.
- Login is CLI-only (`npm run login`). MCP tools never accept passwords or cookies.
- `list_todos` fetches open 待办 via course-panel + mocTermDto RPCs. `status: ok` with empty todos means truly none open; `auth_expired` and other failures are `isError`.
- `list_courses` lists enrolled MOOC/SPOC courses (`id`, `name`, `school`, `type`, `term_id`).
- `list_term_units` returns lesson → unit catalog (`type`: video|doc|quiz|other, optional `learn_status`) for a course/term.
- `study_unit` advances video/audio/doc (PPT) progress via saveMocContentLearn RPC and/or Playwright DOM (OCS watchMedia/readPPT). Default `transport=auto` falls back to Playwright on -10006-like RPC blocks; optional `transport=rpc|playwright`, `playback_rate`, `page_interval_sec`. Statuses include `needs_quiz_assist` (never silent-submit popups). Detection risk documented in docs/mcp.md.
- Homework/quiz assist pipeline: `get_homework` (read; resolves catalog id → paper `contentId` tid for unit/quiz/homework/exam) → fill answers → `save_homework_answers` (draft, `preview=true`) → user confirms → explicit `submit_homework` (`preview=false`). Never implicit submit. Exam 代交 out of scope (`submit_homework` refuses exam todo ids).
  **Verified 2026-10-18:** the draft step is *not* universally supported — some papers answer `status:"rejected"` with "本试卷不支持草稿预览保存" even when the paper reports `supports_save:true`, and for those the only path is a formal submit. So branch on the actual `rejected` response, not on the pre-read field, and treat "no draft state" as requiring explicit user confirmation. Matching answers: look up `options[].content` and take that option's `id`; never hardcode option order.
