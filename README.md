# icourse163-mcp

中国大学MOOC（[icourse163.org](https://www.icourse163.org)）的本机工具：

- **`mooc.py`** —— 傻瓜刷课脚本（给人用）
- **stdio MCP 服务器** —— 给 AI agent 用的一套工具

**登录和刷课都不需要浏览器。** 登录走纯 HTTP（约 4 秒），刷课走签名 RPC（约 1.4 秒/单元），
读题与答卷提交同样是纯 HTTP（13 个 MCP 工具里 10 个完全不用浏览器）。

**唯一的例外**：`mooc.py` 的 `--transport` 默认 `rpc`，绝不回退浏览器；但 MCP 的 `study_unit`
默认 `transport=auto`，遇到 `-10006` / 限流 / 时钟类错误会**自动尝试启动 Chrome**。
想让 agent 的行为和人一致，就显式传 `transport: "rpc"`。

> **接手先读**：[docs/STATUS.md](docs/STATUS.md) —— 现状 / 已验证的边界 / 硬事实 / 危险动作，一份就能上手。
> **下一步做什么、代价多少**：[docs/ROADMAP.md](docs/ROADMAP.md)（按实测排的优先级与代价表）
>
> 技术原理、逆向过程与已知边界见 [第二部分](#二技术介绍) 与
> [docs/adr/](docs/adr/)。接手/继续开发请先读 [docs/HANDOFF.md](docs/HANDOFF.md)。

---

# 一、怎么用

## 1. 最省事：`mooc.py`（推荐）

只需要 **Python 3.8+** 和 **Node.js 18.14+**，不需要 `pip install` 任何东西。

```bash
python mooc.py login    # 第一次：输账号（手机号）和密码，约 4 秒
python mooc.py auto     # 之后每次：挑一门课，把没学完的视频/文档刷完
```

`auto` 的流程：先体检会话 → 列出你的课程让你**输入序号**选择 → **只刷没完成的单元**，
逐个报告结果 → 最后复查一遍完成度。已完成的单元自动跳过，所以**重复运行是安全的**。

登录成功后还会给一个编号菜单，输入序号即可继续：

```
✅ 登录成功，会话已保存在本机。

接下来要做什么？
   1. 开始刷课（挑一门课，把没学完的刷完）
   2. 看看会话状态
   3. 列出我的课程
   0. 退出

请输入序号（直接回车=1）：
```

### 全部命令

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

### 常用选项

| 选项 | 说明 |
|---|---|
| `--dry-run` | 只列出要刷什么，不动手 |
| `--rate 2` | 视频倍速 0.5~2（默认 2） |
| `--chunk 60` | **分块上报**：每 60 秒发一次上报（默认 0 = 关闭）。关闭时一次报满，服务端日志里是**一跳 0→100**；开启后服务端看到的是**逐段推进**，但真实耗时约 `时长 ÷ 倍速`（10 分钟视频、`--chunk 60 --rate 2` 约 5 分钟） |
| `--delay 0.6` | 单元之间停顿秒数；被限流时加大（如 `--delay 2`） |
| `--unit <单元ID>` | 只刷指定单元 |
| `--transport rpc` | 默认 `rpc`；也可 `playwright` / `auto` |
| `--browser` | 登录时改用浏览器通道（能处理验证码/短信） |
| `--hide-password` | 本次不回显密码（覆盖"设置"里的值） |
| `-u <手机号>` | 直接指定登录账号 |

这些选项**不填就走「设置」里保存的值**，命令行明确写了才覆盖这一次 ——
所以"设置里存 2 倍速、偶尔想跑一次 1 倍速"是成立的。设置存在
`~/.config/icourse163-mcp/settings.json`，只写改过的项。

### 关于密码输入

**默认可见** —— 含特殊字符或用输入法时盲打容易出错。代价要说清楚：
**回显的内容会留在终端回滚区**，也会出现在录屏/截屏里。需要隐藏时加 `--hide-password`
（或设 `ICOURSE163_HIDE_PASSWORD=1`）。

无论可见与否，密码都只以 **RSA 密文**形式出现在 **SM4 加密信封**内，从不以明文落盘。
脚本也不接收、不保存密码。

### 常见问题

| 现象 | 处理 |
|---|---|
| `python mooc.py status` 报"登录已失效" | `python mooc.py login` 重新登录 |
| 刷课时偶发"并发限制" | 脚本已自动退避重试；仍失败就加大 `--delay` |
| 登录被要求滑动验证码/短信 | `python mooc.py login --browser` |
| 有测验/讨论没做 | 脚本会列出来，需你手动完成（不自动答题提交） |

### 打包成 exe（双击即用，不需要装 Python 或 Node）

```powershell
python scripts/build-exe.py        # 产出 dist/mooc/mooc.exe，约 143 MB
```

把**整个 `dist/mooc` 目录**发给别人，双击 `mooc.exe` 即可：**不需要装 Python，也不需要装
Node.js**（node.exe 与全部依赖已随包带上）。

**第一次运行不会摆菜单** —— 那时候除了登录没别的能做，直接进登录：

```
🎓 中国大学MOOC 一键刷课

   第一次用，先登录。登录一次以后就不用再输了。
```

**登录一次之后**，每次打开就直接给编号菜单：

```
🎓 中国大学MOOC 一键刷课

   本机已保存会话。要是提示失效，选 2 看一眼、选 5 重新登录。

要做什么？
   1. 开始刷课（挑一门课，把没学完的刷完）
   2. 查看状态（登录还有效吗）
   3. 列出我的课程
   4. 设置（视频播放 / 密码显示）
   5. 重新登录（换账号，或登录失效时用）
   0. 退出
```

**「重新登录」这一项是必须的**：双击的用户没法加命令行参数，会话失效后菜单里要是没有它，
人就卡住了。

几个专门为"双击"做的处理：

- **结束时等你按回车**才关窗口（否则结果一闪就没了）。从已有终端运行时不会多停 —— 靠
  Windows 的 `GetConsoleProcessList` 判断控制台是不是本进程独占的
- **提示文案自动适配**：exe 里说的是 `mooc.exe auto`，源码里说的是 `python mooc.py auto`
- **设置存在用户目录**（`~/.config/icourse163-mcp/settings.json`），不在程序目录里，
  所以放在 `Program Files` 之类的只读位置也能用

**为什么是 onedir（一个目录）而不是单文件**：单文件每次启动都要把约 130MB 解压到临时目录，
冷启动要好几秒；onedir 是一打开就进菜单。exe 只是个入口，资源都在旁边的 `_internal` 里。

## 2. 给 AI agent 用：MCP 服务器

### 挂载

```bash
npm ci
npm start --silent          # --silent 避免 npm 横幅写进 stdout，那会破坏 JSON-RPC
```

本仓根有 Agent Plugins 1.0.0 最小壳（`plugin.json` + `mcp.json` + `skills/login-config`），
宿主支持本地插件根时把插件根指向本仓库绝对路径即可。Grok Bot / Cursor 的 AddMcpServer
**没有 cwd**，必须用绝对路径启动，示例见 [docs/mcp.md](docs/mcp.md)。

**登录只走 CLI，MCP 工具不收密码**；工具也不返回 cookie 或密码：

```bash
npm run login --silent                          # 浏览器通道
npm run login:http --silent -- --channel phone  # 纯 HTTP 通道
npm run login --silent -- --check              # 体检
```

### 工具（共 13 个）

| 工具 | 作用 |
|---|---|
| `session_status` | 会话体检：能否用、哪些 transport 可用（**只读**，不请求 `/learn/`） |
| `list_courses` | 已选课程（MOOC + SPOC），含 `id` / `name` / `school` / `term_id` |
| `list_term_units` | 课件目录：`type`（video/doc/quiz/other）与 `complete_percent` |
| `study_unit` | 推进视频/文档学习进度；`transport` 默认 `auto`（rpc 优先） |
| `list_todos` | 仍开放的作业/测验/考试待办 |
| `get_homework` | 读题（解析 catalog id → 试卷 `contentId`） |
| `save_homework_answers` | **必调**：存草稿（`preview=true`），不可能正式提交 |
| `submit_homework` | 仅在你明确确认后调用；考试默认拒绝，需显式 `allow_exam: true` |
| `solve_quiz` | 读题 → 查题库/用试卷自带答案 → （可选）提交；默认只出清单不提交 |
| `list_discussion_units` | 列出讨论单元（`content_id` = 主题 id）；需**浏览器登录**的 cookie |
| `reply_discussion` | 回复该单元的主题即完成任务点；已完成则拒绝重发 |

### 默认关闭的开关

有一个能力**故意默认关闭**，需要你显式打开：

| 开关 | 默认 | 打开方式 |
|---|---|---|
| 考试提交 | **关闭** | `submit_homework` / `solve_quiz` 传 `allow_exam: true` |

- 关闭时，`source=exam` 的待办会返回 `exam_out_of_scope` 并说明怎么开；**读题和存草稿不受影响**。
- 打开后仍要满足原有闸门：`submit_homework` 本来就只在显式调用时才提交；`solve_quiz` 还要求 `submit: true` 且覆盖率达标。
- 为什么默认关：考试通常**只有一次机会、不可撤回**，试卷还可能带反作弊计数
  （实测本课程期末考试的 `allowSwitchPageCount` 为 `0`，即切换页面零容忍）。
  开启等于你自担被检测的风险。

`status: ok` 且列表为空表示**确实没有**，不是失败；认证失效是 `auth_expired`（`isError`），
不会被伪装成空成功。

### 答卷流水线（必读）

```
get_homework（读题）→ AI 填答 → save_homework_answers 必调（草稿）
  →（可选）人工检查 → 仅在用户确认后显式 submit_homework
```

- **作业/测验**：AI 作答后**必须** `save`；`save` 不可能正式提交
- **考试**：读题、存草稿都可以；**正式提交默认关闭**，只有显式传 `allow_exam: true` 才会替你交卷（见下方「默认关闭的开关」）
- **默认不交**：没有隐式 submit
- **视频弹窗 / 随堂测验**：复用同一套 get + save，勿静默提交

### 非目标

- **考试自动提交**（**默认关闭**；必须显式开启，见「默认关闭的开关」）
- 抢课
- 把账号密码放进 MCP 工具参数

---

# 二、技术介绍

## 1. 三条通道

| 通道 | 用途 | 耗时 | 依赖 |
|---|---|---|---|
| **签名 RPC** | 刷视频/文档进度 | ~1.4 秒/单元 | 仅 HTTP |
| **URS 纯 HTTP** | 登录 | ~4 秒 | 仅 HTTP |
| **Playwright** | 回退：验证码、疑难导航 | ~30 秒 | Chrome + 可用网页会话 |

`mooc.py` 只是一个 Python 封装：它通过 stdio 驱动本仓的 MCP 服务器（刷课）并调用 Node CLI
（登录），所以**密码永远不经过 MCP 或 AI**。

## 2. 刷课：签名 RPC

站点对写接口校验请求签名，算法从前端 bundle 还原：

```
auth-signature = MD5(bodyJson + nonce + timestamp + "<硬编码密钥>").toUpperCase()
```

关键点：**签名覆盖实际发送的字节**，所以传输层必须原样发送 body（不能重新序列化）。
载荷是扁平结构（`action: LEARN_TIME_COUNT`），文档类单元的 `pageNum` **不被服务端校验**，
所以文档路径不需要页数、也不需要那个恒返回 `001:系统异常` 的接口。

细节与证据：[docs/adr/0004-rpc-request-signing.md](docs/adr/0004-rpc-request-signing.md)。

## 3. 登录：URS 纯 HTTP

登录组件（`reg.icourse163.org` 的 URS）把参数压进一个叫 `encParams` 的字段，链路是：

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

全部常量、验证方法与**三次判断更正**（同一个 `401` 我读错过三次）：
[docs/adr/0005-urs-http-login.md](docs/adr/0005-urs-http-login.md)。

## 4. 会话 cookie 的语义

| cookie | 含义 |
|---|---|
| `NTESSTUDYSI` | API 令牌，所有工具都需要。**匿名访客也会被写入占位值** |
| `STUDY_INFO` | **只有真实登录才会写** → 这是"已登录"的判据 |
| `STUDY_SESS` | 网页会话，**只有 Playwright 路径需要** |

只有 `NTESSTUDYSI` 时：API 与签名 RPC 可用，但浏览器路径不可用（普通 HTML 请求会被弹离
`/learn/`）—— `session_status` 工具专门用来区分这个状态。

## 5. 限流与重试

连续发签名请求会触发 `并发限制`。注意**同一条文案既表示限流、也表示签名未通过验证**，
所以本仓按"退避重试"处理（4 次、700ms 起，每次重新签名），`mooc.py` 侧再停 0.6 秒/单元。

## 6. 目录结构

```
mooc.py                  傻瓜刷课脚本（纯 Python 标准库）
src/stdio.ts             MCP 服务器入口
src/rpc-sign.ts          RPC 请求签名
src/urs-login.ts         URS 纯 HTTP 登录 + 会话落地
src/urs-login-cli.ts     ↑ 的 CLI（npm run login:http）
src/session-status.ts    会话体检工具
src/study-unit.ts        刷课编排（RPC / Playwright）
src/study-playwright.ts  浏览器路径
src/check-rpc.ts         无副作用的能力探测（npm run check:rpc）
docs/adr/                架构决策记录（含逆向证据）
docs/HANDOFF.md          交接报告：现状、硬事实、踩过的坑
docs/login.md            登录细节与实测补充
docs/mcp.md              MCP 接入与工具说明
```

## 7. 环境要求与已知限制

**要求**：Node.js ≥ 18.14、Python ≥ 3.8（只用 `mooc.py` 时需要）；浏览器通道需要
Google Chrome/Chromium（可设 `ICOURSE163_CHROME`）。

**已知限制**：

- 只处理**视频/文档**进度；测验/讨论/作业需要人工（脚本会列出）
- `npm test` 在 Windows 上不可用（脚本用了 POSIX 语法），改用：
  `$env:ICOURSE163_DISALLOW_LIVE_PLAYWRIGHT='1'; node --import tsx --test tests/*.test.ts`
- 测试中有一条**既有失败**（`defaultSessionFilePath` 的 Windows 路径断言），与本仓改造无关
- URS 的 `RECUR_HASHCASH` / `sequFun` 两种工作量证明变体**未实现**（遇到时明确报错，不猜测）
- 进度是一次性上报全时长，**不像真人那样每约 60 秒报一次**；要更自然的痕迹需改成分块上报

## 8. 状态

脚手架与 MVP 由专仓 bot 按 `ready-for-agent` issue 推进（本机 grok build）。
本仓在其之上补齐了三件事：**签名 RPC 刷课**、**纯 HTTP 登录**、**`mooc.py` 封装**。

当前测试：**191 个，190 通过**（唯一失败即上面那条既有断言）。

---

# 合规提醒

这些工具会违反平台服务条款，仓库文档也记录了被检测的风险。
请自行判断是否使用；**不要把账号密码或 cookie 贴进任何对话或 issue**。
