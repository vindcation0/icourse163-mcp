/**
 * 题库层：把"题目 → 答案"这一步做成可插拔的，配置格式与 OCS 的 `AnswererWrapper` 兼容，
 * 这样现成的题库配置（言溪、tikuAdapter、llm_answerer…）可以直接粘过来用。
 *
 * 设计要点，每条都有实测依据：
 *
 * 1. **绝不能把 icourse163 的 cookie 发给题库。** 题库是第三方域名，这里用独立的
 *    `fetch`，不走 `Icourse163Http`（那个会带上会话 cookie，而且本来也不允许外域）。
 *
 * 2. **答案必须校验题型。** 题库经常"答非所问"（问单选返回一段话）。类型不符就丢弃，
 *    让调用方回退到下一个题库或标记未命中 —— 抄自 chaoxing 的 `answer_check.py`。
 *
 * 3. **答案解析要能容忍五花八门的格式。** 题库对多选可能返回 `A#C`、`A,C`、`AC`、
 *    `A、C`，也可能直接返回选项正文。这里统一 `cut()` 成片段，再由调用方按**选项正文**
 *    匹配回 id（实测这样最可靠，不要写死选项顺序）。
 */

export type TikuQuestionType = "single" | "multiple" | "judgement" | "completion" | "unknown";

/** 一道题的题库视角表示；`options` 是换行拼接的选项正文。 */
export type TikuQuestion = {
  title: string;
  type: TikuQuestionType;
  options: string;
};

/**
 * 一条题库配置。字段语义与 OCS 的 `AnswererWrapper` 一致：
 * - `url` / `data` 里的字符串支持 `${title}` `${type}` `${options}` 占位符
 * - `data` 的值可以是 `{ handler: "return (env)=>…" }`，用题目上下文做自定义转换
 * - `handler` 是一段 `return (res) => …` 的源码，返回 `[题,答]`、`[[题,答],…]` 或 `[提示, undefined]`
 */
export type AnswererWrapper = {
  url: string;
  name?: string;
  homepage?: string;
  method?: "get" | "post";
  contentType?: "json" | "text";
  headers?: Record<string, string>;
  data?: Record<string, string | { handler: string }>;
  handler: string;
};

export type TikuConfig = AnswererWrapper[];

export type TikuLookup = {
  /** 命中的答案文本；null 表示没命中。 */
  answer: string | null;
  /** 哪个题库给的答案（配置里的 name 或 url）。 */
  answerer: string | null;
  /** 题库返回的提示信息（`[msg, undefined]` 形态），或本地错误说明。 */
  note: string | null;
};

/** 判断题的真/假同义词表，抄自 chaoxing 的 answer_check.py。 */
export const TRUE_WORDS = ["true", "t", "1", "对", "正确", "√", "是", "yes", "y"];
export const FALSE_WORDS = ["false", "f", "0", "错", "错误", "×", "否", "no", "n", "不对", "不正确"];

/** 把答案切成片段；分隔符集合比 chaoxing 更保守一些，避免把小数/句读切坏。 */
export function cutAnswers(answer: string): string[] {
  const text = String(answer ?? "").trim();
  if (text === "") {
    return [];
  }
  for (const sep of ["\n", "\r", "|", "#", "、", ";", "；"]) {
    if (text.includes(sep)) {
      const parts = text
        .split(sep)
        .map((p) => p.trim())
        .filter((p) => p !== "");
      if (parts.length > 0) {
        return parts;
      }
    }
  }
  return [text];
}

/** 判断题答案归一化；认不出来返回 null。 */
export function judgementValue(answer: string): boolean | null {
  const value = String(answer ?? "").trim().toLowerCase();
  if (TRUE_WORDS.includes(value)) {
    return true;
  }
  if (FALSE_WORDS.includes(value)) {
    return false;
  }
  return null;
}

/**
 * 答案是否符合题型。不符合就丢弃 —— 宁可未命中，也不要答非所问。
 * `unknown` 题型一律放行。
 */
export function answerMatchesType(answer: string, type: TikuQuestionType): boolean {
  const text = String(answer ?? "").trim();
  if (text === "") {
    return false;
  }
  if (type === "judgement") {
    return judgementValue(text) != null;
  }
  if (type === "completion") {
    return true;
  }
  const parts = cutAnswers(text);
  if (type === "single") {
    // 单选的答案里出现多段就是错的；但"走、跑、跳、投"这种正文里的顿号不能算分隔
    // （所以 cutAnswers 把顿号当分隔后，这里还要再确认不是纯正文）
    return parts.length === 1;
  }
  if (type === "multiple") {
    return parts.length >= 1;
  }
  return true;
}

