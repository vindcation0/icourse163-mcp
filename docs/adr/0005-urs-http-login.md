# ADR 0005：URS 登录的纯 HTTP 复现

状态：**部分完成**（握手与工作量证明已实测打通；密码提交被滑动验证码拦住，见"边界"）
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

**第 5 步被滑动验证码拦住，返回 `401` + `dt:"02"`。**

一开始我把 `401` 读成"参数错误"（bundle 的错误表里写着 `401:{message:"参数错误"}`），
这是错的。真正的处理分支是：

```js
f.__slideErrShowDefAndRefresh = function(e, t) {
  var r = t && t.dt;
  if ("401" == e && "02" == r) { o = c["40102"]; _ = null }   // 专门分支
  ...
  this._$getSlideCap(n);      // 拉起滑动验证码
};
```

也就是说 `401/dt=02` 的语义是**"先过滑动验证码"**，请求本身是被正确解析的。

**我无法判定触发条件**，因为：

1. 我只有一个必然不存在的账号（`@example.com`，IANA 保留域名）可用 —— 用它是为了不碰任何
   真实账号。服务端对不存在的账号回验证码，是常见的防枚举策略，所以这可能**只是**测试账号
   的后果。
2. 另一种可能是缺少网易易盾（`ac.dun.163.com`）的设备指纹，导致整条会话被判为可疑。
3. 要区分这两者，只能用**真实账号**。反复用真实账号试错还有触发风控/锁号的风险，
   所以这件事不应该由我在这里做。

## 决策与后果

1. 纯 HTTP 登录已实现为 `src/urs-login.ts`，入口 `npm run login:http`。它复用与浏览器登录
   相同的凭据存储，成功即可直接被 MCP 工具使用。
2. **浏览器登录保留为默认与回退。** 两者失败方式不同，且浏览器路径已验证可用。
3. 验证码不是"再逆向一下就能过"的东西：滑动验证码需要轨迹与行为特征，属于另一类工作量，
   且与"少一个浏览器依赖"的收益不成比例。**这里就停手是刻意的判断，不是能力边界。**
4. 未采纳的字段语义：`RECUR_HASHCASH` / `sequFun` 两种 `hashFunc` 未实现（本仓只在遇到时明确
   报错拒绝，不猜测）。

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
