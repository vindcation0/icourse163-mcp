# 登录（仅 CLI）

中国大学MOOC（icourse163.org）会话只存在本机。**MCP 工具从不接收密码或 cookie**，也不返回它们。先用 CLI 登录，再挂 stdio MCP。

成功时只打印 `LOGIN_OK has_cookie=true`，不会打印 cookie 或密码。

## 存哪儿

优先 OS 钥匙串（`@napi-rs/keyring`，service `icourse163.mcp` / account `cookie`）。钥匙串不可用时落到 `0600` 文件：

- `$XDG_CONFIG_HOME/icourse163-mcp/session`
- 若未设 `XDG_CONFIG_HOME`：`~/.config/icourse163-mcp/session`

本地文件安全性低于钥匙串。不要把该文件提交进 git。不保存密码。

## Cookie 粘贴（可靠兜底）

从浏览器开发者工具复制已登录后访问 `www.icourse163.org` 的 **Cookie** 请求头（必须包含 `NTESSTUDYSI`），写入一个本机文件，然后：

```sh
npm run login --silent -- --cookie-file /path/to/cookie.txt
```

或环境变量（不要把真实值写进仓库、文档或 MCP 配置）：

```sh
ICOURSE163_COOKIE='…paste cookie header…' npm run login --silent
```

Netscape `cookies.txt`（仅 `icourse163.org` 域）也可以。缺 `NTESSTUDYSI` 会失败。

**优先级：** 有效的 `ICOURSE163_COOKIE`（或 `--cookie-file`）优先于账密。若环境变量 cookie 缺 `NTESSTUDYSI` 或会话探测失败，且同时提供了用户名/密码，则回退到 Playwright 账密登录（显式 `--cookie-file` 失败不会回退）。

## Playwright 账密

对环境变量 `ICOURSE163_USERNAME` / `ICOURSE163_PASSWORD`（可用 `-u` / `-p` 覆盖；用 `--silent` 以免 npm 横幅把 `-p` 打出来）：

```sh
ICOURSE163_USERNAME='…' ICOURSE163_PASSWORD='…' npm run login --silent
```

流程：打开首页（SPA，等待可见的「登录」入口，而不是立刻扫 DOM）→ `iframe[src*='reg.icourse163.org'][src*='index_dl2']`。URS 默认短信/扫码，密码框可能已存在但隐藏；若未见密码框则点「密码登录 / 账号登录 / 邮箱登录」，再填账密。提交点可见的 `a.u-loginbtn` / `button|input[type=submit]` / `#dologin`，或可见的纯「登录」文案（不会点隐藏的「网易邮箱账号登录」）。需要本机 **Chrome / Chromium**（`playwright-core` 走系统 Chrome `channel: "chrome"`；也可设 `ICOURSE163_CHROME` 指向浏览器可执行文件）。无图形界面时走 headless。

不做学校 SSO（docs.icourse163.org）。登录 CLI 只负责会话建立（等价能力的 `login` MCP 工具见 [mcp.md](mcp.md)，它弹浏览器、不收密码参数）；产品目标/默认关闭的开关（含**考试提交默认关闭**）见 [README](../README.md)。

## 确认 / 清除

```sh
npm run login --silent -- --check
# 成功：SESSION_OK has_cookie=true

npm run login --silent -- --clear
# 成功：SESSION_CLEARED
```

`--check` 会预热 `https://www.icourse163.org/`（需要 `STUDY_INFO`）或打一条轻量课程列表 RPC（`code:0`）。失败是 `auth_expired`，**不会**伪装成「没有待办」。

```sh
npm run login -- --help
```

## 和 MCP 的关系

先 CLI 登录，再挂 MCP。`list_todos` 用本机会话拉仍开放的待办；工具参数里没有账号、密码或 cookie，返回里也不含它们。

## 实测补充（本机验证，2026-10-14）

### 密码登录的现状

`npm run login` 不带 `--cookie-file` 时走 Playwright 账密流程：打开首页 → 点「登录」→ 进入
`reg.icourse163.org` 的登录 iframe → 填账号密码 → 点 `a.u-loginbtn`。

扫描当前登录界面得到的实际结构：

```
iframe                     iframe[src*='reg.icourse163.org'][src*='index_dl2']  ✓ 匹配
input[type='text']         total=1 visible=0    （隐藏）
input[type='tel']          total=1 visible=1    ← 账号输入框
input[type='password']     total=2 visible=1    ← 密码框默认可见
a.u-loginbtn               total=1 visible=1    ← 提交按钮 ✓ 匹配
界面文字：短信快捷登录 / 登 录 / 十天内免登录 / 忘记密码？
```

