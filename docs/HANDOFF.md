# 交接报告：icourse163-mcp 的改造与 URS 逆向

> 面向"过一段时间回来继续"的场景。**先读第 1、2、6 节**就能接上；
> 第 4 节是已经逆向出来的硬事实，**不要再重新推导一遍**；
> 第 5 节是踩过的坑，**不要重复犯错**。
>
> 最后更新：2026-10-14 · 仓库状态：`7b5ce87`，与 `origin/main` 同步，工作区干净

---

## 1. 一句话现状

**刷课已经完全可用且不需要浏览器**（签名 RPC 通道，约 1.4 秒/单元）；
**登录仍以浏览器路径为主**，纯 HTTP 登录的握手部分已逆向并实测打通，最后一步（提交密码）未验证成功，
原因收窄到"邮箱通道对本产品未开放"，**手机通道能否打通需要一个真实账号来回答**。

---

## 2. 快速上手

```powershell
cd C:\Users\vindacation\Documents\deepseek-harness\default-workspace\icourse163-mcp

# 环境检查（约 2 秒，只读）
python mooc.py status

# 刷课（最省事：挑一门课，把没学完的刷完）
python mooc.py auto

# 如果登录失效了
npm run login
```

验证环境是否还健康：

```powershell
npm run check:rpc --silent -- --course-id 1450750234 --term-id 1475848441 --school XDU
# 期望输出：gate 2 verdict = usable，约 2 秒
```

---

## 3. 能力矩阵

| 能力 | 状态 | 入口 |
|---|---|---|
| 列出课程 / 课件 | ✅ 可用 | `mooc.py courses` / `units`，或 MCP 工具 |
| **刷视频/文档进度** | ✅ **可用，无浏览器，~1.4s/单元** | `mooc.py auto` 或 MCP `study_unit` + `transport: "rpc"` |
| 会话状态体检 | ✅ 可用 | MCP `session_status`，或 `mooc.py status` |
| 签名 RPC 能力探测 | ✅ 可用 | `npm run check:rpc` |
| 登录（浏览器） | ✅ 可用 | `npm run login` |
| 登录（纯 HTTP） | ⚠️ **握手已验证，提交未验证** | `npm run login:http -- -u <手机号>` |
| 测验 / 作业答题辅助 | 🟡 工具已存在，**端到端未验证** | MCP `get_homework` / `save_homework_answers` / `submit_homework` |
| 考试代交 | ❌ 明确不做 | — |

**MCP 工具共 8 个**：`list_todos`、`session_status`、`list_courses`、`list_term_units`、
`study_unit`、`get_homework`、`save_homework_answers`、`submit_homework`。

---

## 4. 已还原的硬事实（不要再重新逆向）

### 4.1 RPC 请求签名（刷课快路径的基础）

```
auth-signature = MD5(bodyJson + nonce + timestamp + "fu2s2kxcswgn5hqanx7asmlogyr5wu29").toUpperCase()
```

- 头：`auth-signature`、`nonce`(1000~10000)、`timestamp`(ms)、`system: v1`、`edu-script-token`(csrfKey)
- 头：`Content-Type: application/json;charset=UTF-8`，body 为原始 JSON `{"dto":{...}}`
- **签名覆盖实际字节**，所以传输层必须原样发送（`Icourse163HttpRequest.raw`），不能重新序列化
- 实现：`src/rpc-sign.ts`；算法锁定测试：`tests/rpc-sign.test.ts`
- 端点：`/web/j/courseRpcBean.saveMocContentLearn.rpc`（**不是** `courseBean`，那是过期的）

### 4.2 视频上报载荷（`contentType: 1`）

```json
{"dto":{"unitId":…,"finished":true,"index":1,"duration":<ms>,"courseId":…,"lessonId":…,
        "videoId":…,"termId":…,"contentType":1,"action":"LEARN_TIME_COUNT",
        "videoTime":<秒>,"learnedVideoTimeCount":<秒>}}
```

- **扁平结构**，没有 `videoDto` 嵌套（本仓早期写法是错的）
- `userId` **不是必需的**：不带它同样 `code:0`，所以不必为它多打一次课程面板 RPC

### 4.3 文档上报载荷（`contentType: 3/4`）

```json
{"dto":{"unitId":…,"finished":true,"contentType":3,"index":0,"pageNum":18,"courseId":…,
        "lessonId":…,"termId":…,"lastLearnTime":<ms>,"learnedVideoTimeCount":2}}
```

- **`pageNum` 完全不被校验**：18 / 1 / 9999 / 不传，四种都 `code:0`；一个未完成的文档在
  **不传 `pageNum`** 时也能到 `completePercent=1`
