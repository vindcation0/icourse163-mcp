import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildReplyBody,
  browserSessionFilePath,
  LEARN_API_BASE,
  outlineUrl,
  parseDiscussionUnits,
  replyDiscussion,
} from "../src/discussion";

const OUTLINE = {
  code: 0,
  result: {
    chapters: [
      {
        id: "1252921019",
        lessons: [
          {
            id: "1279296075",
            units: [
              {
                id: "1322018146",
                contentType: 6,
                contentId: "1354137205",
                name: "现代田径运动的发展特点-讨论",
                completePercent: 0,
                viewStatus: "not-viewed",
              },
              // 不是讨论单元，必须被过滤掉
              { id: "1322018145", contentType: 5, contentId: "1258773450", name: "随堂测试", completePercent: 1 },
            ],
          },
        ],
      },
    ],
  },
};

describe("LEARN_API_BASE", () => {
  // 这是踩过的坑：写成 /api/learn（少了 front-mooc-learn 前缀）会 404，看起来像"接口不存在"。
  test("is rooted at front-mooc-learn", () => {
    assert.equal(LEARN_API_BASE, "https://www.icourse163.org/front-mooc-learn/api/learn");
    assert.ok(LEARN_API_BASE.includes("/front-mooc-learn/api/learn"));
    // 只允许这一个前缀，不能是裸的 /api/learn
    assert.ok(!LEARN_API_BASE.startsWith("https://www.icourse163.org/api/learn"));
  });
});

describe("outlineUrl", () => {
  test("builds the content-outline path with courseKey and entryMode", () => {
    const url = outlineUrl("CUPES-1449647163", "1488389457");
    assert.ok(url.startsWith(`${LEARN_API_BASE}/terms/1488389457/content-outline?`));
    assert.ok(url.includes("courseKey=CUPES-1449647163"));
    assert.ok(url.includes("entryMode=learn"));
  });
});

describe("buildReplyBody", () => {
  // termId 传数字会被判成"缺少参数"（400）；传字符串才过校验。
  test("keeps termId as a string and uses action addReply", () => {
    const body = buildReplyBody({
      courseKey: "CUPES-1449647163",
      termId: "1488389457",
      contentId: "1354137205",
      content: "一句话回答",
    });
    assert.equal(body.action, "addReply");
    assert.equal(body.termId, "1488389457");
    assert.equal(typeof body.termId, "string");
    assert.equal(body.postId, "1354137205");
    assert.equal(body.forumScope, "mooc");
    assert.equal(body.content, "一句话回答");
    assert.deepEqual(body.photos, []);
    assert.equal(body.anonymous, false);
  });
});

describe("parseDiscussionUnits", () => {
  test("keeps only contentType 6 and carries contentId as the topic id", () => {
    const units = parseDiscussionUnits(OUTLINE);
    assert.equal(units.length, 1);
    assert.deepEqual(units[0], {
      unit_id: "1322018146",
      lesson_id: "1279296075",
      content_id: "1354137205",
      name: "现代田径运动的发展特点-讨论",
      complete_percent: 0,
      view_status: "not-viewed",
      completed: false,
    });
  });

  test("tolerates a bare result object and junk", () => {
    assert.deepEqual(parseDiscussionUnits(null), []);
    assert.deepEqual(parseDiscussionUnits({}), []);
    assert.equal(parseDiscussionUnits(OUTLINE.result).length, 1);
  });

  // 新版 content-outline 不返回 completePercent，完成状态只在 viewStatus 里。
  // 不认这个就会对已经回复过的主题重复发帖（公开内容，不能重发）。
  test("treats viewStatus=completed as completed even without completePercent", () => {
    const outline = {
      result: {
        chapters: [
          { lessons: [{ id: "1", units: [{ id: "9", contentType: 6, contentId: "77", name: "d", viewStatus: "completed" }] }] },
        ],
      },
    };
    const [u] = parseDiscussionUnits(outline);
    assert.equal(u.complete_percent, null);
    assert.equal(u.view_status, "completed");
    assert.equal(u.completed, true);
  });

  test("treats completePercent=1 as completed even without viewStatus", () => {
    const outline = { chapters: [{ lessons: [{ id: "1", units: [{ id: "9", contentType: 6, contentId: "77", completePercent: 1 }] }] }] };
    assert.equal(parseDiscussionUnits(outline)[0].completed, true);
  });

  test("skips a discussion unit with no contentId (nothing to reply to)", () => {
    const broken = { result: { chapters: [{ lessons: [{ units: [{ id: "1", contentType: 6, contentId: "" }] }] }] } };
    assert.deepEqual(parseDiscussionUnits(broken), []);
  });
});

