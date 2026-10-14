# icourse163-mcp

中国大学MOOC（[icourse163.org](https://www.icourse163.org)）本机 **stdio MCP**。

对齐 [K4F7/chaoxing-mcp](https://github.com/K4F7/chaoxing-mcp) / [K4F7/pu-mcp](https://github.com/K4F7/pu-mcp)：

- 本地进程，stdio；不托管远端会话
- 登录只走 CLI / 环境变量；MCP 工具不收密码
- 工具：`list_todos`、`list_courses`、`list_term_units`、`study_unit`、`get_homework`、`save_homework_answers`、`submit_homework`、`session_status`

产品目标尽量对齐 [OCS 中国大学MOOC 脚本](https://github.com/ocsjs/ocsjs/blob/4.0/packages/scripts/src/projects/icourse.ts) 的学习自动化；**明确不做考试代交**。

> 📌 **接手/继续这个仓库请先读 [docs/HANDOFF.md](docs/HANDOFF.md)** —— 现状、已逆向出的硬事实、
> 踩过的坑（三个会误导人的错误码）、以及未闭合的问题与下一步实验，都在那一份里。

## 最省事的用法：`mooc.py`

不想碰 MCP、不想抓 cookie、不想记 course_id / term_id？直接用仓库根目录的 `mooc.py`。
**只需要 Python 3.8+，不需要 `pip install` 任何东西，也不需要 Node 以外的依赖。**

```bash
python mooc.py login    # 第一次：输账号密码（密码不显示，不会被保存）
python mooc.py auto     # 之后每次：挑一门课，把没学完的视频/文档刷完
```

`auto` 会先检查会话，列出你的课程让你选序号，然后**只刷没完成的单元**，逐个报告结果，
最后复查一遍完成度。已经完成的单元自动跳过，所以**直接重复运行是安全的**。

其它命令：

```bash
python mooc.py status                              # 登录还有效吗
python mooc.py courses                             # 列出课程，拿 course_id / term_id
python mooc.py units 1450750234 1475848441 --school XDU
python mooc.py study 1450750234 1475848441 --school XDU --dry-run   # 只看要刷什么
python mooc.py study 1450750234 1475848441 --school XDU --delay 2   # 被限流时放慢
```

实现上它通过 stdio 驱动本仓库的 MCP 服务器，只有登录走 Node 命令行 —— 所以
**密码永远不会经过 MCP 或 AI**。刷课默认走签名 RPC 通道，约 1.5 秒一个单元，不启动浏览器。
测验/讨论类型不会被自动提交，脚本会单独列出来提醒你手动处理。

## 安装 / 启动

### Agent Plugin（local）

本仓根已有 Agent Plugins 1.0.0 最小壳（`plugin.json` + `mcp.json` + `skills/login-config`），**不发布 marketplace**。宿主若支持本地插件根：

1. 把插件根指到本仓库绝对路径（或 clone 后的目录）。
2. `mcp.json` 用 `./scripts/run-mcp.sh`，`cwd` 为 `${PLUGIN_ROOT}`（包装脚本已存在）。
3. 先在插件根 `npm ci`，再按 [docs/login.md](docs/login.md) / skill `login-config` 做 CLI 登录；**不要**在对话里贴密码或 cookie。
4. 登录后用 MCP `list_todos` 验证（`status: ok` 可为空待办；`auth_expired` 需重登）。

### npm / AddMcpServer

```sh
npm ci
npm start --silent
```

`--silent` 避免 npm 横幅写进 stdout（会破坏 MCP JSON-RPC）。stdin 保持打开时进程不应退出。

Grok Bot / Cursor 的 AddMcpServer **没有 cwd**，必须用绝对路径启动。配置示例见 [docs/mcp.md](docs/mcp.md)。

登录只走 CLI（MCP 工具不收密码）。Cookie 粘贴或 Playwright 账密、如何确认 / 清除会话：见 [docs/login.md](docs/login.md)。

```sh
npm run login --silent -- --cookie-file /path/to/cookie.txt
npm run login --silent -- --check
```

`list_todos` 列出仍开放的作业 / 测验 / 考试（未完成、未交、可作答）。`status: ok` 且 `todos` 为空表示确实没有开放待办；认证失效是 `auth_expired`（`isError`），不会伪装成空成功。工具不接收、不返回 cookie 或密码。

## 已有能力

- CLI 登录（cookie 文件 / Playwright 账密；见 [docs/login.md](docs/login.md)）
- MCP 工具 `list_todos`：列出仍开放的作业 / 测验 / 考试待办
- MCP 工具 `list_courses` / `list_term_units`：已选课与课件目录
- MCP 工具 `study_unit`：对视频/音频/文档(PPT)单元以 RPC 和/或 Playwright（OCS 对齐）推进学习进度；默认 RPC，遇 -10006 回退浏览器（见 docs/mcp.md）
- MCP 工具 `get_homework` / `save_homework_answers` / `submit_homework`：作业/测验读题 + 草稿保存 + **显式**正式提交

## 答卷流水线（必读）

`get_homework`（读题）→ AI 填答 → **`save_homework_answers` 必调（草稿，`preview=true`）** →（可选）用户检查 → 仅在用户确认后显式 `submit_homework`（`preview=false`）

- **作业 / 测验**：AI 作答后**必须** `save`；`save` 不可能正式提交；正式提交只用 `submit_homework`
- **考试**：代交不做；`submit_homework` 拒绝 exam 来源 todo；若读题 + AI，同样必须 `save`，绝不自动提交
- **默认不交**：没有隐式 submit
- **视频弹窗 / 随堂测验**：复用同一套 get + save，勿静默提交

## 非目标

- **考试代交**（不做；不做自动 `submit`）
- 抢课
- 把账号密码放进 MCP 工具参数

## 状态

脚手架与 MVP 由专仓 bot 按 `ready-for-agent` issue 推进（本机 grok build）。