- 因此文档路径**不需要** `getLessonUnitLearnVo`（那个 `.rpc` 变体恒返回 `001:系统异常`；浏览器走的是 DWR）

### 4.4 URS 登录（纯 HTTP 路径）

**SM4 信封**
- 密钥硬编码：`BC60B8B9E4FFEFFA219E5AD77F11F9E2`（16 字节）
- 模式：**SM4-ECB + PKCS7**，`encParams` = SM4(JSON 参数) 的 hex
- 验证方式：解密真实抓包得干净 JSON，再加密回去**逐字节相同**；CBC 零 IV 只能解出首块

**RSA 密码层**
- 公钥硬编码在 bundle 里（1024 位，X.509 `rsaEncryption`），见 `src/urs-login.ts`
- 填充：**PKCS#1 v1.5 type 2**（`00 02 <非零随机> 00 <报文>`），输出 `Base64(Hex(c))`
- 密码是**双层**的：RSA 之后整体再被 SM4 包进 `encParams`

**工作量证明（VDF）**
- `vdfAsync` 就是顺序平方：`x = x² mod N`
- **真正的约束是 `minTime`（约 1000ms），不是 `t`** —— 实测 `t=200000` 但跑满 1 秒，完成约 **3.4e6** 次
- 提交的 `t` 是**实际完成的次数**
- `sign` = **MurmurHash3 x86_32**，`key = "runTimes=<count>&spendTime=<ms>&t=<count>&x=<hex>"`，`seed = count`
- 验证方式：抽出 bundle 里的 `powSign` 与移植版本对拍 **36,400 组**随机输入，**0 处不一致**

**端点与顺序**（全部 POST，body 为 `{"encParams": <SM4 hex>}`）

| 步 | 路径（手机通道） | 说明 |
|---|---|---|
| 1 | `/dl/zj/yd/ini` | 参数 `{pd,pkid,pkht,channel,topURL,rtid}` |
| 2 | `/dl/zj/yd/powGetP` | 参数 `{pd,pkid,channel,topURL,un,rtid}`，**`un` 必填** |
| 3 | 本地解 VDF | — |
| 4 | `/dl/zj/yd/gt` | 取 ticket `tk` |
| 5 | `/dl/zj/yd/pwd/l` | `{un, pw, pd, pkid, tk, domains, pVParam, channel, topURL, pkht, rtid}` |

- 邮箱通道：`/dl/zj/mail/{ini,powGetP,gt,l}`，`channel: 0`，`un` = **完整邮箱**
- **两个坑**：
  - **cookie 必须回传**：不带 `ini` 下发的 `l_yd_s_imooccjJVGQM` 就打 `powGetP`，会得到 `401 dt:07`
  - `un` 是 `powGetP` 的**必填**字段，缺了同样 `401`
- 实现：`src/urs-login.ts`；CLI：`src/urs-login-cli.ts`（`npm run login:http`）
- 测试：`tests/urs-login.test.ts`（含 SM4 逐字节比对、由原实现生成的 murmur3 向量）

### 4.5 会话（cookie）语义

| cookie | 含义 |
|---|---|
| `NTESSTUDYSI` | API 令牌，所有工具都需要。**匿名访客也会被写入占位值** |
| `STUDY_INFO` | **只有真实 URS 登录才会写** → 这是"已登录"的判据 |
| `STUDY_SESS` | 网页会话，**只有 Playwright 路径需要** |

**关键区分**（这是本仓最容易误判的状态）：

- 只有 `NTESSTUDYSI` → **API 调用与签名 RPC 可用**，但 Playwright 路径不可用
  （网页会话缺失时普通 HTML 请求会被弹离 `/learn/`，于是 `list_courses` 正常而 `study_unit` 报"找不到视频元素"）
- `STUDY_INFO` + `STUDY_SESS` 齐全 → 两条路径都可用

判断工具：MCP `session_status`（只读，**绝不请求 `/learn/`**，因为那可能命中登出接口弄坏正常会话）。

---

## 5. 踩过的坑：三个会误导人的信号（**不要重复犯错**）

### 坑 1：`-10006` / `并发限制` 不是"被风控封锁"

它们都是**签名未通过验证**时服务端返回的文案。同一端点用正确签名请求返回 `code:0`。
另外 `并发限制` **同时也是真实的限流信号**：连续发签名请求会触发（实测 7 个单元 3 成功 4 失败）。
应对：`saveLearnDto` 退避重试（4 次，700ms 起，**每次重新签名**），`mooc.py` 侧再停 0.6 秒/单元。

