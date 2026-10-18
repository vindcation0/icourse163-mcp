# 现状报告：给新会话 / 其他 agent 的接手入口

> **读这一份就够上手**。写于 2026-10-18，基于当天的大量实测（不是推测）。
> 细节别处有：优先级与代价见 [ROADMAP](ROADMAP.md)，逆向硬事实与踩坑史见 [HANDOFF](HANDOFF.md)，
> 工具契约见 [mcp.md](mcp.md)，登录细节见 [login.md](login.md)。

---

## 0. 30 秒摘要

**这是什么**：中国大学MOOC（icourse163.org）的本机工具，两条入口共用同一个引擎 ——
`mooc.py`/`mooc.exe`（给人用，编号菜单）和 stdio **MCP 服务器**（给 agent 用，8 个工具）。

**一句话现状**：
> **登录、刷课、读题、答题提交 —— 全部纯 HTTP 可用且已实测。**
> **讨论区完全没做。考试按设计不做。**
> 剩下的是工作量，不是未知。

**最重要的三条结论**（这轮才确定的，之前的文档写错了）：

1. `submitAnswers`**不需要签名**，一次真实提交拿到 **8/8 满分**
2. `preview:true`（草稿）**不是通用的** —— 部分卷子服务端直接拒绝，只能正式提交
3. 算出来的答案要按 **`options[].content` 正文匹配**再取 id，**不能写死选项顺序**

---

## 1. 立即可用的能力（全部已验证）

| 能力 | 通道 | 入口 | 实测 |
|---|---|---|---|
| 登录 | 纯 HTTP（URS：SM4+RSA+VDF） | `mooc.py login` / exe 首次运行 | ~4 秒 |
| 刷视频/文档 | **签名 RPC** | `mooc.py auto` / MCP `study_unit` | ~1.4 秒/单元 |
| 分块上报（可选） | 签名 RPC | `--chunk 60` | 337s 单元 → 6 段，153 秒 |
| 列待办 | 纯 HTTP | MCP `list_todos` | 159 个（测验 137 / 作业 21 / 考试 1） |
| 列课程/课件 | 纯 HTTP | `mooc.py courses/units`、MCP | 8 门课 |
| **读试卷** | **纯 HTTP** | MCP `get_homework` | 作业 0.5s、测验 3.0s |
| **提交答案** | **纯 HTTP** | MCP `submit_homework` | **8/8 满分**，1.3 秒 |
| 会话体检 | 纯 HTTP | `mooc.py status` / MCP `session_status` | ~2 秒 |
| 设置（视频/密码） | 本地 JSON | `mooc.py settings` | 13 组桩测试 |
| 打包 exe + Release | — | `python scripts/build-exe.py` | v0.1.0 已发布，53MB zip |

**8 个 MCP 工具里 7 个是纯 HTTP**；只有 `study_unit` 可能碰浏览器（见 §5 危险动作）。

---

## 2. 边界：什么**没有**

| 项 | 状态 |
|---|---|
| **讨论区**（读/回复） | ❌ **零代码、零端点知识**。全仓库只有一行注释提到 `contentType 6 = discuss`，还被归成 `other` |
| 考试代交 | 🚫 **明确不做**（`submit_homework` 硬拒绝 `source=exam`，三处文档一致） |
| 草稿保存（通用） | ⚠️ 实测 `test.type=2` 的卷子被拒："本试卷不支持草稿预览保存" |
| 逐题对错详情 | ⚠️ 没有。只能读目录里的 `test.userScore`（总分够用） |
| 主观题作答 | ⚠️ 21 个作业**全是 `type=10` 主观题**（1 题、0 选项），题库完全无用，只能 LLM 生成或人写 |

---

## 3. 已知缺陷（读代码/实测发现，尚未修）

| # | 缺陷 | 后果 |
|---|---|---|
| D1 | `stripHtml` **不解 `&rlm;` / `&lrm;` 等命名实体**（只解 `&nbsp; &lt; &gt; &quot;` + 数字实体） | 实测题干带 `&rlm;` → 题库查询串被污染，匹配率下降 |
| D2 | `session_status` 只要面板 RPC 成功就报 **`可用`**，即使 `course_count=0` | 实测出现过"可用但 0 门课"的半死会话 |
| D3 | 无**覆盖率闸门** | 题库答不出时也会照常提交 |
| D4 | 无**逐题对错回读** → 无法精准重做 | 只能"看总分，不满就整卷重答" |
| D5 | 设置文件若被记事本存成带 BOM 的 UTF-8 | 已修（用 `utf-8-sig` 读），有测试锁住 |

---

## 4. 硬事实：**不要再重新推导**

这些是花了大量时间换来的，重推一遍就是浪费。

### 4.1 两个会话层（最容易误判）

