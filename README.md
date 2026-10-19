# icourse163-mcp

中国大学MOOC（[icourse163.org](https://www.icourse163.org)）的本机工具。**推荐通过 AI agent 调用**：
14 个 MCP 工具覆盖登录、刷课、读题、答题提交、单元作业、讨论区，外加**一条命令跑完整门课**。

命令行入口（`mooc.py` / `mooc.exe`）**已经把全部能力都接进来了**（刷课、测验、作业、讨论、一键跑完），
交互式菜单也能用 —— 见[第 2 节](#2-备选命令行moocpy--moocexe)。

> 技术原理、逆向过程与开发交接**不在本页**，都在仓库里：[docs/STATUS.md](docs/STATUS.md)（接手入口：
> 现状 / 已验证边界 / 硬事实）、[docs/mcp.md](docs/mcp.md)（工具契约）、[docs/ROADMAP.md](docs/ROADMAP.md)
> （优先级与代价）、[docs/HANDOFF.md](docs/HANDOFF.md)（交接报告）、[docs/adr/](docs/adr/)（架构决策与逆向证据）。

---

# 一、使用方式

## 1. 推荐：通过 AI agent 调用（MCP）

### 1.1 挂载

```bash
npm ci
npm start --silent          # --silent 必须：npm 横幅会写进 stdout，破坏 JSON-RPC
```

本仓根有 Agent Plugins 1.0.0 最小壳（`plugin.json` + `mcp.json` + `skills/login-config`），
宿主支持本地插件根时把插件根指向本仓库绝对路径即可。

有些客户端（Grok Bot / Cursor 的 `AddMcpServer`）**没有 cwd**，必须用绝对路径启动：
Windows 用 `scripts/run-mcp.cmd`，POSIX 用 `scripts/run-mcp.sh`。

### 1.2 先登录一次

| 方式 | 怎么做 | 适用 |
|---|---|---|
| **让 agent 调 `login` 工具**（推荐） | 弹出**有头 Chrome** → 你在窗口里输账号密码 | 桌面环境 |
| `npm run login` | 命令行交互登录 | 无头 / 远程环境 |

`login` 工具会**一次写入两级会话**：URS 会话（刷课/读题/交卷）和完整浏览器会话（讨论区）。
所以登录一次就有全部能力，**不需要手抄 cookie**。

**工具不收账号密码** —— MCP 参数必须先由模型产出，密码一旦作为参数传入就会进入模型上下文与
会话记录。这个工具反过来把输入交给浏览器，密码只存在于浏览器进程里。

### 1.3 工具清单（14 个）

#### 会话与读取（4 个，只读）

| 工具 | 参数 | 说明 |
|---|---|---|
| `login` | `timeout_ms?` | 弹有头浏览器登录，自动保存两级会话。**不收账号密码**。已登录时几乎立即返回 |
| `session_status` | — | 会话体检：`ok` / `auth_expired` |
| `list_courses` | — | 已选课程（MOOC + SPOC），含 `id` / `name` / `school` / `term_id` |
| `list_todos` | — | 仍开放的待办。`kind` 区分**测验 / 作业 / 考试**；空列表 = **确实没有**，不是失败 |

#### 刷课（1 个 + 1 个只读）

| 工具 | 参数 | 说明 |
|---|---|---|
| `study_unit` | `course_id` `term_id` `unit_id` `school_short_name?` `playback_rate?` `page_interval_sec?` `skip_to_end?` `report_chunk_sec?` `transport?` | 推进视频/文档进度。`transport` 默认 **`auto`**（rpc 优先，失败会**尝试拉起 Chrome**）；只想纯 HTTP 就显式传 `"rpc"` |
| `list_term_units` | `course_id` `term_id` `school_short_name?` | 课件目录：`type`（video/doc/quiz/other）与完成度 |
| `study_course` | `course_id` `term_id` `school_short_name?` `include?` `dry_run?` `discussion_content?` `delay_ms?` `max_units?` `verbose?` **`answer_mode?`** | **一键跑完整门课**（T1）：模型不在循环里。默认**真的会跑**；`answer_mode` 透传给所有测验 |

#### 答题（5 个）

| 工具 | 参数 | 说明 |
|---|---|---|
| `get_homework` | `todo_id` `paper_type?` `school_short_name?` | 读题 |
| `save_homework_answers` | `todo_id` `answers[]` `paper_type?` `school_short_name?` | 存草稿（`preview:true`），**不可能正式提交** |
| `submit_homework` | `todo_id` `answers[]` `paper_type?` `school_short_name?` `allow_exam?` | 正式提交；单元级随堂测试会**自动补任务点上报** |
| `solve_quiz` | `todo_id` **`answer_mode?`** `answers?` `tiku_config?` `submit?` `min_coverage?` `paper_type?` `school_short_name?` `allow_exam?` | **测验**全流程。`answer_mode` 显式选 `paper`/`tiku`/`agent`/`auto`。默认 dry-run |
| `solve_homework` | `todo_id` **`answer_mode?`** `answers?` `submit?` `paper_type?` `school_short_name?` `allow_exam?` | **单元作业**全流程。`answer_mode` 只接受 `agent`（`tiku` 会被明确拒绝）。默认存草稿 |

**`solve_quiz` 是两段式的**：

```
① 先读试卷自带的答案 —— 单元级随堂测试在提交前就返回正确选项与填空答案，这类卷子零题库依赖
② 剩下的才查题库 —— 章节测验不泄露答案，需要配置 tiku_config
③ 闸门：submit:true → 覆盖率 ≥ min_coverage(0.8) → 次数未用完 → 才提交
```

**`solve_homework` 分三种调用**（提交方式由你决定）：

```
只传 todo_id          → 只读题，什么都不写
answers               → 只存草稿（默认）
answers + submit:true → 正式提交
```

有题没答就**整卷不写**并返回 `missing[]`。它**不会替你写内容** —— 作业全是主观论述题，
正文必须由 agent 或人来提供。

#### 讨论区（2 个，需浏览器会话）

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_discussion_units` | `course_id` `term_id` `school_short_name?` | 讨论单元列表。`content_id` **就是主题 id**；带 `view_status` / `completed` |
| `reply_discussion` | `course_id` `term_id` `unit_id` `content` `school_short_name?` | 回复该单元的主题 **= 完成任务点**。已完成则 `already_complete` 拒绝重发 |

会话来源：`login` 工具写入的 `~/.config/icourse163-mcp/browser-session`（或 `ICOURSE163_BROWSER_COOKIE`）。
**不认** `npm run login` 那份会话，也不会回退过去。

### 1.4 默认关闭的开关

| 开关 | 默认 | 打开方式 | 为什么默认关 |
|---|---|---|---|
| **考试提交** | **关闭** | `submit_homework` / `solve_quiz` / `solve_homework` 传 `allow_exam: true` | 考试通常**只有一次机会、不可撤回**，试卷还可能带反作弊计数 |

关闭时 `source=exam` 返回 `exam_out_of_scope` 并说明怎么开。**读题和存草稿不受影响。**
打开后仍要满足原有闸门 —— 开这个开关不会让提交变成隐式行为。

### 1.5 典型用法

```
你：看看我还有哪些待办
    → list_todos

你：把田径那门的随堂测试做掉
    → list_todos（筛 kind=测验）→ 逐个 solve_quiz → 汇报每题命中情况

你：这门课还剩什么
    → list_term_units 看 per-unit 完成度 + list_todos 看未交的作业/测验

你：剩下的讨论做掉
    → list_discussion_units（拿未完成的）→ 逐个 reply_discussion

你：帮我写一下这个单元作业
    → solve_homework(todo_id) 读题 → agent 写正文 → solve_homework(answers) 存草稿
    → 你确认 → solve_homework(answers, submit:true) 正式交
```

### 1.6 答卷流水线（必读）

```
get_homework（读题）→ 填答 → save_homework_answers 必调（草稿）
  →（可选）人工检查 → 仅在用户确认后显式 submit_homework
```

- **默认不交**：没有隐式 submit
- **草稿不是万能的**：部分卷子服务端直接拒绝预览（返回「预览不能提交！」），此时返回明确的
  `draft_rejected` 并提示"要交就显式 submit"，**绝不**静默改成正式提交
- **视频弹窗/随堂测验**：复用同一套 get + save，不静默提交

### 1.7 非目标

- 抢课
- 把账号密码放进 MCP 工具参数

---

## 2. 备选：命令行（`mooc.py` / `mooc.exe`）

> 命令行与 agent 调用**能力等价**：刷课、测验、单元作业、讨论区、一键跑完都在命令行里。
> 两者共用同一个 MCP 引擎，逻辑不重复实现。

只需要 **Python 3.8+** 和 **Node.js 18.14+**，不需要 `pip install` 任何东西。

```bash
python mooc.py login    # 第一次：输账号（手机号）和密码，约 4 秒
python mooc.py auto     # 之后每次：挑一门课，把没学完的视频/文档刷完
```

`auto` 的流程：先体检会话 → 列出你的课程让你**输入序号**选择 → **只刷没完成的单元**，
逐个报告结果 → 最后复查完成度。已完成的自动跳过，所以**重复运行是安全的**。

登录成功后给一个编号菜单（选 1 刷课 / 2 看状态 / 3 列课程 / 0 退出）。

### 2.1 全部命令

| 命令 | 作用 |
|---|---|
| `python mooc.py` | 不带参数时给出编号菜单（同 exe 双击后的界面） |
| `python mooc.py login` | 登录（约 4 秒，不打开浏览器） |
| `python mooc.py status` | 会话体检（只读，约 2 秒） |
| `python mooc.py course [--dry-run] [--answer-mode ...]` | **一键跑完整门课**：刷课 + 随堂测试 + 讨论 + 章节测验 |
| `python mooc.py quiz [--answer-mode ...]` | 挑一个测验来做；先预览覆盖率，再问要不要提交 |
| `python mooc.py homework` | 写单元作业：逐题输入正文，默认存草稿 |
| `python mooc.py discuss [--all] [--content "1"]` | 回复讨论区（`--all` 一次回完） |
| `python mooc.py auto` | 最省事：挑一门课刷完没学完的 |
| `python mooc.py courses` | 列出所有课程，拿到 `course_id` / `term_id` |
| `python mooc.py units <课程ID> <学期ID> [--school XDU]` | 列出课件与完成度 |
| `python mooc.py study <课程ID> <学期ID> [--school XDU]` | 刷指定课程 |
| `python mooc.py settings` | 改设置（视频播放 / 密码显示 / **题库配置**） |
| `python mooc.py settings reset` | 恢复默认值 |

### 2.2 常用选项

| 选项 | 说明 |
|---|---|
| `--dry-run` | 只列出要刷什么，不动手 |
| `--rate 2` | 视频倍速 0.5~2（默认 2） |
| `--chunk 60` | **分块上报**：每 60 秒一次（默认 0 = 关闭）。关闭时服务端看到的是一跳 0→100；开启后是逐段推进，但真实耗时约 `时长 ÷ 倍速` |
| `--delay 0.6` | 单元之间停顿秒数；被限流时加大 |
| `--unit <单元ID>` | 只刷指定单元 |
| `--transport rpc` | 默认 `rpc`；也可 `playwright` / `auto` |
| `--browser` | 登录时改用浏览器通道（能处理验证码/短信） |
| `--hide-password` | 本次不回显密码 |
| `-u <手机号>` | 直接指定登录账号 |

这些选项**不填就走「设置」里保存的值**，命令行明确写了才覆盖这一次。

### 2.3 关于密码输入

**默认可见** —— 含特殊字符或用输入法时盲打容易出错。代价要说清楚：**回显会留在终端回滚区**，
也会出现在录屏/截屏里。需要隐藏时加 `--hide-password`（或设 `ICOURSE163_HIDE_PASSWORD=1`）。

无论可见与否，密码都只以 RSA 密文形式出现在 SM4 加密信封内，从不以明文落盘。

### 2.4 常见问题

| 现象 | 处理 |
|---|---|
| `status` 报"登录已失效" | `python mooc.py login` 重新登录 |
| 刷课时偶发"并发限制" | 已自动退避重试；仍失败就加大 `--delay` |
| 登录被要求滑动验证码/短信 | `python mooc.py login --browser` |
| 有测验/作业/讨论要处理 | 命令行不做这些 —— 用 agent 调用（见[第 1 节](#1-推荐通过-ai-agent-调用mcp)） |

### 2.5 打包成 exe（双击即用，不需要装 Python 或 Node）

```powershell
python scripts/build-exe.py        # 产出 dist/mooc/mooc.exe，约 143 MB
```

把**整个 `dist/mooc` 目录**发给别人，双击 `mooc.exe` 即可。

**第一次运行不摆菜单**（只做登录），**登录一次之后**每次打开直接给编号菜单（含「重新登录」——
双击用户没法加参数，没这一项会话失效就卡住了）。结束时**等你按回车**才关窗口（从已有终端运行
时不会多停），提示文案自动适配 `mooc.exe` / `python mooc.py`。

---

# 合规提醒

这些工具会违反平台服务条款，仓库文档也记录了被检测的风险。
请自行判断是否使用；**不要把账号密码或 cookie 贴进任何对话或 issue**。
