# icourse163-mcp

中国大学MOOC（[icourse163.org](https://www.icourse163.org)）的本机工具。

**推荐通过 AI agent 调用。** 13 个 MCP 工具覆盖：登录、刷课、读题、答题提交、单元作业、讨论区。
命令行入口（`mooc.py` / `mooc.exe`）**目前只覆盖刷课**，答题与讨论区没有对应的菜单项 —— 见下文**第 2 节**。

**绝大多数操作不需要浏览器。** 登录走纯 HTTP（约 4 秒），刷课走签名 RPC（约 1.4 秒/单元），
读题与提交同样纯 HTTP（13 个工具里 10 个完全不用浏览器）。

> **接手/继续开发先读**：[docs/STATUS.md](docs/STATUS.md) —— 现状、已验证的边界、硬事实、危险动作。
> **下一步做什么、代价多少**：[docs/ROADMAP.md](docs/ROADMAP.md)。
> 技术原理与逆向过程：**第二部分** 与 [docs/adr/](docs/adr/)。

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

Grok Bot / Cursor 的 `AddMcpServer` **没有 cwd**，必须用绝对路径启动。Windows 用
`scripts/run-mcp.cmd`，POSIX 用 `scripts/run-mcp.sh`，完整示例见 [docs/mcp.md](docs/mcp.md)。

### 1.2 先登录一次

有两条路，都**不需要把密码交给 agent**：

| 方式 | 怎么做 | 适用 |
|---|---|---|
| **`login` 工具**（推荐） | 让 agent 调它 → **弹出有头 Chrome** → 你在窗口里输账号密码 | 桌面环境 |
| `npm run login` | 命令行交互登录 | 无头/远程环境 |

`login` 工具会**一次写入两级会话**：URS 会话（刷课/读题/交卷用）和完整浏览器会话
（讨论区用，新版 API 只认它）。所以登录一次就有全部能力，不需要再手抄 cookie。

**为什么工具不收密码**：MCP 参数必须先由模型产出，密码一旦作为参数传入就会进入模型上下文
与会话记录。这个工具反过来把输入交给浏览器，密码只存在于浏览器进程里。

### 1.3 工具清单（13 个）

#### 会话与读取（4 个，只读）

| 工具 | 参数 | 说明 |
|---|---|---|
| `login` | `timeout_ms?` | 弹有头浏览器登录，自动保存两级会话。**不收账号密码**。已登录时几乎立即返回 |
| `session_status` | — | 会话体检。`ok` / `auth_expired`。注意：`ok` 但 `course_count=0` 是"半死会话" |
| `list_courses` | — | 已选课程（MOOC + SPOC），含 `id` / `name` / `school` / `term_id` |
| `list_todos` | — | 仍开放的待办。`kind` 区分 **测验 / 作业 / 考试**；`status: ok` + 空列表表示**确实没有** |

#### 刷课（1 个）

| 工具 | 参数 | 说明 |
|---|---|---|
| `study_unit` | `course_id` `term_id` `unit_id` `school_short_name?` `playback_rate?` `page_interval_sec?` `skip_to_end?` `report_chunk_sec?` `transport?` | 推进视频/文档进度。`transport` 默认 **`auto`**（rpc 优先，失败会**尝试拉起 Chrome**）；只想纯 HTTP 就显式传 `"rpc"` |

配套只读工具：`list_term_units`（`course_id` `term_id` `school_short_name?`）列出课件目录与完成度。

#### 答题（5 个）

| 工具 | 参数 | 说明 |
|---|---|---|
| `get_homework` | `todo_id` `paper_type?` `school_short_name?` | 读题。把目录 id 解析成试卷 `tid` |
| `save_homework_answers` | `todo_id` `answers[]` `paper_type?` `school_short_name?` | 存草稿（`preview:true`），**不可能正式提交** |
| `submit_homework` | `todo_id` `answers[]` `paper_type?` `school_short_name?` `allow_exam?` | 正式提交。单元级随堂测试会**自动补任务点上报**；考试需 `allow_exam:true` |
| `solve_quiz` | `todo_id` `tiku_config?` `submit?` `min_coverage?` `paper_type?` `school_short_name?` `allow_exam?` | **测验**全流程：先读试卷自带答案，剩下的才问题库。默认 dry-run |
| `solve_homework` | `todo_id` `answers?` `submit?` `paper_type?` `school_short_name?` `allow_exam?` | **单元作业**全流程：不传 `answers` 只读题；默认存草稿，`submit:true` 才交 |

**`solve_quiz` 的两段式**（关键）：

```
① 试卷自带答案：单元级随堂测试在提交前就返回 optionDtos[].answer 与填空题的 stdAnswer
                 → 这类卷子零题库依赖，实测用它做完了 57/57
② 剩下的才查题库：章节测验不泄露答案，需要配置 tiku_config
③ 闸门：submit:true → 覆盖率 ≥ min_coverage(0.8) → 次数未用完 → 才提交
```

**`solve_homework` 的三态调用**（提交方式由你决定）：

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
| `list_discussion_units` | `course_id` `term_id` `school_short_name?` | 讨论单元列表。`content_id` **就是老师创建的主题 id**；带 `view_status` / `completed` |
| `reply_discussion` | `course_id` `term_id` `unit_id` `content` `school_short_name?` | 回复该单元的主题 **= 完成任务点**。已完成则 `already_complete` 拒绝重发 |

会话来源：`login` 工具自动写入的 `~/.config/icourse163-mcp/browser-session`（或
`ICOURSE163_BROWSER_COOKIE`）。**不认** `npm run login` 那份 URS 会话，也不会回退过去。

### 1.4 默认关闭的开关

| 开关 | 默认 | 打开方式 | 为什么默认关 |
|---|---|---|---|
| **考试提交** | **关闭** | `submit_homework` / `solve_quiz` / `solve_homework` 传 `allow_exam: true` | 考试通常**只有一次机会、不可撤回**，试卷还可能带反作弊计数（实测本课程期末考试 `allowSwitchPageCount = 0`，切换页面零容忍） |

关闭时 `source=exam` 返回 `exam_out_of_scope` 并说明怎么开。**读题和存草稿不受影响。**
打开后仍要满足原有闸门 —— 开这个开关不会让提交变成隐式行为。

### 1.5 典型对话示例

```
你：看看我还有哪些待办
    → agent: list_todos

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

- **默认不交**：没有隐式 submit，任何提交都必须由调用方显式要求
- **草稿不是万能的**：部分卷子服务端直接拒绝预览（返回「预览不能提交！」），此时本仓返回明确的
  `draft_rejected` 并提示"要交就显式 submit"，**绝不**静默改成正式提交
- **视频弹窗/随堂测验**：复用同一套 get + save，不静默提交

### 1.7 非目标

- ~~考试自动提交~~ → 已实现，但**默认关闭**，必须显式开启
- 抢课
- 把账号密码放进 MCP 工具参数

---

## 2. 备选：命令行（`mooc.py` / `mooc.exe`）

> ⚠️ **功能不完整**：命令行目前只覆盖**刷课**（登录、体检、列课、刷进度、设置）。
> 答题、单元作业、讨论区**没有**菜单入口，那些只能用 agent 调用。

只需要 **Python 3.8+** 和 **Node.js 18.14+**，不需要 `pip install` 任何东西。

```bash
python mooc.py login    # 第一次：输账号（手机号）和密码，约 4 秒
python mooc.py auto     # 之后每次：挑一门课，把没学完的视频/文档刷完
```

`auto` 的流程：先体检会话 → 列出你的课程让你**输入序号**选择 → **只刷没完成的单元**，
逐个报告结果 → 最后复查一遍完成度。已完成的单元自动跳过，所以**重复运行是安全的**。

登录成功后给一个编号菜单：

```
✅ 登录成功，会话已保存在本机。

接下来要做什么？
   1. 开始刷课（挑一门课，把没学完的刷完）
   2. 看看会话状态
   3. 列出我的课程
   0. 退出

请输入序号（直接回车=1）：
```

### 2.1 全部命令

| 命令 | 作用 |
|---|---|
| `python mooc.py` | 不带参数时给出编号菜单（同 exe 双击后的界面） |
| `python mooc.py login` | 登录（约 4 秒，不打开浏览器） |
| `python mooc.py status` | 会话体检（只读，约 2 秒） |
| `python mooc.py auto` | 最省事：挑一门课刷完没学完的 |
| `python mooc.py courses` | 列出所有课程，拿到 `course_id` / `term_id` |
| `python mooc.py units <课程ID> <学期ID> [--school XDU]` | 列出课件与完成度 |
| `python mooc.py study <课程ID> <学期ID> [--school XDU]` | 刷指定课程 |
| `python mooc.py settings` | 编号菜单里改设置（视频播放 / 密码显示） |
| `python mooc.py settings reset` | 恢复默认值 |

### 2.2 常用选项

| 选项 | 说明 |
|---|---|
| `--dry-run` | 只列出要刷什么，不动手 |
| `--rate 2` | 视频倍速 0.5~2（默认 2） |
| `--chunk 60` | **分块上报**：每 60 秒发一次（默认 0 = 关闭）。关闭时一次报满，服务端日志里是**一跳 0→100**；开启后是**逐段推进**，但真实耗时约 `时长 ÷ 倍速` |
| `--delay 0.6` | 单元之间停顿秒数；被限流时加大（如 `--delay 2`） |
| `--unit <单元ID>` | 只刷指定单元 |
| `--transport rpc` | 默认 `rpc`；也可 `playwright` / `auto` |
| `--browser` | 登录时改用浏览器通道（能处理验证码/短信） |
| `--hide-password` | 本次不回显密码（覆盖"设置"里的值） |
| `-u <手机号>` | 直接指定登录账号 |

这些选项**不填就走「设置」里保存的值**，命令行明确写了才覆盖这一次。设置存在
`~/.config/icourse163-mcp/settings.json`，只写改过的项。

### 2.3 关于密码输入

**默认可见** —— 含特殊字符或用输入法时盲打容易出错。代价要说清楚：
**回显的内容会留在终端回滚区**，也会出现在录屏/截屏里。需要隐藏时加 `--hide-password`
（或设 `ICOURSE163_HIDE_PASSWORD=1`）。

无论可见与否，密码都只以 **RSA 密文**形式出现在 **SM4 加密信封**内，从不以明文落盘。
脚本也不接收、不保存密码。

### 2.4 常见问题

| 现象 | 处理 |
|---|---|
| `status` 报"登录已失效" | `python mooc.py login` 重新登录 |
| 刷课时偶发"并发限制" | 已自动退避重试；仍失败就加大 `--delay` |
| 登录被要求滑动验证码/短信 | `python mooc.py login --browser` |
| 有测验/作业/讨论要处理 | 命令行不做这些 —— 用 agent 调用（见**第 1 节**） |

### 2.5 打包成 exe（双击即用，不需要装 Python 或 Node）

```powershell
python scripts/build-exe.py        # 产出 dist/mooc/mooc.exe，约 143 MB
```

把**整个 `dist/mooc` 目录**发给别人，双击 `mooc.exe` 即可：不需要装 Python，也不需要装
Node.js（node.exe 与全部依赖已随包带上）。

**第一次运行不会摆菜单** —— 那时候除了登录没别的能做，直接进登录。**登录一次之后**，每次打开
就直接给编号菜单（含「5. 重新登录」—— 双击的用户没法加命令行参数，没有这一项会话失效就卡住了）。

几个专门为"双击"做的处理：

- **结束时等你按回车**才关窗口（从已有终端运行时不会多停，靠 `GetConsoleProcessList` 判断）
- **提示文案自动适配**：exe 里说 `mooc.exe auto`，源码里说 `python mooc.py auto`
- **设置存在用户目录**，不在程序目录里，所以放在 `Program Files` 之类的只读位置也能用

**为什么是 onedir 而不是单文件**：单文件每次启动都要把约 130MB 解压到临时目录，冷启动要好几秒。

---

# 二、技术介绍

## 1. 四条通道

| 通道 | 用途 | 耗时 | 依赖 |
|---|---|---|---|
| **签名 RPC** | 刷视频/文档进度 | ~1.4 秒/单元 | 仅 HTTP |
| **URS 纯 HTTP** | 登录 | ~4 秒 | 仅 HTTP |
| **旧版 RPC** | 读题、交卷、目录 | ~1–3 秒 | 仅 HTTP |
| **新版 Next.js API** | 讨论区 | ~1–2 秒 | 需**浏览器登录**的会话 |
| Playwright | 回退：验证码、疑难导航 | ~30 秒 | Chrome + 可用网页会话 |

`mooc.py` 只是一个 Python 封装：它通过 stdio 驱动本仓的 MCP 服务器（刷课）并调用 Node CLI
（登录），所以**密码永远不经过 MCP 或 AI**。

## 2. 刷课：签名 RPC

站点对写接口校验请求签名，算法从前端 bundle 还原：

```
auth-signature = MD5(bodyJson + nonce + timestamp + "<硬编码密钥>").toUpperCase()
```

关键点：**签名覆盖实际发送的字节**，所以传输层必须原样发送 body（不能重新序列化）。
载荷是扁平结构（`action: LEARN_TIME_COUNT`），文档类单元的 `pageNum` **不被服务端校验**。

另外两条实测：`videoTime` 是**播放位置**不是总时长（重复同一值不涨进度）；`finished: true`
单独就能把单元标记为完成。

细节：[docs/adr/0004-rpc-request-signing.md](docs/adr/0004-rpc-request-signing.md)。

## 3. 登录：URS 纯 HTTP

登录组件（`reg.icourse163.org` 的 URS）把参数压进 `encParams`，链路是：

```
SM4 信封（ECB + PKCS7，密钥硬编码）
  + 工作量证明（VDF 顺序平方 ≈ 1 秒 CPU + MurmurHash3 签名）
  + RSA 加密的密码（PKCS#1 v1.5）
  → /dl/zj/yd/{ini, powGetP, gt, pwd/l}
  → 会话落地：GET icourse163.org（换出 STUDY_* 与 NTESSTUDYSI）
```

几个反直觉的点：

- **`minTime` 才是工作量证明的真正约束**，不是迭代次数 `t`
- **`{"ret":"201"}` 不是可用会话** —— URS 只种 `.163.com` 的 cookie，必须再访问
  icourse163.org 才换到能用的会话
- **落地后的完整 cookie 会超过 Windows 凭据管理器上限**，所以只保留 7 个必要 cookie

全部常量与**三次判断更正**（同一个 `401` 我读错过三次）：
[docs/adr/0005-urs-http-login.md](docs/adr/0005-urs-http-login.md)。

## 4. 两套 API 与两套鉴权（最容易踩的坑）

| 层 | 基址 | 纯 HTTP 会话 | 用途 |
|---|---|---|---|
| 旧版 RPC | `/web/j/*Bean.*.rpc` | ✅ 有效 | 刷课、读题、交卷、目录 |
| **新版 Next.js API** | **`/front-mooc-learn/api/learn/*`** | ❌ 被视为匿名 | 讨论区 |

- 基址**不是** `/api/learn/*`（那个 404）
- 新版 API 需要**浏览器登录**的 cookie；`login` 工具会自动写入，**必须用有头模式**
  （无头取到的会话缺 `NTES_YD_SESS`，新版 API 不认）
- `canWrite:false` 是读接口自己的属性，不限制写

## 5. 会话 cookie 的语义

| cookie | 含义 |
|---|---|
| `NTESSTUDYSI` | API 令牌，所有工具都需要。**匿名访客也会被写入占位值** |
| `STUDY_INFO` | **只有真实登录才会写** → 这是"已登录"的判据 |
| `STUDY_SESS` | 网页会话 |
| `NTES_YD_SESS` | 新版 API 需要；**无头浏览器不会产生它** |

## 6. 限流与重试

连续发签名请求会触发 `并发限制`。注意**同一条文案既表示限流、也表示签名未通过验证**，
所以本仓按"退避重试"处理（4 次、700ms 起，每次重新签名），`mooc.py` 侧再停 0.6 秒/单元。

## 7. 目录结构

```
mooc.py                  傻瓜刷课脚本（纯 Python 标准库，只覆盖刷课）
src/stdio.ts             MCP 服务器入口（13 个工具）
src/discussion.ts        讨论区：读单元 / 回复主题
src/solve-homework.ts    单元作业流水线
src/solve-quiz.ts        测验流水线（试卷优先 + 题库）
src/tiku.ts              题库层（OCS AnswererWrapper 兼容）
src/homework.ts          读题 / 草稿 / 提交 / 任务点上报
src/rpc-sign.ts          RPC 请求签名
src/urs-login.ts         URS 纯 HTTP 登录 + 会话落地
src/open-login.ts        Playwright 登录 + 交互式浏览器登录
src/session-status.ts    会话体检
src/study-unit.ts        刷课编排（RPC / Playwright）
scripts/run-mcp.sh|.cmd  MCP 启动包装（给没有 cwd 的客户端用）
docs/STATUS.md           接手入口：现状 / 硬事实 / 危险动作
docs/ROADMAP.md          优先级与代价
docs/mcp.md              工具契约与状态码语义
```

## 8. 环境要求与已知限制

**要求**：Node.js ≥ 18.14、Python ≥ 3.8（只用 `mooc.py` 时需要）；浏览器通道需要
Google Chrome/Chromium（可设 `ICOURSE163_CHROME`）。

**已知限制**：

- `npm test` 在 Windows 上不可用（脚本用了 POSIX 语法），改用：
  `$env:ICOURSE163_DISALLOW_LIVE_PLAYWRIGHT='1'; node --import tsx --test tests/*.test.ts`
- URS 的 `RECUR_HASHCASH` / `sequFun` 两种工作量证明变体**未实现**（遇到时明确报错，不猜测）
- 进度是一次性上报全时长，**不像真人那样每约 60 秒报一次**；要更自然的痕迹用 `--chunk`
- **讨论区的 `lid` 参数（按单元过滤）至今返回 `-100`**，未解开；做任务点不需要它
- 单元作业提交**不影响课程进度**（它是章节级作业，只拿作业分）

## 9. 状态

脚手架与 MVP 由专仓 bot 按 `ready-for-agent` issue 推进。本仓在其之上补齐了：签名 RPC 刷课、
纯 HTTP 登录、`mooc.py` 封装、答题流水线、题库层、讨论区、交互式登录。

**测试：243 个，全部通过。** typecheck 干净。

---

# 合规提醒

这些工具会违反平台服务条款，仓库文档也记录了被检测的风险。
请自行判断是否使用；**不要把账号密码或 cookie 贴进任何对话或 issue**。