- **API 层**：`NTESSTUDYSI` 令牌，纯 HTTP 登录即可拿到，`list_todos`/`get_homework`/刷课全走它 ✅
- **网页层**：要打开 `/learn/` 需要**真正的浏览器会话**。纯 HTTP 登录的会话打不开 ——
  请求 `/learn/` 会被 **302 到 `/passport/member/logout.htm`**
- **不要用 `/learn/` 做探活**：那条请求会命中登出接口，实测把原本可用的会话弄死过
- `session_status.web_session_markers` **只是"两个 cookie 在不在"**，不代表网页路径能用
  （实测：两个都在仍被弹走；而登录 profile 里两个都没有却能打开 `/learn/`）

### 4.2 签名规则**按接口不同**（不能类推）

| 接口 | 要签名吗 |
|---|---|
| 学习上报 `saveMocContentLearn` | **要**（`auth-signature = MD5(body+nonce+timestamp+密钥).toUpperCase()`） |
| 答题提交 `submitAnswers` | **不要**（普通 JSON POST，实测 8/8） |

### 4.3 刷课：`videoTime` 是**位置**，不是总时长

服务端只在 `videoTime` **前进**时计入；重复发同一个值会返回 `code:0` 但**一分不记**。
（这就是"分块上报看起来不可行"的全部原因。）

### 4.4 答题链路的正确顺序

```
① get_homework(todo_id)
     → questions[{question_id, type, options[{id, content}], supports_save, bank}]
② 算答案
③ 按 options[].content 匹配出 option_ids      ← 不要写死顺序
④ submit_homework(todo_id, answers, paper_type)
     status="rejected"  ⇒ 说明草稿态不可用，只能正式提交
     status="submitted" ⇒ 成功
⑤ 读目录 test.userScore / usedTryCount 验分
```

耗时：读 3.0s + 草稿 1.1s + 提交 1.3s ≈ **单卷 5 秒**。

### 4.5 题目构成（决定题库有没有用）

- **作业**（21 个）：`type=10` 主观题，1 题 0 选项 → **题库无用**
- **测验**（137 个）：`type=1` 单选 + `type=4` 判断，都有选项 → **题库完全可用**

### 4.6 安全的预读手段

目录（`fetchMocTermDto`）里直接有：`test.trytime`（总次数）、`test.usedTryCount`（已用）、
`test.testTime`（限时秒，`-1` 表示不限）、`test.userScore`、`test.totalScore`。
→ **可以做到"次数不够的卷子不碰"，而且完全不用开卷。**

实测：**读卷不消耗次数**（读前后 `usedTryCount` 都是 0/10）。

### 4.7 凭据存储有**两个真相来源**

- keychain 里是裁剪后的 **990 字符 / 7 个** cookie（能塞进 2560 字节上限）
- 文件里是更早的 **1703 字符 / 17 个**
- `getCookie()` **优先读 keychain** → 直接读文件的探针会拿到另一个值，导致结论不可比

---

## 5. ⚠️ 危险动作清单（新 agent 动手前必读）

| 不要做 | 原因 |
|---|---|
| **用 `/learn/` 探活** | 命中登出接口，会弄坏可用会话 |
| **不确认就 `submit_homework`** | 真消耗作答次数（每卷 3~10 次），且无草稿态时**不可撤回** |
| **重跑"发报告看完成度"式实验** | 会真实改进度（见 §7 已改动清单） |
| **同时跑两个进程刷课** | 共用同一份会话，请求叠加更易触发 `并发限制` |
| **假设 agent 调用不会开浏览器** | `study_unit` 默认 `transport:auto`，遇 `-10006`/限流/时钟 会**自动启 Chrome** |
| **把密码/cookie 写进文件或提交** | 产品约束；每 push 前跑隐私扫描 |

**另外**：密码输入**默认可见**（`--hide-password` 可关）—— 这是使用者的明确选择，不是 bug。
回显会留在终端回滚区/录屏里，文档已如实标注。

---

## 6. TODO 与代价（摘要）

完整版见 [ROADMAP](ROADMAP.md)。

| 优先 | 任务 | 代价 | 风险 |
|---|---|---|---|
| **P0-1** | 文本清洗（`&rlm;`/`&lrm;` 等命名实体 + 零宽 + 空白折叠） | 2h | 零 |
| **P0-2** | `session_status` 区分半死会话（`course_count=0`） | 1h | 零 |
| **P0-3** | 文档与实测对齐 | 1h | 零 |
| **P2-A** | 题库层 `tiku.ts`（`AnswererWrapper` 兼容 + 多 provider 回退 + 类型校验 + 缓存） | 1d | 零 |
| **P2-B** | `mooc.py` 菜单「测验/作业 → 读题 + 查答案 + 出清单」 | 0.5d | 零 |
| **P3-A** | 覆盖率闸门（< 80% 不提交） | 2h | 零 |
| **P3-B** | 自动填答 + 提交 | 0.5d | **中**（写操作） |
| **P3-C** | 交后读分 | 2h | 低 |
| **P3-D** | 答错重做（只有总分，无逐题对错 → 只能整卷重答） | 0.5–1d | 中 |
| **P4** | 主观题（作业）→ LLM 生成，人工确认后再交 | 0.5–1d | 中 |
| **P5** | 讨论区（端点发现 1d + 实现 1.5d） | 2.5d | **高**（对外可见） |

