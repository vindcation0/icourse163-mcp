# ADR 0005：URS 登录的纯 HTTP 复现

状态：**部分完成**（握手与工作量证明已实测打通；密码提交被服务端拒绝，原因收窄到"邮箱通道未对本产品开放"，手机通道待用真实账号验证 —— 见"边界"）
日期：2026-10-14

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

## 边界（未解决）

**第 5 步被服务端拒绝：`{"ret":"401","dt":"02"}`。这个判断我改过两次，两次都记下来。**

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

### 第三次判断：**较可能是"该通道对本站未开放"**

`401/dt=02` 也不是"账号格式错误"，因为以下实测排除了格式因素：

| 实验 | 结果 |
|---|---|
| `un` = 完整邮箱 `zzz-...@example.com` / `@163.com` / `@qq.com` | `/gt` **签发 ticket**（`ret:201`），`/l` 回 `401 dt:02` |
| `un` = 本地部分 + `domains="@163.com"` / `"163.com"` / `"@example.com"` | `/gt` 回 `401 dt:10`（无 ticket） |
| `un` = 非法账号 `zzz-not-real-account-9f3a`（手机通道） | `/gt` 回 `401 dt:10` |

`gt` 是**会校验账号**的（拆分邮箱/非法账号都被它拒了），而它对完整邮箱放行、还签发了 ticket
——**格式没问题**。`/l` 却拒了同一个值。

再看浏览器 DOM：

```
div.u-head1 j-head          "网易邮箱账号登录"    ← visible: false（在隐藏容器里）
div.u-head2 j-head active   "网易手机账号登录"
```

**icourse163 的登录界面上，"网易邮箱账号登录"这个标签是隐藏的 —— 这个产品不向用户提供邮箱
登录。** 邮箱通道只是共享 URS 组件里的通用管线（所以 `ini`/`powGetP`/`gt` 都能通），
到了 `/l` 就被以通用错误码拒绝。

### 所以真正的未知收窄为一句话

**手机通道（`/zj/yd/pwd/l`，即产品真正提供的那条路）能否用真实账号打通，本仓无法自我验证。**
我没有、也不该有真实账号；而用一个"猜"出来的手机号去试探，有可能打扰到真实用户。

这一条只能由你用自己的账号跑一次来回答：

```bash
npm run login:http --silent -- -u <手机号> --channel phone
```

### 关于验证码

用 `_$isCapCode` 认定的验证码码是 **`441/444/445/447`**（注册侧对应 `108/109/110/111`），
以及 `capFlag` 1/4/5/6 到这些码的映射。**`401` 不在其中。**
本仓据此判定 `needsCaptcha`，不再从 `401` 推断。


## 决策与后果

1. 纯 HTTP 登录已实现为 `src/urs-login.ts`，入口 `npm run login:http`。它复用与浏览器登录
   相同的凭据存储，成功即可直接被 MCP 工具使用。
2. **浏览器登录保留为默认与回退。** 两者失败方式不同，且浏览器路径已验证可用。
3. **`--channel phone` 是默认值**，因为这是 icourse163 唯一提供的通道；`--channel mail` 保留
   但会在失败时明确说明该通道对本产品未开放，避免误导。
4. `needsCaptcha` 只依据 `_$isCapCode` 的码表（`441/444/445/447/108/109/110/111`）判定，
   **不从 `401` 推断** —— 从 `401` 推断是本 ADR 犯过的第二个错。
5. 未采纳的字段语义：`RECUR_HASHCASH` / `sequFun` 两种 `hashFunc` 未实现（遇到时明确报错拒绝，
   不猜测）。

## 两次错判的教训

同一个 `401` 我先后读成"参数错误"和"要求滑动验证码"，都是**从一个局部代码片段推断整体语义**：

- 第一次只看了错误表里的 `401` 条目，没看带 `dt` 的复合键；
- 第二次只看了分支条件，没看分支里真正赋值的那个键，也没看出函数末尾那句是公共尾巴。

改正的方法是**找权威定义**（`_$isCapCode` 的码表、`c["40102"]` 的字面值）而不是推断，
并且**用实测去否证**（`gt` 对完整邮箱签发 ticket 这一条直接推翻了"格式错误"）。
本仓前一个 ADR 已经在 `-10006` 上犯过同类错误 —— 这已是第二次，值得记下来。


## 尚未验证

- **成功登录后的会话落地方式未验证。** 真实客户端在 `/l` 成功后可能还需一步跳转
  （`/dl/zj/*/go`、`/dl/common/setCookie`）才把会话种到 `icourse163.org`。由于第 5 步没通过，
  这条链路没有实测证据，`urs-login-cli.ts` 因此在成功时会检查 cookie 里是否有 `NTESSTUDYSI`
  并明确提示用户去 `--check` 验证，而不是假装成功。
- `l`/`d`（十天内免登录）字段未测试。
- `domains` 字段的取值未确认（实测传空字符串未被判为参数错误，但这不足以证明它正确）。

## 复现方式

```bash
npm run login:http --silent -- -u <账号> --channel mail   # 密码走隐藏输入
```

`-p/--password` 可用但不推荐（会进进程列表）。密码只以 RSA 密文形式出现在 SM4 信封内。