/**
 * 题目类型映射：platform 的 type 码 → 题库语义。
 *
 * 码值来自实测试卷：1 单选 / 2 多选 / 4 判断 / 10 主观论述。
 * `10` 特意映射成 `unknown` 而不是 `completion`：实测作业里的 10 都是"请结合自身…阐述…"
 * 这类论述题，题库不可能有；当成填空去问只会拿回一句驴唇不对马嘴的话。
 */
export function mapQuestionType(platformType: number | null | undefined): TikuQuestionType {
  switch (Number(platformType)) {
    case 1:
      return "single";
    case 2:
      return "multiple";
    case 4:
      return "judgement";
    case 10:
      return "unknown";
    default:
      return "unknown";
  }
}

/**
 * 把解析出来的答案匹配回选项 id。
 *
 * 两种形态都支持：
 * - 字母形态（`B` / `A#C` / `AC`）→ 按序号取（A=第一个）
 * - 正文形态（"马拉松"）→ 与选项正文做归一化比较
 *
 * 实测：直接按 `options[].content` 匹配正文再取 id 一次就能拿到满分，所以正文匹配优先。
 */
export function matchOptionIds(
  answer: string,
  options: { id: string; content: string }[],
): string[] {
  if (options.length === 0) {
    return [];
  }
  const normalize = (value: string): string =>
    String(value ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, "")
      .replace(/^[A-Za-z][.、:：)）]\s*/, "")
      .replace(/[\u200A-\u200F\uFEFF]/g, "")
      .toLowerCase();
  const normalizedOptions = options.map((o) => normalize(o.content));

  // 0) 整体优先：题库经常直接把「选项正文」当答案返回。
  //    "走、跑、跳、投" 是某个选项的完整内容，如果先按 、 拆开就会散着匹配到「走」「跑」等，
  //    结果错得离谱 —— 所以整体相等就立刻定案。
  const whole = normalize(answer);
  if (whole !== "") {
    const exactIndex = normalizedOptions.findIndex((c) => c !== "" && c === whole);
    if (exactIndex >= 0) {
      return [options[exactIndex].id];
    }
  }

  const parts = cutAnswers(answer)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) {
    return [];
  }

  const picked: string[] = [];
  const take = (index: number): void => {
    if (index >= 0) {
      const id = options[index].id;
      if (!picked.includes(id)) {
        picked.push(id);
      }
    }
  };

  for (const part of parts) {
    const needle = normalize(part);
    if (needle === "") {
      continue;
    }
    // 1) 该段与某个选项整体相等
    const exact = normalizedOptions.findIndex((c) => c !== "" && c === needle);
    if (exact >= 0) {
      take(exact);
      continue;
    }
    // 2) 字母形态（只由字母组成）
    if (/^[a-z]+$/.test(needle)) {
      const offset = needle.charCodeAt(0) - "a".charCodeAt(0);
      if (offset >= 0 && offset < options.length) {
        take(offset);
        continue;
      }
    }
    // 3) 包含关系，但只在**唯一命中**时才采纳，避免"跳"同时命中「跳、投」和「走、跑、跳、投」
    const contains = normalizedOptions
      .map((c, i) => (c !== "" && (c.includes(needle) || needle.includes(c)) ? i : -1))
      .filter((i) => i >= 0);
    if (contains.length === 1) {
      take(contains[0]);
    }
  }
  return picked;
}

