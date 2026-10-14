# ADR 0005：URS 登录的纯 HTTP 复现

状态：**已完成**（2026-10-14）。纯 HTTP 登录产出完全可用的会话，实测 `check:rpc` 报
`session ok`、`mooc.py status` 报可用 —— **整条流水线不再依赖浏览器**。

日期：2026-10-14

> 本文保留了三次错误判断的完整记录。三次的根因相同（**从局部代码片段推断整体语义**），
> 而最终解决问题的不是推断，是**让真实客户端把报文交出来**。这一节在最后，值得先读。

---

## 结论：根因与最终解法

`/l` 一直返回 `{"ret":"401","dt":"02"}`。真正的原因是**提交载荷里 `pVParam` 的结构错了**，
另有两个字段缺失。这些都不是推断出来的 —— 而是**让浏览器用真实账号登录一次，抓下它自己的
`/dl/zj/yd/pwd/l` 请求，再用 SM4 密钥解密**，直接读出了权威字段集合：

```json
{"l":1, "d":10, "un":"<手机号>", "pw":"<RSA 密文>", "pd":"imooc", "pkid":"cjJVGQM",
 "tk":"c8dad9394f8fcf37b263fafa377a734c", "domains":"",
 "pVParam":{ "puzzle":"woVmIfMm…",
             "spendTime":1000, "runTimes":320098,
             "sid":"15a3970d-d3e3-4dea-aa34-d9d44fd6ba1d",
             "args":"{\"x\":\"6235fc07…\",\"t\":320098,\"sign\":3006890133}" },
 "channel":1, "topURL":"…", "rtid":"…"}
```

三处与我原来的实现不同：

| 项 | 我原来的写法 | 权威值 |
|---|---|---|
| **`pVParam`** | `JSON.stringify({x,t,sign})` —— 一个**扁平字符串** | **嵌套对象**，含原始 `puzzle`、`sid`、`spendTime`、`runTimes`，且其 `args` 成员**本身是 JSON 字符串** |
| `l` / `d` | 完全没发 | `l:1, d:10`（十天内免登录） |
| `pwdKeyUp` / `clientToken` | 我以为缺了它们 | **这条路根本不发**（`clientToken` 只在 `ini` 响应带 `watchman:"1"` 时才要，本站没有） |

### 会话落地（第二步，同样必需）

`{"ret":"201"}` **本身不是可用会话** —— URS 只种 `.163.com` 域的 cookie。icourse163.org 的会话
是它自己换来的，而触发它的正是浏览器登录后落到的页面。实测两步：

```
GET https://www.icourse163.org/
  → 跳转 /passport/logingate/changeCookie.htm?type=ursCellphone…
  → 种下 STUDY_INFO / STUDY_SESS / STUDY_PERSIST
GET https://www.icourse163.org/member/login.htm
  → 种下 NTESSTUDYSI（所有 RPC 工具都需要的 API 令牌）
```

### 存储上的一个坑

落地后的完整 cookie 约 1703 字符，**超过 Windows 凭据管理器 2560 字节的上限**，于是 keychain
写入失败、回退到文件，而 `getCookie` 优先读 keychain —— 结果读到一个更短的**过期**值，
表面上"登录成功"但工具报 `auth_expired`。

解法：落地后只保留 icourse163 真正用到的 7 个 cookie（`NTESSTUDYSI`、`STUDY_INFO`、`STUDY_SESS`、
`STUDY_PERSIST`、`EDUWEBDEVICE`、`NETEASE_WDA_UID`、`NTES_YD_PASSPORT`），约 990 字符，
舒适地落在上限内。URS 那些 `.163.com` cookie 对 icourse163.org 毫无意义。

### 实测结果

```bash
npm run login:http --silent -- -u <手机号> --channel phone   # 约 3.6 秒，无浏览器
# LOGIN_OK has_cookie=true / 会话落地：API 令牌=有  网页会话=有
npm run check:rpc -- --course-id … --term-id … --school …    # session ok，term catalog ok
```


## 背景

到 ADR 0004 为止，`study_unit` 的 RPC 通道已经不需要浏览器，但**登录仍然需要**：`npm run login`
用 Playwright 驱动 Chrome 走 `reg.icourse163.org` 的登录组件（URS）。这留下一个突兀的依赖——
整条流水线只有这一个环节要起浏览器。

本文记录把这些请求在 Node 里复现出来的过程与结果。

## 目标组件

