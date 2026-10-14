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
- `userId` 来自课程面板 RPC（`learnerRpcBean.getMyLearnedCoursePanelList`）。

### `getLessonUnitLearnVo` 不是 RPC

浏览器走 DWR，本仓走一个不存在的 `.rpc` 变体，因此恒返回 `001:系统异常`：

```
浏览器: POST /dwr/call/plaincall/CourseBean.getLessonUnitLearnVo.dwr   (text/plain)
本仓:   POST /web/j/courseBean.getLessonUnitLearnVo.rpc                → 001:系统异常
```

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

1. 本仓的 RPC 通道**应当实现签名**，而不是继续依赖浏览器回退。签名后 RPC 比 Playwright 快
   4~5 个数量级（毫秒 vs 数分钟），且不依赖易失的网页会话——本项目绝大多数排障时间都花在
   网页会话反复失效上。
2. `transport=auto` 的回退设计依然正确（服务端策略可能变化），但正常情况下不应再触发回退。
3. 文档（`contentType` 3/4）的上报契约**尚未捕获**，仍应走浏览器路径；需要另行抓包确认。
4. `npm run check:rpc` 的判定口径需要修正：它当前把 `-10006` / `并发限制` 判为"被封锁"，
   而它们实际是"缺签名"。修正后应报告"需要签名"而非"不可用"。
5. 不要再把 `-10006` 或 `并发限制` 解读为风控封锁——这是本 ADR 初版犯过的错。

## 遗留问题

- `nonce` 的取值范围（1000~10000）与 `timestamp` 的时效窗口未知；`Date.now()` 实测可用。
- 签名密钥 `fu2s2kxcswgn5hqanx7asmlogyr5wu29` 是站点前端硬编码，服务端更换时此 ADR 需同步更新。
- 文档类型的签名上报契约待捕。
