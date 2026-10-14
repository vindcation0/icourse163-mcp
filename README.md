# icourse163-mcp

中国大学MOOC（[icourse163.org](https://www.icourse163.org)）本机 **stdio MCP**。

对齐 [K4F7/chaoxing-mcp](https://github.com/K4F7/chaoxing-mcp) / [K4F7/pu-mcp](https://github.com/K4F7/pu-mcp)：

- 本地进程，stdio；不托管远端会话
- 登录只走 CLI / 环境变量；MCP 工具不收密码
- 工具：`list_todos`、`list_courses`、`list_term_units`、`study_unit`、`get_homework`、`save_homework_answers`、`submit_homework`、`session_status`

产品目标尽量对齐 [OCS 中国大学MOOC 脚本](https://github.com/ocsjs/ocsjs/blob/4.0/packages/scripts/src/projects/icourse.ts) 的学习自动化；**明确不做考试代交**。

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
