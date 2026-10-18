# 交接报告：icourse163-mcp 的改造与 URS 逆向

> 面向"过一段时间回来继续"的场景。**先读第 1、2、6 节**就能接上；
> 第 4 节是已经逆向出来的硬事实，**不要再重新推导一遍**；
> 第 5 节是踩过的坑，**不要重复犯错**。
>
> 最后更新：2026-10-18 · 仓库状态：与 `origin/main` 同步，工作区干净
> （README 已改成"先讲用法、再讲技术"；本文只讲开发交接）
>
> **接手入口 → [STATUS.md](STATUS.md)**（2026-10-18 现状报告，一份够上手）
>
> **下一步做什么、代价多少 → 看 [ROADMAP.md](ROADMAP.md)**。它在 2026-10-18 按实测重排过，
> 写明"读题已验证、提交未验证"的准确边界。**本文第 3 节的能力矩阵已偏旧，以 ROADMAP 为准。**

---

## 1. 一句话现状

**整条流水线（登录 + 刷课）都不再需要浏览器了。**

- **刷课**：签名 RPC 通道，约 1.4 秒/单元，已实测
- **登录**：纯 HTTP 通道（`npm run login:http`），约 3.6 秒，**已实测产出可用会话**
  （`check:rpc` 报 `session ok`、`mooc.py status` 报可用）
- 浏览器登录保留为回退路径（能处理验证码）

前三次对 `401 dt:02` 的判断都是错的；真正的根因是**提交载荷里 `pVParam` 的结构**（应为嵌套对象，
不是 JSON 字符串）外加缺 `l`/`d` 两个字段。解法与三次错判的完整记录见
[docs/adr/0005-urs-http-login.md](adr/0005-urs-http-login.md)。

---

## 2. 快速上手

```powershell
cd C:\Users\vindacation\Documents\deepseek-harness\default-workspace\icourse163-mcp

# 环境检查（约 2 秒，只读）
python mooc.py status

# 刷课（最省事：挑一门课，把没学完的刷完）
python mooc.py auto

# 如果登录失效了（纯 HTTP，约 4 秒，不打开浏览器）
python mooc.py login
python mooc.py login --browser      # 需要处理验证码/短信时改用浏览器通道
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
| 登录（纯 HTTP） | ✅ **可用，无浏览器，~3.6s** | `python mooc.py login`（`npm run login:http -- -u <手机号> --channel phone`） |
| 登录后操作菜单 | ✅ 可用 | `python mooc.py login` 成功后输入序号 |
| 会话状态体检 | ✅ 可用 | MCP `session_status`，或 `mooc.py status` |
| 测验 / 作业答题辅助 | ✅ **读题 + 正式提交已 live 验证**（8/8 满分）；⚠️ 草稿态非通用 | MCP `get_homework` / `save_homework_answers` / `submit_homework` |
| 考试提交 | ⚠️ 默认关闭，需 `allow_exam: true` | 保持默认关闭 |

**答题的三条实测结论（2026-10-18，详见 [ROADMAP](ROADMAP.md) §0.3）：**

1. `submitAnswers` **不需要签名** —— 不带 `auth-signature` 的普通 JSON POST 直接成功
2. `preview:true` 对 `test.type=2` 的测验**被服务端拒绝**（"本试卷不支持草稿预览保存"），
   这类卷只能直接正式提交 ⇒ "先草稿后确认"的安全流程**不是通用的**
3. 答案映射要按 **`options[].content` 正文匹配**再取 `id`，不要写死选项顺序

**已知的产品选择**：密码输入**默认可见**（`--hide-password` 可关闭）—— 按使用者要求定的，
README 里如实标注了代价（回显会留在终端回滚区/录屏里）。

**MCP 工具共 13 个**：`list_todos`、`session_status`、`list_courses`、`list_term_units`、
`solve_quiz`、`solve_homework`、`list_discussion_units`、`reply_discussion`、`login`、
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

## 6. 已闭合：纯 HTTP 登录（原"未闭合问题"）

> **原来唯一的未闭合问题是"手机通道能否用真实账号打通"。答案：能。**

```powershell
npm run login:http --silent -- -u <手机号> --channel phone
# 约 3.6 秒 → LOGIN_OK has_cookie=true / 会话落地：API 令牌=有  网页会话=有
# 随后 check:rpc 报 session ok，mooc.py status 报可用
```

### 根因与两个关键步骤

1. **`pVParam` 必须是嵌套对象**，不是 JSON 字符串：

   ```json
   "pVParam": { "puzzle":"…", "spendTime":1000, "runTimes":320098,
                "sid":"…", "args":"{\"x\":\"…\",\"t\":320098,\"sign\":…}" }
   ```
   注意其 `args` 成员**本身是 JSON 字符串**。另外真实客户端还会发 `l:1, d:10`。
   （`pwdKeyUp` / `clientToken` 这条路**不发** —— 实测确认。）

2. **会话落地是必需的第二步**：`{"ret":"201"}` 只种 `.163.com` 的 cookie。
   再 `GET https://www.icourse163.org/`（会跳到 `/passport/logingate/changeCookie.htm`）
   → 得到 `STUDY_INFO`/`STUDY_SESS`/`STUDY_PERSIST`；再 `GET /member/login.htm` → 得到
   `NTESSTUDYSI`。已实现为 `ursLandSession()`。