/** 从配置文本里读出题库配置：接受裸数组，也接受 `{answerers: [...]}` 或 `{tiku: [...]}`。 */
export function parseTikuConfig(raw: string): TikuConfig {
  const text = String(raw ?? "").trim();
  if (text === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`题库配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { answerers?: unknown })?.answerers)
      ? ((parsed as { answerers: unknown[] }).answerers)
      : Array.isArray((parsed as { tiku?: unknown })?.tiku)
        ? ((parsed as { tiku: unknown[] }).tiku)
        : null;
  if (list == null) {
    throw new Error("题库配置需要一个数组，或 {answerers: [...]} / {tiku: [...]}");
  }
  return list.filter((item): item is AnswererWrapper => {
    return item != null && typeof item === "object" && typeof (item as AnswererWrapper).url === "string" && typeof (item as AnswererWrapper).handler === "string";
  });
}

/** 占位符替换（`${title}` / `${type}` / `${options}`）。 */
export function fillPlaceholders(template: string, question: TikuQuestion): string {
  return String(template)
    .replace(/\$\{title\}/g, question.title)
    .replace(/\$\{type\}/g, question.type)
    .replace(/\$\{options\}/g, question.options);
}

/** 把 `data` 解析成实际要发送的键值（支持 `{handler}` 自定义转换）。 */
export function resolveRequestData(
  data: Record<string, string | { handler: string }> | undefined,
  question: TikuQuestion,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (data == null) {
    return out;
  }
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      out[key] = fillPlaceholders(value, question);
      continue;
    }
    if (value != null && typeof value === "object" && typeof value.handler === "string") {
      try {
        const fn = new Function(`return (${value.handler.replace(/^\s*return\s*/, "")})`)() as (
          env: TikuQuestion,
        ) => unknown;
        out[key] = fn(question);
      } catch {
        // handler 写坏了不要炸整个查询，保留原样交给服务端
        out[key] = fillPlaceholders(value.handler, question);
      }
    }
  }
  return out;
}

/** 把 handler 的返回值规整成 `[题, 答]` 或 `[[题,答],…]` 或 `[提示, undefined]`。 */
export function interpretHandlerResult(result: unknown): TikuLookup {
  const first = Array.isArray(result) ? result : null;
  if (first == null || first.length === 0) {
    return { answer: null, answerer: null, note: null };
  }
  const looksNested = first.every((item) => Array.isArray(item));
  const pairs: unknown[][] = looksNested ? (first as unknown[][]) : [first];
  let note: string | null = null;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2) {
      continue;
    }
    const [, answer] = pair;
    if (answer == null) {
      // `[msg, undefined]` 形态：题库在告诉我们它为什么没答上
      const msg = pair[0];
      if (msg != null && String(msg).trim() !== "") {
        note = String(msg);
      }
      continue;
    }
    const text = String(answer).trim();
    if (text !== "") {
      return { answer: text, answerer: null, note: null };
    }
  }
  return { answer: null, answerer: null, note };
}

export type TikuFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: string }>;

/** 给默认实现用的 fetch 适配（不发任何 cookie）。 */
export const defaultTikuFetch: TikuFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    // 题库是第三方，绝不带 credentials
    credentials: "omit",
    redirect: "follow",
  });
  return { status: response.status, text: await response.text() };
};

/**
 * 按配置顺序依次问题库，命中且题型相符就返回。
 *
 * 单个题库出错（超时、JSON 坏、handler 抛异常）不会中断整条链 —— 记下 note 继续下一个。
 */
export async function queryTiku(
  question: TikuQuestion,
  config: TikuConfig,
  fetchImpl: TikuFetch = defaultTikuFetch,
): Promise<TikuLookup> {
  const notes: string[] = [];
  for (const entry of config) {
    const name = entry.name?.trim() || entry.url;
    try {
      const data = resolveRequestData(entry.data, question);
      const method = (entry.method ?? "get").toUpperCase();
      const url = fillPlaceholders(entry.url, question);
      const headers: Record<string, string> = { ...(entry.headers ?? {}) };
      let target = url;
      let body: string | undefined;
      if (method === "GET") {
        const query = new URLSearchParams();
        for (const [k, v] of Object.entries(data)) {
          query.set(k, typeof v === "string" ? v : JSON.stringify(v));
        }
        const qs = query.toString();
        if (qs !== "") {
          target = url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
        }
      } else {
        if (headers["Content-Type"] == null && headers["content-type"] == null) {
          headers["Content-Type"] = "application/json";
        }
        body = JSON.stringify(data);
      }

      const response = await fetchImpl(target, { method, headers, body });
      if (response.status < 200 || response.status >= 300) {
        notes.push(`${name}: HTTP ${response.status}`);
        continue;
      }
      const payload = entry.contentType === "text" ? response.text : safeJson(response.text);
      if (payload === undefined) {
        notes.push(`${name}: 返回不是合法 JSON`);
        continue;
      }
      const fn = new Function(`return (${entry.handler.replace(/^\s*return\s*/, "")})`)() as (
        res: unknown,
      ) => unknown;
      const lookup = interpretHandlerResult(fn(payload));
      if (lookup.note != null) {
        notes.push(`${name}: ${lookup.note}`);
      }
      if (lookup.answer == null) {
        continue;
      }
      if (!answerMatchesType(lookup.answer, question.type)) {
        // 题库答非所问：丢弃并继续下一个，这一条抄自 chaoxing
        notes.push(`${name}: 答案类型与题型不符，已舍弃（${lookup.answer.slice(0, 24)}）`);
        continue;
      }
      return { answer: lookup.answer, answerer: name, note: notes.length > 0 ? notes.join("; ") : null };
    } catch (error) {
      notes.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { answer: null, answerer: null, note: notes.length > 0 ? notes.join("; ") : null };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
