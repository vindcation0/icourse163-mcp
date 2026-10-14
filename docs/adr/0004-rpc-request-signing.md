# ADR 0004：RPC 通道的失败原因是缺少请求签名（已定位并验证）

日期：2026-10-14
状态：**已实测解决**（本机、单账号）
取代：本 ADR 的初版结论（"纯 HTTP 协议模拟做不到，闸门在客户端证明"）**是错的**，已作废。

## 结论先行

`saveMocContentLearn` 从来没有被风控封死。它一直是可用的，只是本仓的请求**缺少四个签名头**，
服务端因此拒收。

```
未签名 → 200 {"code":-2,"message":"请检查本地时间是否和北京时间一致-10006"}
已签名 → 200 {"code":0,"result":true}
```

**`-10006`（"请检查本地时间"）和 `并发限制，请稍后再试` 都是签名校验失败时的文案**，
不是反作弊判定。这两个误导性错误码是本 ADR 初版误判的根源，也是上游仓长期认为"RPC 不可用"的原因。

## 真实契约（从浏览器流量捕获）

### 端点与编码

```
POST /web/j/courseRpcBean.saveMocContentLearn.rpc?csrfKey=<NTESSTUDYSI>
Content-Type: application/json;charset=UTF-8
```

注意 bean 是 **`courseRpcBean`**；本仓原先打的是 `courseBean`（旧的、已废弃的变体）。
body 是**裸 JSON**，不是 `dto=<urlencoded>`。

### 必需的签名头

```
edu-script-token: <NTESSTUDYSI>          （等同 csrfKey）
timestamp:        <毫秒时间戳>            （参与签名）
nonce:            <1000..10000 的随机整数> （参与签名）
system:           v1
auth-signature:   <见下>
```

### 签名算法

从站点 bundle `reactBase-49d0a293.fa9b5e55.js` 反出：

```js
g = function (t) {
  var a = t.Timestamp || +new Date,
      u = t.Nonce || (Math.floor(9000 * Math.random()) + 1000),
      c = t.body ? JSON.stringify(t.body) : "",
      s = c + u + a + "fu2s2kxcswgn5hqanx7asmlogyr5wu29";   // 硬编码密钥
  return HASH(s).toLocaleUpperCase();
};
```

即：

```
auth-signature = MD5( <body 的 JSON 原文> + <nonce> + <timestamp> + "fu2s2kxcswgn5hqanx7asmlogyr5wu29" )
                 转大写
```

其中 `<body 的 JSON 原文>` 就是即将发送的完整 body 字符串（`{"dto":{...}}`），必须与实际发送的
字节完全一致。

**算法已用实测样本逐字节验证**：捕获到的 `body(267 字节) + nonce=8508 + timestamp=1791965599916`
经 MD5 得到的 `AD771CA3DBAA099FE9C99973C3CE27AD` 与浏览器实际发出的 `auth-signature` **完全一致**
（sha1/sha256/sha512/ripemd160 均不匹配）。

### 载荷形状（视频）

```json
{"dto":{
  "unitId":1305575052, "finished":true, "index":1, "duration":60000,
  "courseId":1450750234, "lessonId":1265444035, "videoId":1216009818,
  "termId":1475848441, "userId":"…", "contentType":1,
  "action":"LEARN_TIME_COUNT", "videoTime":1126, "learnedVideoTimeCount":60
}}
```

要点：

- 扁平字段，**没有** `videoDto` 嵌套（本仓原先的写法是错的）。
- `action: "LEARN_TIME_COUNT"` 表明这是**增量**上报：浏览器每约 60 秒报一次
  `learnedVideoTimeCount`，进度按块累加。这解释了为什么真播推进是跳跃式的。
- `videoTime` = 视频总秒数；`duration` = 本次上报对应的毫秒数。
- `userId` 出现在浏览器报文里，但**不是必需的**：不带它同样返回 `code:0`（实测），
  所以不需要为它多打一次课程面板 RPC。

### 载荷形状（文档 / PDF / PPT）

同一端点，同一签名，字段不同（在一份 PDF 上翻页时捕获）：

```json
{"dto":{
  "unitId":1305575053, "finished":true, "contentType":3, "index":0, "pageNum":18,
  "courseId":1450750234, "lessonId":1265444035, "termId":1475848441,
  "lastLearnTime":1791966259056, "learnedVideoTimeCount":2
}}
```

要点：