密码框默认可见，所以 `ensurePasswordMode()` 第一次检查即通过、提前返回，选择器链是通的。
但要注意：界面上的切换标签是 **`短信快捷登录`**，方向是"切到短信"，与
`PASSWORD_MODE_SWITCH_LABEL`（`密码登录|账号登录|邮箱登录`）相反。若站点某次默认进入短信/扫码
模式，现在会**立即报错并列出可见标签**，而不是让你等 60 秒的会话超时。

### ⚠️ `NTESSTUDYSI` 存在 ≠ 已登录

站点自己的 JS 会给**未登录访客**写入一个硬编码占位值：

```js
if (!r.NTESSTUDYSI) document.cookie = "NTESSTUDYSI=".concat(y, ";path=/")
// y = "fa2c35db81bb400a97f5ed9465e22b9d"
```

因此只检查 `NTESSTUDYSI` 会导致：**账号密码随便填也能打印 `LOGIN_OK`，并把那个匿名会话覆盖
掉你原本有效的会话。** 本仓已修正 —— 现在要求同时存在 `STUDY_INFO`（只有真实 URS 登录才会写），
并用测试锁住（`tests/open-login.test.ts` → `cookieHeaderFrom`）。

登录失败时**不会**写入任何会话，已有会话保持不变。

### 无界面登录

Windows/macOS 下账密登录默认弹出可见浏览器窗口。想无窗口运行（或做自动化验证）：

```powershell
$env:ICOURSE163_LOGIN_HEADLESS='1'   # 强制 headless
npm run login --silent
```

### 建议的登录顺序

1. `npm run login`（交互式账密，密码隐藏输入）—— 最省事
2. 若站点要求短信/扫码验证，会在 iframe 里体现；此时改用 `--cookie-file`
3. 登录后用 `npm run check:rpc --silent -- --course-id <id> --term-id <id> --school <S>` 验证：
   它会同时确认会话可用与签名请求可用（约 2 秒）

### 纯 HTTP 登录（已实测可用，不需要浏览器）

`npm run login:http` 在 Node 里复现 URS 组件的请求，全程不起浏览器：SM4 加密的参数信封、
一个必须实打实烧掉约 1 秒 CPU 的工作量证明（VDF + MurmurHash3）、以及 RSA 加密的密码。
原理、证据、三次判断更正与根因见 [docs/adr/0005-urs-http-login.md](adr/0005-urs-http-login.md)。

```powershell
npm run login:http --silent -- -u <手机号> --channel phone   # 密码走隐藏输入，约 3.6 秒
```

**实测结果**：`LOGIN_OK has_cookie=true`，会话落地后 `check:rpc` 报 `session ok`、
`mooc.py status` 报可用。

两点须知：

- **必须用 `--channel phone`**。icourse163 的登录界面上「网易邮箱账号登录」标签是隐藏的，
  邮箱通道对本产品未开放（`ini`/`powGetP`/`gt` 这些共享管线能通，`/l` 会被拒）。
- **「会话落地」是必需的第二步**：`{"ret":"201"}` 只种 `.163.com` 的 cookie，还需访问
  `icourse163.org`（会跳到 `/passport/logingate/changeCookie.htm`）才换来 `STUDY_*`，
  再访问 `/member/login.htm` 换来 `NTESSTUDYSI`。本仓已用 `ursLandSession()` 自动完成。

服务端要求验证码时（码为 `441/444/445/447`），CLI 会明确报出，此时请用 `npm run login`。

### 密码输入是否回显

**默认可见**（本项目按使用者要求这么定的）：含特殊字符或用输入法时，盲打容易出错。

代价要说清楚：**回显的内容会留在终端回滚区**，也会出现在录屏和截屏里。需要隐藏时：

```powershell
python mooc.py login --hide-password              # 也可设 ICOURSE163_HIDE_PASSWORD=1
npm run login:http --silent -- --hide-password
npm run login --silent -- --hide-password         # 浏览器通道同样支持
```

两种模式的提示文案不同（`密码（可见）:` / `密码（不显示）:`），一眼能看出当前是哪种。
另有 `ICOURSE163_SHOW_PASSWORD=1` 可强制回显（用于脚本里覆盖全局的 HIDE 设置）。

**`npm run login`（浏览器）仍是可靠回退** —— 它能处理验证码。两者共用同一份凭据存储，
谁成功都可以直接被 MCP 工具使用。