describe("browserSessionFilePath", () => {
  test("lives beside the session file but is a different file", () => {
    assert.equal(
      browserSessionFilePath({}, "C:\\Users\\x"),
      "C:\\Users\\x\\.config\\icourse163-mcp\\browser-session",
    );
    const withXdg = browserSessionFilePath({ XDG_CONFIG_HOME: "D:\\cfg" }, "C:\\Users\\x");
    assert.ok(withXdg.startsWith("D:\\cfg"));
    assert.ok(withXdg.endsWith("browser-session"));
    // 与 URS 会话那份（*\\session）必须是不同的文件
    assert.ok(!/[\\/]session$/.test(withXdg));
  });
});

/** 极小 fetch 替身：按 URL 返回预置响应，记录调用。 */
function fakeFetch(routes: { outline?: unknown; write?: { status: number; body: unknown } }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("content-outline")) {
      return new Response(JSON.stringify(routes.outline ?? {}), { status: 200 });
    }
    const w = routes.write ?? { status: 200, body: { code: 0, result: { id: "999" } } };
    return new Response(JSON.stringify(w.body), { status: w.status });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

const ARGS = { course_id: "1449647163", term_id: "1488389457", unit_id: "1322018146", content: "  一句话回答  ", school_short_name: "CUPES" };

describe("replyDiscussion", () => {
  test("refuses without a browser session and never touches the network", async () => {
    const { impl, calls } = fakeFetch({});
    const out = await replyDiscussion(ARGS, { browserCookie: async () => null, fetchImpl: impl });
    assert.equal(out.status, "no_session");
    assert.equal(out.isError, true);
    assert.equal(calls.length, 0);
  });

  test("rejects empty content", async () => {
    const { impl } = fakeFetch({});
    const out = await replyDiscussion({ ...ARGS, content: "   " }, { browserCookie: async () => "c=1", fetchImpl: impl });
    assert.equal(out.status, "rejected");
    assert.equal(out.isError, true);
  });

  test("replies to the unit's contentId and returns the reply id", async () => {
    const { impl, calls } = fakeFetch({ outline: OUTLINE, write: { status: 200, body: { code: 0, result: { id: "2246227255" } } } });
    const out = await replyDiscussion(ARGS, { browserCookie: async () => "STUDY_INFO=1", fetchImpl: impl });
    assert.equal(out.status, "ok");
    assert.equal(out.reply_id, "2246227255");
    assert.equal(out.content_id, "1354137205");
    assert.equal(out.unit_name, "现代田径运动的发展特点-讨论");
    const write = calls.find((c) => c.url.includes("/forum/write"));
    assert.ok(write != null);
    const body = JSON.parse(String(write.init?.body)) as Record<string, unknown>;
    assert.equal(body.action, "addReply");
    assert.equal(body.postId, "1354137205");
    // 内容要 trim，别把用户的空格当内容发出去
    assert.equal(body.content, "一句话回答");
  });

  test("refuses to reply again once the unit is complete", async () => {
    const done = JSON.parse(JSON.stringify(OUTLINE)) as typeof OUTLINE;
    // 真实数据里新 API 给的是 viewStatus: completed（completePercent 根本没有）
    const doneUnit = done.result.chapters[0].lessons[0].units[0] as unknown as Record<string, unknown>;
    doneUnit.viewStatus = "completed";
    doneUnit.completePercent = 1;
    const { impl, calls } = fakeFetch({ outline: done });
    const out = await replyDiscussion(ARGS, { browserCookie: async () => "c=1", fetchImpl: impl });
    assert.equal(out.status, "already_complete");
    assert.equal(out.complete_percent_before, 1);
    assert.equal(calls.filter((c) => c.url.includes("/forum/write")).length, 0);
  });

  test("reports unit_not_found instead of posting blindly", async () => {
    const { impl, calls } = fakeFetch({ outline: OUTLINE });
    const out = await replyDiscussion({ ...ARGS, unit_id: "999" }, { browserCookie: async () => "c=1", fetchImpl: impl });
    assert.equal(out.status, "unit_not_found");
    assert.equal(out.isError, true);
    assert.equal(calls.filter((c) => c.url.includes("/forum/write")).length, 0);
  });

  test("maps a 401 to no_session so the caller knows to refresh the browser cookie", async () => {
    const { impl } = fakeFetch({ outline: OUTLINE, write: { status: 401, body: { code: 401, message: "请先登录后继续" } } });
    const out = await replyDiscussion(ARGS, { browserCookie: async () => "c=1", fetchImpl: impl });
    assert.equal(out.status, "no_session");
    assert.equal(out.isError, true);
    assert.ok(out.errors[0].message.includes("401"));
  });
});