- `contentType` 沿用单元类型（3 = PDF/PPT，4 = 富文本）。
- **`pageNum` 不被校验**：实测 `18` / `1` / `9999` / 不传，四种都返回 `code:0`；一个原本
  `completePercent=0` 的文档在**不传 `pageNum`** 的情况下也到达了 `completePercent=1`。
  因此文档路径不需要知道真实页数，也就摆脱了对坏掉的 `getLessonUnitLearnVo` 的依赖。
- `lastLearnTime` 是毫秒时间戳；`learnedVideoTimeCount` 是本次学习秒数（文档也复用该字段名）。

### `getLessonUnitLearnVo` 不是 RPC

浏览器走 DWR，本仓走一个不存在的 `.rpc` 变体，因此恒返回 `001:系统异常`：

```
浏览器: POST /dwr/call/plaincall/CourseBean.getLessonUnitLearnVo.dwr   (text/plain)
本仓:   POST /web/j/courseBean.getLessonUnitLearnVo.rpc                → 001:系统异常
```

由于视频有目录 `durationInSeconds`、文档的 `pageNum` 又非必需，这个接口在本仓的两条路径上
都不再是阻塞项。

视频路径本来就有目录 `durationInSeconds` 兜底，所以不受影响；文档路径需要 `textPages`，才是真正
受影响的。

## 实测验证

| 实验 | 结果 |
|---|---|
| 未签名请求（本仓原样） | `-2 请检查本地时间是否和北京时间一致-10006` |
| 逐字节重放浏览器报文，**不带**签名头 | `-2 -10006` |
| 逐字节重放，**带**捕获到的签名头（但 timestamp 已过期） | `-2 并发限制，请稍后再试` |
| **本地重新计算签名**，全新 timestamp/nonce | **`code:0 result:true`** |
| 签名故意写错 | `-2 并发限制，请稍后再试`（← 注意这个错误码会骗人） |

端到端结果：单元 `1305575062` 的 `completePercent` 由 **0.6729699666295884 → 1**，
`viewStatus=5`，**一次 HTTP 调用、毫秒级、无浏览器**。

该课程（`1450750234/1475848441`）20 个视频+文档因此全部达到 `completePercent=1`。

## 决策与后果

1. **已实现签名**（`src/rpc-sign.ts`），视频与文档两条 RPC 路径都已打通。实测：
   - 视频 `1305575052`：`transport=rpc` → `status=ok completed=true percent=100`，**1.42 秒**
   - 文档 `1308829002`（**另一个学期**，原本 `completePercent=0`）：一次调用 **0 → 1**
   - 同一文档经 `study_unit` + `transport=rpc`：**1.46 秒**（浏览器路径约 30 秒）

   提速 20 倍以上，且不再需要 Chrome，也不再依赖那个反复失效的网页会话。
2. `transport=auto` 的回退设计保留且必要：若站点轮换签名密钥或算法，签名请求会重新开始被拒，
   `auto` 会自动降回浏览器路径。
3. **`pageNum` 不被服务端校验**（实测 18 / 1 / 9999 / 不传，四种都 `code:0`；且一个未完成文档
   在不传 `pageNum` 时也能到达 `completePercent=1`）。因此文档路径**不再需要**
   `getLessonUnitLearnVo` 提供 `textPages`，也就绕开了那个恒返回 `001:系统异常` 的坏接口 ——
   文档路径现在完全无头。
4. `check:rpc` 的判定口径已同步更新：`-10006` / `并发限制` 不再被描述为"被封锁"，而是
   "签名未通过验证"。
5. **不要把 `-10006` 或 `并发限制` 解读为风控封锁** —— 这是本 ADR 初版犯过的错，代价是一整轮
   误判与大量无效排障。

## 尚未验证 / 遗留

- `index` 字段语义未完全确认（视频用 1、文档用 0，均被接受）。
- 增量上报（真实客户端 `learnedVideoTimeCount` 每次约 60 秒）本仓未采用：实测一次性上报全时长
  即可完成，但这意味着进度曲线不像真人。若要更自然的痕迹，需改为分块、按时间间隔上报。
- 签名密钥 `fu2s2kxcswgn5hqanx7asmlogyr5wu29` 是站点前端硬编码；服务端若轮换，需同步更新本
  ADR 与 `src/rpc-sign.ts`。
- `nonce` 取值范围（1000~10000）与 `timestamp` 时效窗口未知；`Date.now()` 实测可用。