3. **存储坑**：落地后完整 cookie 约 1703 字符，**超过 Windows 凭据管理器 2560 字节上限** →
   keychain 写入失败回退到文件，而 `getCookie` 优先读 keychain → 读到过期的短值，
   表现为"登录成功但工具报 auth_expired"。现在只保留 7 个必要 cookie（约 990 字符）。

### 为什么这次能解决

前三轮都在读混淆代码的局部片段推断语义。最后是**让真实客户端登录一次、抓下它自己的请求、
用已还原的 SM4 密钥解密** —— 一次拿到全部字段。

> **前半段把 SM4 密钥和算法完全还原，正是后半段能一步到位的前提。**
> 只抓包会卡在"看不懂密文"；只读代码就会在推断里打转。两者结合才是最短路径。

### 仍然未做

- `RECUR_HASHCASH` / `sequFun` 两种 `hashFunc` **未实现**（遇到时明确报错拒绝，不猜测）
- 验证码路径（`441/444/445/447`）未实测 —— 需人机交互，届时回退 `npm run login`
- 测验/作业答题辅助（`get_homework` → 填答 → `save_homework_answers` → `submit_homework`）
  端到端未验证

---

## 6.5 分块上报：已验证的语义 + 一个卡住的未知（**别再重跑这些实验**）

目标：让 RPC 上报不再"一次跳满"，改成每约 60 秒报一段，痕迹更接近官方客户端。
为此用签名 RPC 做了对照实验（**会真实推进课程进度**，所以下面记清结论，避免重复消耗）。

### 已确证（两次独立实验）

| 结论 | 证据 |
|---|---|
| **`finished: true` 本身就是"标记完成"的开关**，与已学秒数无关 | 368 秒的视频只报 `learnedVideoTimeCount=60, finished=true` → `completePercent` 直接变成 **1** |
| **`learnedVideoTimeCount` 是【增量】不是【总量】** | 单元原本约 5 秒，报 60 后变成约 **65** 秒（不是 60） |

第二条推翻了最初的假设 —— 分块上报**不能**每次报累计值。

### 卡住的未知：**只有第一次增量会被计入**

在两个不同单元、多种变化下，**第一次上报被计入，之后一律 0**：

| 变化 | 结果 |
|---|---|
| 相同数值，间隔 2.5 秒 / 20 秒 / 45 秒 | 全部 0 |
| **不同数值**（60 后立刻 90），间隔 3 秒 | 0（排除"数值去重"） |
| **等待 100 秒**后再报 | 0（**推翻"按墙钟限速"**） |
| 换一个**全新单元**重复 | 同样：第一次计入，第二次 0 |

### ✅ 已解决：根因是 `videoTime` 的语义（**分块上报现在已实现**）