**关键路径**：`P0-1 → P2-A → P3-B`。**没有阻塞点了** —— 原来卡的"提交要不要签名"已经实测解决。

---

## 7. 本次会话已经改动过的课程数据（**只增不减**）

新的 agent 看到这些状态**不要误以为异常**，这是实验留下的：

| 对象 | 课程/学期 | 现状 |
|---|---|---|
| 单元 `1307450283` 3.1 短跑项目发展历史 | 1460749165 / 1476706446 | **100%**（原 17.66%） |
| 单元 `1305151991` 2.5 上肢力量的练习及其方法 | 1460749165 / 1475624483 | **100%**（分块上报端到端测试完成） |
| 单元 `1305177003` 3.8 立定跳远动作要领 | 1460749165 / 1475624483 | **19.0%**（约 185 秒） |
| 单元 `1305177006` 4.1 均衡膳食 | 1460749165 / 1475624483 | **43.8%**（约 245 秒） |
| 测验 `1279296073` 田径基础知识-单元测验 | 1449647163 / 1488389457 | **8/8 满分**，用了 **1/10** 次 |

---

## 8. 环境与常用命令

```powershell
# 仓库
C:\Users\vindacation\Documents\deepseek-harness\default-workspace\icourse163-mcp

# 关键路径
~/.config/icourse163-mcp/session        # 会话（keychain 优先）
~/.config/icourse163-mcp/settings.json  # 设置（只存改过的项）
~/.icourse163-mcp/chrome-profile        # 浏览器登录用的持久化 profile

# 人用
python mooc.py            # 无参数 = 首次直接登录，之后给编号菜单
python mooc.py status
python mooc.py auto       # 刷课（--transport 默认 rpc，绝不回退浏览器）
python mooc.py settings

# agent 用
npm start --silent        # stdio MCP 服务器（8 个工具）

# 打包 / 发布
python scripts/build-exe.py     # → dist/mooc/mooc.exe
tar -a -c -f dist/mooc-win64.zip -C dist mooc

# 测试
$env:ICOURSE163_DISALLOW_LIVE_PLAYWRIGHT='1'
node --import tsx --test tests/*.test.ts     # 199 个，198 通过（1 条既有 Windows 路径失败）
python tests/mooc_menus_test.py              # 菜单桩测试，13 组全过
& "C:\Program Files\nodejs\node.exe" node_modules\typescript\bin\tsc --noEmit
```

- Node **v24.15.0**、Python **3.11.9**
- exe 走 `onedir`（`dist/mooc/`，143MB；zip 53MB），**自带 node.exe，用户不需要装任何运行时**
- GitHub Release `v0.1.0` 已发布，zip 作附件

---

## 9. 文档地图

| 文档 | 内容 |
|---|---|
| **STATUS.md**（本文） | 接手入口：现状、结论、边界、危险动作 |
| [ROADMAP.md](ROADMAP.md) | 优先级、代价表、依赖图、待拍板决策 |
| [HANDOFF.md](HANDOFF.md) | 逆向硬事实、踩坑史（含三次误读同一个错误码的教训） |
| [mcp.md](mcp.md) | 8 个工具的契约与状态码语义 |
| [login.md](login.md) | 登录细节（纯 HTTP / 浏览器 / cookie 粘贴） |
| [adr/](adr/) | 5 份架构决策记录（RPC 签名、URS 登录、作业 RPC 等） |

**外部参考**（这轮调研的结论，写实现时直接抄）：
- [ocsjs](https://github.com/ocsjs/ocsjs) 的 `icourse163` 脚本：题库配置格式 + icourse163 的 DOM 选择器
- [Samueli924/chaoxing](https://github.com/Samueli924/chaoxing)：纯 HTTP 表单提交、`pyFlag` 草稿/提交、
  **覆盖率闸门**、**答错回读重做**、`answer_check.py` 类型校验
- [llm_answerer](https://github.com/amlkiller/llm_answerer)：自建 AI 题库，直接吐 OCS 兼容配置

---

## 10. 给接手者的第一件事

如果你想**继续开发**：

1. 先跑一遍 `python mooc.py status` —— 若报 `可用` 但 `课程数量 0`，那是半死会话，需要重新登录
2. 然后做 **P0-1（文本清洗）** —— 2 小时、零风险，而且是题库功能的前置
3. **不要**在没有明确授权的情况下调用 `submit_homework`

如果你想**验证状态**：
- `python mooc.py status`（~2 秒）
- MCP `list_todos`（159 个待办）
- `npm run check:rpc --silent -- --course-id 1450750234 --term-id 1475848441 --school XDU`