登录 iframe 加载的是 `https://webzj.netstatic.net/webzj_cdn101/pp_index_dl_<hash>.js`
（配置 `pkid=cjJVGQM`、`product=imooc`、`channel=1`）。该组件把**几乎所有**参数塞进一个叫
`encParams` 的字段里。

## 加密方案（全部经真实报文验证）

### SM4 信封

bundle 里：

```js
var _sm4pubkey = "BC60B8B9E4FFEFFA219E5AD77F11F9E2";   // 16 字节
_p._$sm4Encrypt = function(e){ return window.URSSM4.encrypt(JSON.stringify(e), _sm4pubkey) };
```

`_$getSmState()` 对 icourse163 返回真（`window._$URSSMCONFIG.opensm === true`），所以 SM4 生效。

**模式判定为 SM4-ECB + PKCS7，验证方式有两个方向：**

| 实验 | 结果 |
|---|---|
| 用该密钥解密一条真实抓到的 `encParams`（160 字节 = 10 个分组） | 解出干净的 JSON，末尾 8 字节 `08` 为 PKCS7 填充 |
| 用该密钥重新加密那个 JSON | 与抓到的密文**逐字节相同** |
| 同一密文按 CBC（零 IV）解 | 只有首个分组正常，其余为乱码 → 排除 CBC |

解出的明文：

```json
{"pd":"imooc","pkid":"cjJVGQM","pkht":"www.icourse163.org","channel":1,
 "topURL":"https://www.icourse163.org/","rtid":"8eS7nbTDMxOw8qXatjDTYBtGdRZLJR5A"}
```

`rtid` 即 `window._$RTID`，32 位随机字母数字（对应 `_p.getRtid`）。

### 密码的 RSA 层

密码**不**出现在 SM4 明文里，而是单独 RSA 加密后放进 `pw`：

```js
encrypt:  function(e,t){ var n = RSA.getPublicKey(i); return RSA.encrypt(e + "`" + t, n) },
encrypt2: function(e)  { var t = RSA.getPublicKey(i); return RSA.encrypt(e, t) },   // 登录用这个
```

公钥硬编码在 bundle 里（`var h = "-----BEGIN PUBLIC KEY-----MIGf...-----END PUBLIC KEY-----"`），
1024 位。`RSA.encrypt` 的填充由 `pkcs1pad2` 构造 —— 标准 **PKCS#1 v1.5 type 2**
（`00 02 <非零随机> 00 <报文>`），输出为 `Base64.encode(Hex.decode(c.toString(16)))`。

因此密码是**双层**的：RSA 之后整体再被 SM4 包进 `encParams`。

### 工作量证明（VDF）

`powGetP` 返回：

```json
{"ret":"201","pVInfo":{"needCheck":true,"sid":"<uuid>","hashFunc":"VDF_FUNCTION",
 "minTime":1000,"maxTime":1050,
 "args":{"mod":"6dedd454569820554de7e932571d925f7b","t":400000,
         "puzzle":"<base64>","x":"363e4c8145"}}}