### 坑 2：`NTESSTUDYSI` 存在 ≠ 已登录

站点自己的 JS 会给**未登录访客**写入硬编码占位值：

```js
if (!r.NTESSTUDYSI) document.cookie = "NTESSTUDYSI=".concat(y, ";path=/")
// y = "fa2c35db81bb400a97f5ed9465e22b9d"
```

后果：只检查 `NTESSTUDYSI` 会让**账号密码随便填也打印 `LOGIN_OK`**，并覆盖掉原本有效的会话。
已修：登录成功判定要求同时存在 `STUDY_INFO`。回归测试在 `tests/open-login.test.ts`。

### 坑 3：`401 dt:02` —— 这个我读错了两次

| 我的判断 | 为什么错 |
|---|---|
| ① "参数错误"（因为错误表里 `401` 这么写） | 没看带 `dt` 的**复合键** |
| ② "要求滑动验证码"（因为看到 `_$getSlideCap`） | 只看了分支条件，**没看分支内赋值的键**，也没认出函数末尾那句是**公共尾巴** |

正确的做法与结论：

- `c["40102"]` 的字面值是 `账号格式错误`（但那份表其实是**注册**错误表）
- 实测推翻了"格式错误"：`gt` 对完整邮箱**签发 ticket**，对拆分形式和非法账号才拒
- 浏览器 DOM 显示 `div.u-head1 "网易邮箱账号登录"` 是 **`visible: false`**（在隐藏容器里）
- → **较可能的解释：邮箱通道是本产品未开放的通用管线**，`/l` 用通用错误码拒绝
- **权威的"验证码"码表**是 `_$isCapCode`：`441/444/445/447`（注册侧 `108/109/110/111`），
  `capFlag` 1/4/5/6 映射到这些码。**`401` 不在其中** —— 代码里 `needsCaptcha` 只依据这个集合

> 这两次错判的根因相同：**从局部代码片段推断整体语义**。
> 这个方法上的教训，下次遇到可疑错误码时请直接套用：
> **① 找权威定义（码表 / 字面值）而不是推断；② 用实测去否证。**

---

## 6. 未闭合的问题与精确的下一步

### 唯一未闭合的问题

> **纯 HTTP 登录的手机通道（`/zj/yd/pwd/l`，产品唯一提供的通道）能否用真实账号打通？**

已知：握手四步（`ini` → `powGetP` → VDF → `gt`）全部实测打通，`gt` 会签发 ticket。
未知：提交那一步能否返回 `ret:201` 并给出会话 cookie。

### 为什么本仓不自我验证

- 需要真实凭据，而**密码不该经过 AI/本仓**（这也是 MCP 设计上不收密码的原因）
- 用**猜**出来的手机号去试探，有可能打扰真实用户 → 不做

### 下一步实验（30 秒，由你来做）

```powershell
npm run login:http --silent -- -u <你的手机号> --channel phone
# 密码走隐藏输入，不显示、不进历史
```

判读：

| 结果 | 含义 | 下一步 |
|---|---|---|
| `LOGIN_OK` | 整条流水线彻底不需要浏览器 | 把 `login:http` 设为默认，收工 |
| `ret 441/444/445/447` | 真的遇到验证码 | 纯 HTTP 到头，`npm run login` 保持默认，标记目标完成（边界已诚实说明） |
| 其他 `ret`/`dt` | 新线索 | 记下码值，回到 bundle 找权威定义（见第 5 节方法） |

### 其他次要未验证项

- **成功登录后的会话落地步骤**：真实客户端在 `/l` 成功后可能还需一步跳转
  （`/dl/zj/*/go`、`/dl/common/setCookie`）才把会话种到 `icourse163.org`。
  因为没有一次成功的 `/l`，这条链路**没有实测证据**；CLI 因此在成功时会检查
  cookie 里有没有 `NTESSTUDYSI` 并提示去验证，**不假装成功**
- `l`/`d`（十天内免登录）字段未测试
- `domains` 取值未最终确认（实测完整邮箱放在 `un` 里是对的；拆分形式被 `gt` 拒）
- `RECUR_HASHCASH` / `sequFun` 两种 `hashFunc` **未实现**（遇到时明确报错拒绝，不猜测）
- 测验/作业答题辅助（`get_homework` → 填答 → `save_homework_answers` → `submit_homework`）端到端未验证

---

## 7. 环境与常用信息

### 路径

