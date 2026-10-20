# 中国大学MOOC MCP（stdio）

本仓库根目录就是给 Grok Bot / Cursor 用的本机 stdio MCP。体验对齐 [K4F7/chaoxing-mcp](https://github.com/K4F7/chaoxing-mcp) / [K4F7/pu-mcp](https://github.com/K4F7/pu-mcp)：一个进程、stdio、凭据不进工具参数。

工具含 `list_todos`、`list_courses`、`list_term_units`、`study_unit`、`get_homework`、`solve_quiz`、`list_discussion_units`、`reply_discussion`、`save_homework_answers`、`submit_homework`、`session_status`。登录只走 CLI，见 [docs/login.md](login.md)。MCP 从不接收或返回 cookie / 密码。

产品目标对齐 OCS 学习自动化（自动看课、测验/作业辅助；**考试提交默认关闭，需显式开启**），详见仓库根 [README](../README.md)。答卷流水线：`read` → AI 填答 → **`save` 必调（草稿）** → 用户确认后才显式 `submit`（默认不交）。实现可用 RPC 或 DOM/Playwright（或混合），由后续 issue 细化。

## 安装

### Agent Plugin（local）

仓库根提供 Agent Plugins 1.0.0 最小壳：`plugin.json`、`mcp.json`（`command: ./scripts/run-mcp.sh`，`cwd: ${PLUGIN_ROOT}`）、`skills/login-config`。不发布 marketplace。

本地安装验证：

1. 将宿主插件根指向本仓库目录。
2. 在插件根执行 `npm ci`。
3. 按 [login.md](login.md) 或 skill `login-config` 用 CLI 登录（`npm run login`）；禁止在对话中收集密码 / cookie。
4. 启动后调用 `list_todos` 验证会话（`ok` 可为空；`auth_expired` 需重登）。

### npm

在仓库根：

```sh
npm ci
```

启动（`--silent` 避免 npm 把脚本横幅写进 stdout，否则会破坏 MCP JSON-RPC）：

```sh
npm start --silent
```

`package.json` 的 `start` 是 `node --import tsx src/stdio.ts`。stdin 保持打开时进程不应退出。

也可直接跑仓库里的包装脚本（自己 `cd` 到仓库根再 `exec`）：

```sh
/ABS/PATH/TO/icourse163-mcp/scripts/run-mcp.sh
```

## 挂到 Grok Bot / Cursor（AddMcpServer **没有 cwd**）

Grok Bot 的 AddMcpServer **不提供 cwd**，必须用绝对路径启动。不要依赖客户端帮你 `cd` 进仓库。把下面的 `/ABS/PATH/TO/icourse163-mcp` 换成本机仓库的真实绝对路径。不要把 cookie、账号或密码写进 MCP 配置或 `list_todos` 参数。先在仓库根 `npm run login`（cookie 文件或 Playwright 环境变量），确认 `LOGIN_OK has_cookie=true` 后再挂 MCP。

### 方式 A：绝对路径包装脚本（推荐）

command = `scripts/run-mcp.sh` 的绝对路径，args 为空。

```json
{
  "command": "/ABS/PATH/TO/icourse163-mcp/scripts/run-mcp.sh",
  "args": []
}
```

Cursor `mcpServers`：

```json
{
  "mcpServers": {
    "icourse163": {
      "command": "/ABS/PATH/TO/icourse163-mcp/scripts/run-mcp.sh",
      "args": []
    }
  }
}
```

Grok Bot user-scope TOML：

```toml
[mcp_servers.icourse163]
command = "/ABS/PATH/TO/icourse163-mcp/scripts/run-mcp.sh"
args = []
startup_timeout_sec = 60
```

### 方式 B：`npm start --silent --prefix`（绝对路径）

command = `"npm"`。`--prefix` 必须是仓库根的绝对路径；`--silent` 必填，避免 npm 横幅破坏 stdout 上的 JSON-RPC。

```json
{
  "command": "npm",
  "args": ["start", "--silent", "--prefix", "/ABS/PATH/TO/icourse163-mcp"]
}
```

Cursor：

```json
{
  "mcpServers": {
    "icourse163": {
      "command": "npm",
      "args": ["start", "--silent", "--prefix", "/ABS/PATH/TO/icourse163-mcp"]
    }
  }
}
```

```toml
[mcp_servers.icourse163]
command = "npm"
args = ["start", "--silent", "--prefix", "/ABS/PATH/TO/icourse163-mcp"]
startup_timeout_sec = 60
```

## 和仓库根 `.grok/config.toml` 的区别

本机从**仓库根**启动的 grok（cwd = repo root）可以用相对形式，不必写绝对路径：

```toml
[mcp_servers.icourse163]
command = "npm"
args = ["start", "--silent"]
startup_timeout_sec = 60
```

Grok Bot AddMcpServer 没有 cwd，必须用上面的绝对路径脚本或 `--prefix /ABS/PATH/TO/icourse163-mcp`。

## `session_status`

- 报告本机会话能否使用、以及哪些 transport 可用。**只读**：不写进度，也不请求 `/learn/`（那可能触发登出，反而弄坏一个正常的会话）。
- 返回：`stored`（本地有会话）、`cookies`（`ntesstudysi` / `study_info` / `study_sess` 是否存在，以及 cookie 总数）、`api`（一次鉴权读取的结果）、`course_count`、`web_session_markers`、`guidance`。
- **`web_session_markers` 只表示两个网页会话 cookie 是否存在，不代表浏览器路径真的能用。** 实测反例：
  - 两个标记**都在**，`/learn/` 仍被 302 到 `/passport/member/logout.htm`（纯 HTTP 登录得到的会话就是这种）
  - 登录流程的持久化 Chrome profile **两个标记都没有**（无 `STUDY_SESS`、无 `NTESSTUDYSI`），却能正常打开 `/learn/`
  
  所以这个字段**刻意不叫** `browser_path_ready`。真正的探测方式是请求 `/learn/`，但那会命中登出接口、可能反过来弄坏可用会话，因此没有采用。
- 关键区分（这是本项目最容易误判的状态）：
  - 只有 `NTESSTUDYSI` → **API 调用与签名 RPC 路径可用**，但 Playwright 路径不可用。因为网页会话缺失时，普通 HTML 请求会被弹离 `/learn/`，于是 `list_courses` 一切正常而 `study_unit` 报「找不到视频元素」。
  - `STUDY_INFO` + `STUDY_SESS` 齐全 → 两条路径都可用。
- `status: ok` = 可用；`auth_expired` = 需要 `npm run login`；
  **`stale`** = 体检通过但**一门课都没有**（半死会话：目录 RPC 返回 `code 0` + `result null`，
  所有基于目录的工具都会失败）→ 同样要重新登录。`api` 字段在 `stale` 时也是 `stale`。
- 签名写入路径（`saveMocContentLearn`）本身不在这里验证 —— 它需要一次写入，见 `npm run check:rpc`。
- 不要传账号或 cookie；工具也不返回它们。

## `list_todos`

- 列出中国大学MOOC（icourse163.org）仍开放的待办（未完成 / 未交 / 可作答的作业、测验、考试）。
- 每条含 `id`、`title`、`course_title`、`due_at`（ISO `+08:00` 或 `null`）、`kind`（作业 / 测验 / 考试）。`id` 形如 `course_id:term_id:quiz|unit|homework|exam:catalog_id`（含章节作业 `homeworks[]`）。
- `status: ok` 且 `todos` 为空表示确实没有开放待办，不是失败。
- `auth_expired` 以及其他失败都是 `isError`，不会伪装成「没有作业」。
- stdio 使用本机会话存储与 HTTP 客户端：先 `probeSession`，再拉课程面板（MOOC+SPOC 分页）和每门课的 `getLastLearnedMocTermDto`（Referer 必须是 `learn/{school}-{courseId}?tid={termId}`）。
- 不要传账号或 cookie；工具也不返回它们。登录、确认、清除会话见 [docs/login.md](login.md)。

## `list_courses`

- 列出已选课程（MOOC + SPOC 分页，与 `list_todos` 同一课程面板 RPC）。
- 每条含 `id`、`name`、`school`、`type`（`mooc`|`spoc`）、`term_id`。
- `status: ok` 且 `courses` 为空表示确实没有已选课。
- `auth_expired` 以及其他失败都是 `isError`。
- 不要传账号或 cookie。

## `list_term_units`

- 入参：`course_id`、`term_id`，可选 `school_short_name`（拼 learn Referer）。
- 返回 lesson → unit 课件树；单元 `type` 为 `video`|`doc`|`quiz`|`other`（由官方 `contentType` 映射：1→video，3/4→doc，5→quiz，其余→other）。
- 章级 `quizs` 会作为 `quiz` 课节出现。若 RPC 带学习信号（如 `hasLearned` / `evaluateStatus`），填入 `learn_status`，否则为 `null`。
- 使用官方 `getLastLearnedMocTermDto` RPC（非 Playwright）。不代答、不代交；测验读写见后续 issue。
- `auth_expired` 为 `isError`。不要传账号或 cookie。

## `study_unit`

- Args: `course_id`, `term_id`, `unit_id` (from `list_courses` / `list_term_units`); optional `school_short_name`; optional `playback_rate` (0.5–2, default 1); optional `page_interval_sec` (0–10, default 1) for doc/PPT page-turn pacing (align OCS `readSpeed`); optional `transport` (`auto`|`rpc`|`playwright`, default `auto`).
- **Transports**:
  - `rpc`: resolve unit in `getLastLearnedMocTermDto`, optional `getLessonUnitLearnVo`, then `saveMocContentLearn` (same cookie/csrf/Referer pattern as other tools).
  - `playwright`: open the learn unit URL in system Chrome (same channel/`ICOURSE163_CHROME` pattern as CLI login), inject the stored session cookie, then align OCS `watchMedia` / `readPPT` (DOM playback / PDF next-page clicks). Does **not** call `saveMocContentLearn`.
  - `auto` (default): try RPC first; on `-10006` / `本地时间` / `并发限制` style save failures, fall back to Playwright.
- **Catalog duration**: video units often expose `durationInSeconds` (seconds). `study_unit` reads that field so the RPC path can proceed without a successful learnVo.
- **learnVo fallback (RPC)**: if `getLessonUnitLearnVo` fails (e.g. `code=-1 系统异常`) but the catalog already has `contentId` + duration, RPC save still proceeds. Missing both catalog duration and learnVo → `page_structure_change` (use `transport=playwright` to try the browser path anyway).
- Success: `status: "ok"`, `completed: true`, `learned_sec` / `duration_sec` / `percent` for video; `page_count` / `page_interval_sec` / `percent` for doc; `transport: "rpc"` or `"playwright"`; Playwright results also include `nav_strategy` and `course_kind`.
- Distinct failures (`isError`):
  - `non_media_unit` — unit is quiz/other (not video/audio/doc)
  - `auth_expired` — missing/expired session
  - `page_structure_change` — unit missing from catalog, or learnVo/save/DOM structure unparseable
  - `needs_quiz_assist` — Playwright saw a video popup quiz (`.u-questionItem`); **never silent-submit**. Use `get_homework` → AI → `save_homework_answers`, then retry `study_unit`.
  - `error` — including RPC business failures when `transport=rpc`, or Playwright/Chrome failures
- **API blocker (`saveMocContentLearn` `-10006`)**: live RPC may return `code=-2` with `请检查本地时间是否和北京时间一致-10006` (sometimes `并发限制`). OCS advances media via Playwright DOM, not this RPC. With default `transport=auto`, `study_unit` falls back to Playwright when this happens.
- **Live smoke (2026-09-21 CST+8, non-school kaopei `1473617163` / unit `1303386815`)**: **PASS** via Playwright. Navigation is OCS-aligned: warm `/learn/...` → wait for 课件 → dismiss `.ant-modal-wrap` → click `[data-cid=unitId]` in the 课件 outline → seek near end → wait for `ended`/near-end. Result: `completed=true`, `transport=playwright`, `nav_strategy=tree_click`, `course_kind=non_school`, `percent=100` (~8369s duration). Blind hash deep-links remain **fallback only**. Popup quizzes still stop with `needs_quiz_assist` (never silent-submit).

- **Chrome dependency (Playwright path)**: needs Google Chrome / Chromium (`playwright-core` `channel: "chrome"`, or `ICOURSE163_CHROME`). Headless when no usable display unless `ICOURSE163_STUDY_HEADED=1`. Long media seeks near the end by default (`seek_near_end`) so automation can finish; set seek off only in custom runners.
- **Video popup quizzes**: not auto-answered or silently submitted.
- **Limits / detection risk**: both RPC progress reports and automated DOM playback/page-turns may be flagged. Use only on accounts you own. Do not pass cookies/passwords. Login remains CLI-only (`npm run login`); MCP never accepts passwords.
- Never pass accounts or cookies.

## `study_course`

- **T1：一条命令跑完整门课，模型不在循环里。** 读目录 → 对每个未完成单元：媒体报进度、
  随堂测试用试卷自带答案、讨论回复一句固定内容 → 复查完成度。
- **默认真的会跑**（`dry_run` 默认 false）。三个刹车：`max_units`（默认 400）、
  `include`（只跑 media/quiz/discussion 之一）、`delay_ms`（默认 800，单元间节流）。
- **讨论默认回 `"1"`** —— 使用者的明确选择（T1 里没有模型生成内容）。可用
  `discussion_content` 覆盖。注意：回复长度**不影响耗时**（实测），所以这只影响观感。
- **没有答案的测验跳过而不是猜。** 章节测验不泄露答案，没有题库时返回
  `skipped_no_answer` 并计入 notes —— 猜会消耗作答次数、拉低分数，且**不推进任何进度**。
- **讨论需要浏览器会话**（`login` 工具写入）。没有时标 `skipped_no_session`，
  其余部分照常跑完，不会让整门课失败。
- **不碰单元作业**（需要有人写正文）与**考试**（默认关闭）。
- 返回体很小：实测 285 单元的课程，计划阶段 **368 字节**（`verbose:true` 才给逐项，2,367 字节）。
- 失败项永远在 `failures[]` 里返回；单测被 `max_units` 截断时会在 `notes` 里说明。

## `get_homework`

- 入参：`todo_id`（来自 `list_todos`，格式 `course_id:term_id:quiz|unit|homework|exam:content_id`）；可选 `paper_type`（`quiz`|`homework`；默认按来源推断，`homework`→作业卷，其余→测验卷）；可选 `school_short_name`。
- **读卷范围**：章节测验（`chapters.quizs`）、旧版单元测验（`contentType==5`）、章节作业（`chapters.homeworks`）、考试（可读题）。先经 `getLastLearnedMocTermDto` 把目录 id 解析为试卷 `tid`（`contentId` / `test.id`）；目录 id ≠ 试卷 tid。
- 返回结构化题目：`stem_text`、选项 `options[]`、`type` / `type_label`、`supports_save`。`draft_only: true` 提醒后续必须草稿保存。
- 清晰错误：`not_found`（目录无此 id）、`unsupported`（缺 contentId）、`incomplete`（mocTermDto 不可用时**禁止**用目录 id 冒充 tid）、`auth_expired`；`code:0 result:null` 时提示 tid 可能未解析到试卷 contentId。
- RPC：`mocQuizRpcBean.getOpenQuizPaperDto` / `getOpenHomeworkPaperDto`（可 mock）；遇并发限制短重试。
- **流水线**：`get_homework`（读题）→ AI 填答 → **`save_homework_answers` 必调（草稿）** → 用户确认后才显式 `submit_homework`。默认不交。
- 考试：可读题、可存草稿；正式提交需显式 `allow_exam: true`（默认拒绝）。不要传账号或 cookie。

## `save_homework_answers`

- **草稿保存（必调）**。内部调用 `mocQuizRpcBean.submitAnswers` 且 **强制 `preview: true`**，`submitted` 恒为 `false`。
- 入参：`todo_id`；`answers[{ question_id, option_ids?, text? }]`；可选 `paper_type` / `school_short_name`。
- 拒绝任何夹带的 `submit: true` 或 `preview: false`（防止从 save 误交）。
- 部分 type=6 测验平台会拒绝 preview（「预览不能提交！」）——此时返回明确错误「本试卷不支持草稿预览保存」，并引导显式 `submit_homework`；**从不**静默改成正式提交。
- 正式提交必须另调 `submit_homework`，且仅在用户确认后。考试也可草稿保存，但不可正式代交。

## `submit_homework`

- **显式正式提交（opt-in）**。仅在用户确认后调用；默认工作流只用 `save_homework_answers`。
- 内部 `submitAnswers` 且 **`preview: false`**。`source=exam` 的 `todo_id` **默认**返回 `exam_out_of_scope`；显式传 `allow_exam: true` 才放行。
- 为什么默认关：考试通常只有一次机会、不可撤回，且试卷可能带 `allowSwitchPageCount` 反作弊计数（实测本课程期末考试该值为 0）。开启即你自担风险。
- 入参同 save。不要传账号或 cookie。

## `solve_homework`

- **单元作业**的流水线封装。作业卷实测形态：**1–2 道主观论述题、无选项、`bank=subjective`**
  （例：「田径运动的主要功能是什么？」），所以题库完全无用 —— 正文必须由调用方提供。
- 三态调用，全由调用方决定：
  | 调用 | 行为 |
  |---|---|
  | 只传 `todo_id` | **只读题**，返回题目清单，不写任何东西 |
  | 传 `answers`（不传 `submit`） | **只存草稿**（`preview:true`）—— 默认 |
  | 传 `answers` + `submit: true` | **正式提交**（`preview:false`） |
- **有题没答就整卷不写**：返回 `status:"incomplete"` + `missing[]`（含题目 id 与题干摘要），
  一个写请求都不发。避免交半成品。
- `draft_saved` 是实测值：部分卷子会拒绝草稿（非 0 code + 「预览不能提交」），此时返回
  `status:"draft_rejected"` 并提示"要交就显式 `submit: true`"，**绝不**静默改成正式提交。
- 回答 ≠ 生成：它**不会替你写内容**。`solve_quiz` 遇到 `type=10` 会直接跳过（实测已答 0），
  这是刻意的。
- 入参：`todo_id`；`answers[{question_id, text?, option_ids?}]`；可选 `submit`、`paper_type`、
  `school_short_name`、`allow_exam`（默认 false，与 `submit_homework` 同一道闸门）。

## 答题方式：`answer_mode`（四个工具都认）

**显式选择，不做模糊优先级。** 每道题的来源写在 `source` 里，便于审计。

| `answer_mode` | 谁来答 | 会不会查题库 | `source` |
|---|---|---|---|
| `paper` | **平台自带答案**（随堂测试在提交前就返回正确选项与填空答案） | ❌ **不查** | `"paper"` |
| `tiku` | **题库**（忽略试卷自带的答案） | ✅ 只查题库 | `"tiku"` |
| `agent` | **调用方传入**（工具完全不猜；不给 `answers` 就只返回题目） | ❌ 不查 | `"agent"` |
| `auto`（默认） | `paper` 优先，剩下的才查题库 | ✅ 兜底 | `"paper"` / `"tiku"` |

- `solve_quiz` / `study_course` 支持 `paper|tiku|agent|auto`；`study_course` 只透传 `paper|tiku|auto`（批量里没有 agent 这一档）。
- `solve_homework` 只接受 `agent` —— 作业是主观论述题，题库无法作答、试卷也不泄露答案。传 `tiku` 会返回 `unsupported` 而不是假装试一下。
- 实测同一张随堂测试：`paper` 答 3/3（来源全 `paper`）；`tiku` 答 **0/3** —— 即使试卷自带答案也**一个都不用**；`agent` 不给答案时返回 `status: "questions"`。

## `solve_quiz`

- 两段式作答：**先用试卷自带的答案**，剩下的才问题库。默认 **dry run**（`submit` 必须显式传 true）。
- 单元级随堂测试（`contentType=5`）在提交前就返回 `optionDtos[].answer` 与填空题的 `stdAnswer`
  （`showAnalysis:false` 只是界面不显示）。章节测验**不**返回，所以只有它们需要题库。
- 入参：`todo_id`；可选 `tiku_config`（OCS `AnswererWrapper` 兼容的 JSON 数组）、
  `submit`（默认 false）、`min_coverage`（默认 0.8）、`paper_type`、`school_short_name`。
- 拒绝提交的情形：没有答案且没有题库、命中率低于 `min_coverage`、目录显示作答次数已用完、`exam` 来源。
- 题库**收不到任何 cookie**：走独立 fetch（`credentials: omit`），不走带会话的 HTTP 客户端。
- `attempts` 即使 dry run 也会返回 —— 调用方要靠它决定是否花掉一次机会。随堂测试没有次数字段，如实返回 null。

## `login`

- **弹出一个有头 Chrome**，让用户自己在窗口里登录 icourse163，然后提取并保存会话。
  调用会**阻塞**到登录完成或超时（默认 180000 ms，可用 `timeout_ms` 调）。
- **不接受账号、密码、cookie 参数** —— 这是硬约束。MCP 参数必须先由模型产出，
  密码一旦作为参数传入就会进入模型上下文与会话记录；这个工具反过来把输入交给浏览器，
  密码只存在于浏览器进程里。
- 成功时保存两级会话：
  1. URS 会话（刷课/读题/交卷用，`/web/j/*.rpc` 认它）
  2. **完整 cookie header** → `browser-session`（讨论区用，新版 API 只认它）
- 用的是持久化 profile，**已登录时几乎立即返回**，不会真的等人。
- 返回字段只有 `ok` / `status` / `browser_session_saved_to` / `message`，**永远不含 cookie**。
- 失败时按 `describeLoginFailure` 给出可读原因（如站点处于短信/扫码模式）。
- 前提：本机有 Chrome（或设 `ICOURSE163_CHROME`）。无头环境用不了这个工具，用 `npm run login`。

## `list_discussion_units`

- 只读。走**新版 Next.js API**（`/front-mooc-learn/api/learn/*`），**不是** `/api/learn/*`（那个 404）。
- 鉴权：读 `~/.config/icourse163-mcp/browser-session` 或 `ICOURSE163_BROWSER_COOKIE`。
  这份文件可以由 **`login` 工具自动写入**（有头浏览器），不需要手工复制。
  **不认** `npm run login` 的 URS 会话（那份对这些端点必然 401），也不会回退过去。
- 入参：`course_id`、`term_id`、可选 `school_short_name`。
- 返回每个讨论单元的 `unit_id`、`lesson_id`、`content_id`（**就是老师创建的主题 id**）、
  `view_status`、`complete_percent`、`completed`。
- 注意：`content-outline` **不返回 `completePercent`**，完成状态在 `viewStatus`
  （`completed` / `not-viewed`）。`completed` 两个信号都认。

## `reply_discussion`

- **回复该单元自己的主题** —— 这一步就是完成该任务点：实测 `completePercent` 0→1、
  `viewStatus` 0→5，一次调用，不需要额外进度上报。
- **新建帖子不行**：`createOrUpdatePost` 即使带 `lessonUnitId`，服务端也会丢弃该字段（读回是
  `null`），任务点不动。不要用它刷任务点。
- 调用方只传 `unit_id`；`content_id` 由服务器从 `content-outline` 自己解析，避免传错。
- 单元已完成时返回 `already_complete` 并**拒绝重发** —— 回复是公开内容，不能重复留痕。
- 入参：`course_id`、`term_id`、`unit_id`、`content`（要针对该主题，不要灌水）、可选 `school_short_name`。
- 状态码：`ok`、`already_complete`、`no_session`（cookie 缺失或 401）、`unit_not_found`、
  `not_a_discussion`、`http_error`、`rejected`（内容为空）。