```

`vdfAsync` 的算法就是顺序平方，不可并行：

```js
for (var i = 0; i < t || Date.now() - startTime < data.minTime; i++) {
  bigx = bigx.multipliedBy(bigx).mod(bigmod);   // x = x² mod N
  count++;
  if (Date.now() - startTime > data.maxTime) break;
}
```

**`minTime` 才是真正的约束，不是 `t`**：实测 `t=200000` 但循环跑满 1000ms，得到
`count≈3.4e6`。提交时 `t` 被写成实际完成的 `count`。

提交的 `sign` 来自 `powSign(key, seed)`，即 **MurmurHash3 x86_32**：

```
key  = "runTimes=<count>&spendTime=<ms>&t=<count>&x=<hex>"
seed = count
```

**验证方式**：把 bundle 里的 `powSign` 原样抽出，与移植版本对拍 **36,400 组**随机输入
（覆盖 `remainder` 的全部 0..3 分支，以及真实形状的 `runTimes=…&spendTime=…` 键），
**0 处不一致**。测试里保留了若干由原实现生成的向量作为回归锚点。

结果挂在登录请求的 `pVParam` 字段上：

```js
if (this.__requirePV && this.__powerData) { t.pVParam = this.__powerData; }
```

（`__requirePV` 来自 `ini` 响应里的 `pv:true`。）

## 端点与顺序

bundle 内的接口映射表（节选）：

```js
"mb-ini":            { path:"/zj/yd/ini",     channel:1 },
"mb-login-getPower": { path:"/zj/yd/powGetP", channel:1 },
"mb-gt":             { path:"/zj/yd/gt",      channel:1 },
"mb-login":          { path:"/zj/yd/pwd/l",   channel:1 },   // 密码登录
"safelogin":         { path:"/zj/mail/l",     channel:0 },   // 邮箱通道
```

实测走通的顺序：

| 步 | 请求 | 实测结果 |
|---|---|---|
| 1 | `POST /dl/zj/yd/ini` `{pd,pkid,pkht,channel,topURL,rtid}` | `{"ret":"201","capFlag":0,"pv":true,"capId":""}` ✅ |
| 2 | `POST /dl/zj/yd/powGetP` `{pd,pkid,channel,topURL,un,rtid}` | 返回 VDF 挑战 ✅ |
| 3 | 本地解算 | 1000ms，`count≈3.4e6` ✅ |
| 4 | `POST /dl/zj/yd/gt` | `{"ret":"201","tk":"e9d4470245f8b82701dfdd50c92c04bf"}` ✅ |
| 5 | `POST /dl/zj/yd/pwd/l` `{un,pw,tk,pVParam,…}` | `{"ret":"401","dt":"02"}` ⚠️ |

### 两个踩到的坑

- **cookie 必须回传。** 不带 `ini` 下发的 `l_yd_s_imooccjJVGQM` 就打 `powGetP`，会得到
  `{"ret":"401","dt":"07"}`。这是"会话与 rtid 绑定"，不是参数错误。
- **`un` 是 powGetP 的必填字段**（账号前 12 字符）。缺了同样 `401`。

## 边界：`401 dt:02` 的三次错判（最终已解决）

**第 5 步曾经一直被服务端拒绝：`{"ret":"401","dt":"02"}`。这个判断我改过三次，三次都记下来，
因为最终解决它靠的不是推断。** 正确解释见文首「结论：根因与最终解法」—— 是 `pVParam`
结构错误，与账号、通道都无关。

### 第一次判断（错）："参数错误"

bundle 的登录响应表写着 `401:{message:"参数错误"}`，我据此下了结论。

### 第二次判断（也错）："要求滑动验证码"

我发现 `__slideErrShowDefAndRefresh` 里有 `if("401"==e && "02"==r)` 的专门分支，就据此
断定 `dt:02` 表示"先过滑动验证码"。

**我漏看了那个分支里的前一行赋值，也漏看了函数末尾那句是公共尾巴：**

```js
f.__slideErrShowDefAndRefresh = function(e, t) {
  var r = t && t.dt;
  var o = s[e] || a._$getErrorTxt(e);          // ← 默认文案
  var _ = {name:"slide"};
  if ("401" == e && "02" == r) { o = c["40102"]; _ = null }   // ★ c["40102"] 才是真正的文案
  if (!i) a._$showError(_, o, "nerror");
  this._$getSlideCap(n);                        // ← 所有分支都会执行，不是 dt:02 专属
};
```

而那份错误表（@169152）里写着：

```js
401:"操作超时，请刷新页面重试",
40110:"账号格式错误",
40101:"账号格式错误",
40102:"账号格式错误",
```

所以 `c["40102"]` 的文案是 **`账号格式错误`**。另外那份表里全是 `注册`/`该账号已注册`/
`该手机号码绑定账号过多` 之类的条目 —— 它是**注册**错误表，登录流程复用了同一个处理器。

### 第三次判断：**"该通道对本站未开放"（也错）**

`401/dt=02` 也不是"账号格式错误"，因为以下实测排除了格式因素：

| 实验 | 结果 |
|---|---|
| `un` = 完整邮箱 `zzz-...@example.com` / `@163.com` / `@qq.com` | `/gt` **签发 ticket**（`ret:201`），`/l` 回 `401 dt:02` |
| `un` = 本地部分 + `domains="@163.com"` / `"163.com"` / `"@example.com"` | `/gt` 回 `401 dt:10`（无 ticket） |
| `un` = 非法账号 `zzz-not-real-account-9f3a`（手机通道） | `/gt` 回 `401 dt:10` |
| **`un` = 真实账号（形如 `yd.<hash>@163.com`，手机注册账号的网易邮箱别名），配故意写错的密码** | `/gt` 签发 ticket，`/l` 仍回 `401 dt:02` |
| **`un` = 真实手机号 + 真实密码（手机通道）** | **仍然 `401 dt:02`** |

最后一行彻底否掉了"账号/通道"这类解释：**真实账号 + 正确密码也失败**，说明问题在**请求本身**。

我当时的结论（"邮箱通道对本产品未开放"）虽然对**邮箱通道**成立，但把它当成 `dt:02` 的原因
是错的 —— `dt:02` 与账号、通道都无关，是 **`pVParam` 结构错误**导致的参数校验失败。
（顺带：`dt:10` 确实是格式错误，`/gt` 那一步会校验账号格式。）

### 三次错判的共同根因

同一个 `401`，我先后读成"参数错误"、"要求滑动验证码"、"通道未开放"。三次都是**从局部代码片段
推断整体语义**：

- 第一次只看了错误表里的 `401` 条目，没看带 `dt` 的复合键；
- 第二次只看了分支条件，没看分支里真正赋值的键，也没认出函数末尾那句是公共尾巴；
- 第三次把"邮箱标签隐藏"这个正确的观察，错误地当成了 `dt:02` 的解释，而没有去**验证**
  请求本身是否完整。

**真正的解法不是继续推断，而是让真实客户端把报文交出来**：用真实凭据让浏览器登录一次，
抓下 `/dl/zj/yd/pwd/l`，用已经拿到手的 SM4 密钥解密。一次就看清了全部字段。

这三件事请按顺序做：

1. **找权威定义**（码表、字面值、真实报文），而不是从调用点推断；
2. **用实测去否证**（`gt` 对完整邮箱签发 ticket 这一条，就直接推翻了"格式错误"和"通道问题"）；
3. **当推断反复失败时，去拿第一手报文** —— 抓包/解密比继续读混淆代码快得多。

本仓已在前一个 ADR（`-10006`）犯过同类错误。这是第二次和第三次，值得永久记下。


### 关于验证码

用 `_$isCapCode` 认定的验证码码是 **`441/444/445/447`**（注册侧对应 `108/109/110/111`），
以及 `capFlag` 1/4/5/6 到这些码的映射。**`401` 不在其中。**
本仓据此判定 `needsCaptcha`，不再从 `401` 推断。


## 决策与后果

1. 纯 HTTP 登录已实现为 `src/urs-login.ts`，入口 `npm run login:http`。它复用与浏览器登录
   相同的凭据存储，**实测产出可用会话**：`check:rpc` 报 `session ok`，`mooc.py status` 报可用。
2. 因此**整条流水线（登录 + 刷课）都不再依赖浏览器**。浏览器登录仍保留为回退：两者失败方式
   不同，且浏览器路径有它自己的价值（能处理验证码）。
3. **`--channel phone` 是默认值**（icourse163 唯一提供给用户的通道）。`--channel mail` 保留，
   但在 `/l` 上会被拒（邮箱标签在本产品被隐藏），CLI 会说明。
4. `needsCaptcha` 只依据 `_$isCapCode` 的码表（`441/444/445/447/108/109/110/111`）判定，
   **不从 `401` 推断**。
5. 会话落地（`ursLandSession`）只保留 7 个 icourse163 用得到的 cookie，既去掉无用的 URS cookie，
   也避开 Windows 凭据管理器 2560 字节上限那个坑。
6. 未采纳的字段语义：`RECUR_HASHCASH` / `sequFun` 两种 `hashFunc` 未实现（遇到时明确报错拒绝，
   不猜测）。`pwdKeyUp` / `clientToken` 经实测确认这条路不发，故不实现。

## 尚未验证

- **真实账号 + 正确密码下的手机通道已验证成功**（见文首实测结果）。
- 邮箱通道（`--channel mail`）仍不可用 —— 不是实现问题，是 icourse163 不提供邮箱登录。
- `domains` 字段的取值：实测传空字符串可用 ✓（与浏览器抓包一致）。
- `l`/`d`：实测浏览器发 `l:1, d:10`，本仓照发 ✓。
- 验证码路径（`441/444/445/447`）未实测 —— 需要人机交互，届时按设计回退到 `npm run login`。

## 复现方式

```bash
npm run login:http --silent -- -u <手机号> --channel phone   # 密码走隐藏输入，约 3.6 秒
```

`-p/--password` 可用但不推荐（会进进程列表）。密码只以 RSA 密文形式出现在 SM4 信封内。

## 附：为什么最终靠抓包而不是读代码

前三次判断都来自阅读混淆代码的局部片段。真正解决时用的是：**让真实客户端登录一次，
抓下它自己的请求，用已经拿到手的密钥解密**。一次就得到全部字段。

这个方法之所以可行，恰恰是因为前面的工作已经把 SM4 密钥和算法完全还原了 ——
**前半段的逆向没有白做，它是后半段能一步到位的前提**。
如果一开始就去抓包解密，会在"看不懂密文"处卡住；如果一直只读代码，就会像这三次一样在
推断里打转。两者结合才是最短路径。