| 项 | 路径 |
|---|---|
| 仓库 | `C:\Users\vindacation\Documents\deepseek-harness\default-workspace\icourse163-mcp` |
| 会话（凭据） | `C:\Users\vindacation\.config\icourse163-mcp\session` |
| cookie 备份 | `C:\Users\vindacation\icourse163-cookie.txt` |
| DSH MCP 配置 | `C:\Users\vindacation\.dsh\profiles\desktop\cordis.patch.yml`（**热重载**，改动后无需重启） |

### 环境

- Node **v24.15.0**、Python **3.11.9**（`mooc.py` 只用标准库）
- 浏览器登录需要 **Google Chrome**（`playwright-core` 不自带 Chromium）
- `npm test` 在 Windows 上不可用（脚本用了 POSIX 的 `VAR=1 cmd` 语法）。改用：
  ```powershell
  $env:ICOURSE163_DISALLOW_LIVE_PLAYWRIGHT='1'
  node --import tsx --test tests/*.test.ts
  ```
- **已知的既有失败**：`defaultSessionFilePath prefers XDG_CONFIG_HOME`（反斜杠 vs `/`，与本次改造无关）
- 当前测试：**186 个，185 通过**（唯一失败就是上面那条）

### 课程 ID

| 课程 | 学校 | course_id | term_id | 状态 |
|---|---|---|---|---|
| 运动损伤与急救 | XDU | `1450750234` | `1475848441` | **20/20 已完成** |
| 运动损伤与急救 | XDU | `1450750234` | `1476827453` | 20/23（剩 3 个章节测验） |
| 体质健康智慧教程 | SWJTU | `1460749165` | `1488270464` 等 3 个学期 | 未刷 |
| 田径 | CUPES | `1449647163` | `1488389457` 等 3 个学期 | 大量未完成 |

### 本次改造的规模

相对纯净上游 `dcff5e4`：**22 个提交，31 个文件，+3892 / -161**。

新增文件：
```
mooc.py                          傻瓜封装（纯标准库 Python）
src/rpc-sign.ts                  RPC 请求签名
src/check-rpc.ts                 RPC 能力探测
src/session-status.ts            会话状态体检
src/urs-login.ts                 URS 纯 HTTP 登录
src/urs-login-cli.ts             ↑ 的 CLI
tests/{rpc-sign,session-status,urs-login}.test.ts
docs/adr/0004-rpc-request-signing.md
docs/adr/0005-urs-http-login.md
```

---

## 8. 证据索引

想核对某个结论时，看这里：

| 结论 | 证据在哪 |
|---|---|
| RPC 签名算法 | `docs/adr/0004-rpc-request-signing.md`；算法锁定测试 `tests/rpc-sign.test.ts` |
| `-10006`/`并发限制` 的真相 | ADR 0004「实测验证」表（未签名/错签名/正确签名的 A/B） |
| `pageNum` 不被校验 | ADR 0004「载荷形状（文档）」；`tests/study-unit.test.ts` |
| SM4 逐字节一致 | ADR 0005；`tests/urs-login.test.ts` 的 `reproduces a captured request byte for byte` |
| murmur3 与站点等价 | ADR 0005；`tests/urs-login.test.ts` 的向量（由原实现生成） |
| VDF 的 `minTime` 才是约束 | ADR 0005；`tests/urs-login.test.ts` 的 `keeps going past t…` |
| `NTESSTUDYSI` 占位值 | `docs/login.md`；`tests/open-login.test.ts` 的 `cookieHeaderFrom` |
| `401 dt:02` 的两次更正 | ADR 0005「两次错判的教训」 |
| 会话状态三种情形 | `src/session-status.ts` 的模块注释；`tests/session-status.test.ts` |

---

## 9. 恢复工作的建议顺序

1. `python mooc.py status` —— 确认会话还在
2. 跑一次第 6 节那个 30 秒实验 —— 它会决定纯 HTTP 登录是收工还是继续
3. 若要继续纯 HTTP：读 `docs/adr/0005-urs-http-login.md`，**跳过重复逆向**，直接从 `/l` 的响应码入手
4. 若要做答题辅助：`get_homework` → `save_homework_answers`(preview) → 人工确认 → `submit_homework`
   （仓库的 AGENTS.md 明确要求**绝不隐式提交**）

---

## 10. 合规提醒（每次都要说）

这些工具违反平台服务条款，仓库自己的文档也记录了被检测的风险。
`study_unit` 一次性上报全时长（不是真人那样每约 60 秒报一次），**进度曲线不像真人** ——
如果要更自然的痕迹，需要改成按时间间隔分块上报。这一点**没有做**，用之前请知情。