**`videoTime` 是「播放位置」，不是总时长。** 服务端只在它**前进**时才计入；重复发同一个值
（包括总时长）会拿到 `{"code":0,"result":true}` 但**一分不记**。

这正是之前"只有第一次增量被计入"的全部原因 —— 我们每次都发同一个位置，服务端读作"没前进"。

**判定实验**（559 秒单元，learned 固定 60，只让位置前进）：

```
videoTime=60  → 65.0 秒
videoTime=120 → 125.0 秒
videoTime=180 → 185.0 秒
videoTime=240 → 245.0 秒     每步 +60，四次全部计入
```

这些上报**间隔只有 2.5 秒**，全部计入 —— 所以**根本不存在限速**。

**实现**（`src/study-unit.ts`）：

- `planVideoChunks(duration, chunk)` —— 纯函数，切出每段的
  `{learned_sec, position_sec, finished}`；位置严格递增，只有最后一段 `finished: true`
- `buildVideoLearnReport` 新增 `video_time_sec` / `finished`
- `study_unit` 新增 `report_chunk_sec`（MCP 参数）与 `mooc.py --chunk`
- 每段之间 `sleep(chunk / playback_rate)` —— **这段真实耗时就是它存在的意义**
- 中途失败时**如实报告已报了多少秒**（已报的部分服务端确实已记），而不是假装整体失败

**实测**（单元 `1305151991`，337 秒，`chunk=60`、`rate=2`）：耗时 153 秒、
`report_chunks: 6`、`percent: 100`，单元已完成。

> ⚠️ **仍未做**：**文档单元的节奏**。文档路径的等待逻辑依赖 `pageCount`，而它只来自那个
> 恒失败的 `learnVo`，所以 RPC 下永远不触发。下一步应先探明文档是否也靠某个"前进"字段
> 计入（`lastLearnTime` / `pageNum`），再决定实现方式 —— 不要照搬视频的做法。

### 怀疑方向已被实测否定：**没有第二个端点**

用登录流程的持久化 Chrome profile（它的会话能打开 `/learn/`，而存储的 cookie 不能，见 6.6）
真实播放并抓**全部**请求，两条上报都是同一个 `saveMocContentLearn`：

```
+29.1s  unitId=1307450283  finished=true   duration=60000  videoTime=368  userId:"<已隐去>"
+96.7s  unitId=1307450284  finished=false  duration=60000  videoTime=3    userId:"<已隐去>"
```

由此确证的事实：

- **渐进进度就是 `saveMocContentLearn`**，不存在另一个心跳端点
- **间隔约 60 秒**，与 `duration: 60000` 一致
- **进行中用 `finished:false`；完成用 `finished:true`**
- 真实报文**带 `userId`**

**但 `userId` 不是解锁增量的钥匙**：带着它连发两次 `finished:false`，完成度依然 0。

### 已排除的解释（**不要再重复试**）

| 假设 | 结论 |
|---|---|
| 数值去重 | ❌ 不同数值（60→90）也 0 |
| 按墙钟限速 | ❌ 等 100 秒再报依然 0 |
| 单元状态累积 | ❌ 全新单元同样只计第一次 |
| 缺 `userId` | ❌ 带上依然 0 |
| 另有上报端点 | ❌ 抓包证明只有这一个 |

**剩下的方向**：在**未完成单元**上做一次完整的真实播放抓包（跨越 2 个以上上报周期），
直接看真实客户端连续两次增量在服务端如何体现。代价是它会推进那个单元的进度。

### ⚠️ 这些实验已经动过的进度（只增不减）

| 单元 | 课程/学期 | 变化 |
|---|---|---|
| `1307450283` 3.1 短跑项目发展历史 | 1460749165 / 1476706446 | 17.66% → **100%** |
| `1305151991` 2.5 上肢力量的练习及其方法 | 1460749165 / 1475624483 | 约 5 秒 → 约 65 秒 |
| `1305177003` 3.8 立定跳远动作要领 | 1460749165 / 1475624483 | 约 125 秒 → 约 185 秒 |

