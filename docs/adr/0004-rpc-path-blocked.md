# ADR 0004：RPC 通道为何在本仓的当前契约下不可能成功

日期：2026-10-14
状态：已实测确认（本机、单账号）

## 背景

`transport=rpc` 在本机账号上从未成功过。`npm run check:rpc` 给出两个互相独立的阻断点，
但直到抓取真实浏览器流量之前，都无法判断这属于"协议写错了"还是"服务端风控拒绝"。

结论对选型很关键：前者可以修，后者只能绕。

## 实测证据

### 1. 工具当前发的契约是旧的（确实是 bug）

用 Playwright 监听 `/learn/` 页面的 XHR，捕获浏览器在正常记录学习进度时真正发出的请求：

```
POST /web/j/courseRpcBean.saveMocContentLearn.rpc?csrfKey=<32 hex>
Content-Type: application/json;charset=UTF-8
{"dto":{"unitId":1305575052,"finished":true,"index":1,"duration":60000,
        "courseId":1450750234,"lessonId":1265444035,"videoId":1216009818,
        "termId":1475848441,"userId":"…","contentType":1,
        "action":"LEARN_TIME_COUNT","videoTime":1126,"learnedVideoTimeCount":60}}
→ 200 {"code":0,"result":true}
```

而 `study-unit.ts` 发的是：

```
POST /web/j/courseBean.saveMocContentLearn.rpc?csrfKey=<32 hex>
Content-Type: application/x-www-form-urlencoded
dto={"unitId":…,"contentType":1,"finished":true,
     "videoDto":{"videoId":…,"duration":…,"currentTime":…,"learnedTime":…}}
→ 200 {"code":-2,"message":"请检查本地时间是否和北京时间一致-10006"}
```

差异是全面的：

| 维度 | 本仓实现 | 浏览器 |
|---|---|---|
| bean | `courseBean` | `courseRpcBean` |
| Content-Type | `application/x-www-form-urlencoded` | `application/json;charset=UTF-8` |
| body | `dto=<urlencoded JSON>` | 裸 JSON 对象 |
| 载荷 | 嵌套 `videoDto{…}` | 扁平字段 + `action:"LEARN_TIME_COUNT"` |
| 增量语义 | 一次性声称 `finished:true` | 每次上报约 60 秒 `learnedVideoTimeCount` |

`getLessonUnitLearnVo` 同理：浏览器走 DWR，本仓走一个不存在的 `.rpc` 变体。

```
POST /dwr/call/plaincall/CourseBean.getLessonUnitLearnVo.dwr   ← 浏览器，text/plain
POST /web/j/courseBean.getLessonUnitLearnVo.rpc                ← 本仓 → 001:系统异常
```

### 2. 但修正契约仍然不够（关键）

把浏览器那份报文**逐字节**从 Node 重放，路径 / Content-Type / DTO 全部照搬，并在同一个
60 秒窗口内与真实 Chrome 对照：

```
Node   → 200 {"code":-2,"message":"请检查本地时间是否和北京时间一致-10006"}
Chrome → 200 {"code":0,"result":true}
```

同一 cookie、同一会话、同一 csrfKey、同一端点、同一字节。先等待 60 秒排除 `并发限制`
限流后再测，结果不变。

**所以阻断点不在 HTTP 报文层。**

## 决策

1. 不投入"纯 HTTP 协议模拟"去追这条 RPC。报文层的模拟已经做到极限（逐字节重放）且被拒。
2. 本仓继续以 Playwright 作为唯一可靠的进度通道；`transport=auto` 的回退设计是正确且必要的。
3. 本 ADR 记录真实契约，供将来参考；但**不要**仅凭它改写 `saveMocContentLearn` 的调用形态
   —— 那样既无法验证，也不会解除阻断。

## 若要继续推进，剩下的杠杆（按成本递增）

1. **补全浏览器请求头**：`sec-ch-ua*`、`sec-fetch-*`、`priority`、header 顺序与小写化。
   成本低，但没有证据表明它是闸门。
2. **复现取 token 的时序**：Chrome 在上报前会先调
   `resourceRpcBean.getResourceTokenV2`，携带 `bizId` / `bizType` / `contentType` /
   `sign=<32 hex>` / `timestamp=<ms>`。服务端可能要求"先建立播放会话再上报"。
   需要逆向 `sign` 的算法，且 `timestamp` 可能有时效。
3. **TLS 指纹伪装（JA3/JA4）**：undici 与 Chrome 的 ClientHello 不同，这是经典的
   反爬判定维度。需要 curl-impersonate 一类工具或打补丁的 TLS 栈。
4. **直接用真浏览器**——本仓现状。这也是 OCS 的选择。

判断：第 3 项是唯一能解释"同字节、同窗口、不同结果"的网关级因素；第 2 项次之。
继续向纯 HTTP 投入的边际收益很低。

## 后果

- `npm run check:rpc` 是判断 RPC 是否可用的唯一快路径（约 2 秒，不开浏览器）。
- 文档与工具描述需要明确：默认 `skip_to_end: true` 的跳转**不被平台计入**，真实进度
  必须 `skip_to_end: false` 真播，且按约 60 秒粒度累加。
- 本机账号上 `transport=rpc` 只会返回错误；`auto` 会稳定回退浏览器。