**不要再用"发报告看完成度"这种会改数据的实验。**

---

## 6.6 两个会话层：API 能用 ≠ 网页能用（**重要，与直觉相反**）

纯 HTTP 登录得到的会话：**API 完全可用，但打不开学习页**。

```
GET /learn/SWJTU-1460749165?tid=1476706446      （用存储的 cookie）
  → 302 /passport/member/logout.htm?lgoutp=1&returnUrl=...
同一个 cookie 调 RPC API
  → {"code":0, ...}   ✅ 可用
```

而**登录流程的持久化 Chrome profile**（`~/.icourse163-mcp/chrome-profile`）：

```
/learn/ → 停在 /learn/#/learn/announce   ✅ 能打开
（注意：它的 cookie 里既没有 STUDY_SESS，也没有 NTESSTUDYSI）
```

**结论：**

1. **`session_status` 原本的 `browser_path_ready` 是过度声称**（已改名为 `web_session_markers`）
   —— 它只检查 `STUDY_INFO`+`STUDY_SESS` 是否存在，但这两个都在时 `/learn/` 照样被弹走；
   反过来 profile 里**没有** `STUDY_SESS` 却能打开。**cookie 存在 ≠ 网页可用。**
   而真正的探活（请求 `/learn/`）会命中登出接口、可能反过来弄坏会话，所以不能这么做。
2. **纯 HTTP 登录之后，Playwright 回退路径不可用。** 需要浏览器路径时必须先
   `npm run login`（浏览器登录）。

> ⚠️ 反复请求 `/learn/` 有可能就是在破坏网页会话 —— 这一轮多次探测之后，
> **原本可用的用户原始 cookie 也变成被弹去登出了**。以后不要用 `/learn/` 做探活。

### 另一个坑：存储有两个真相来源

| 来源 | 内容 |
|---|---|
| keychain | 裁剪后的 **990 字符 / 7 个** cookie（能塞进 2560 字节上限，所以写成功） |
| 文件 | 更早写入的 **1703 字符 / 17 个**（超出上限，所以留在文件里） |

`getCookie()` **优先读 keychain** → 实际生效的是 990 那个；但直接读文件的探针会拿到 1703 那个。
**排障前先确认自己读的是哪一个**，否则会得出错误结论（这一轮我就因此做过一次不可比的 A/B 对照）。

另外：**已存在会话时浏览器登录会失败** —— 首页不再显示「登录」入口，报
`password login: login control not found on homepage`。要用浏览器登录，先清掉存储的会话
或那个持久化 profile。

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

---

## 11. 通道路径与目录结构（从 README 搬来，README 已只留使用说明）

### 11.1 通道路径

| 通道 | 用途 | 耗时 | 依赖 |
|---|---|---|---|
| **签名 RPC** | 刷视频/文档进度 | ~1.4 秒/单元 | 仅 HTTP |
| **URS 纯 HTTP** | 登录 | ~4 秒 | 仅 HTTP |
| **旧版 RPC** | 读题、交卷、目录 | ~1–3 秒 | 仅 HTTP |
| **新版 Next.js API**（`/front-mooc-learn/api/learn/*`） | 讨论区 | ~1–2 秒 | 需**浏览器登录**的会话 |
| Playwright | 回退：验证码、疑难导航 | ~30 秒 | Chrome + 可用网页会话 |

`mooc.py` 只是 Python 封装：通过 stdio 驱动本仓 MCP 服务器（刷课）并调用 Node CLI（登录），
所以**密码永远不经过 MCP 或 AI**。

### 11.2 目录结构

```text
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
src/study-playwright.ts  浏览器路径
scripts/run-mcp.sh|.cmd  MCP 启动包装（给没有 cwd 的客户端用）
scripts/build-exe.py     打包 exe
docs/STATUS.md           接手入口：现状 / 硬事实 / 危险动作
docs/ROADMAP.md          优先级与代价
docs/mcp.md              工具契约与状态码语义
docs/adr/                架构决策记录（含逆向证据）
```
