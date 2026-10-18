import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  FALSE_WORDS,
  TRUE_WORDS,
  answerMatchesType,
  cutAnswers,
  fillPlaceholders,
  interpretHandlerResult,
  judgementValue,
  mapQuestionType,
  matchOptionIds,
  parseTikuConfig,
  resolveRequestData,
} from "../src/tiku";
import { stripHtml } from "../src/homework";

describe("cutAnswers", () => {
  test("splits on the separators question banks actually use", () => {
    assert.deepEqual(cutAnswers("A#C"), ["A", "C"]);
    assert.deepEqual(cutAnswers("A|C"), ["A", "C"]);
    assert.deepEqual(cutAnswers("A、C"), ["A", "C"]);
    assert.deepEqual(cutAnswers("A\nC"), ["A", "C"]);
    assert.deepEqual(cutAnswers("  单段答案  "), ["单段答案"]);
    assert.deepEqual(cutAnswers(""), []);
  });
});

describe("judgementValue", () => {
  test("recognises the usual true/false wordings", () => {
    for (const word of ["正确", "对", "√", "T", "true", "1", "是", "yes"]) {
      assert.equal(judgementValue(word), true, word);
    }
    for (const word of ["错误", "错", "×", "F", "false", "0", "否", "no"]) {
      assert.equal(judgementValue(word), false, word);
    }
    assert.equal(judgementValue("大概吧"), null);
    assert.ok(TRUE_WORDS.includes("正确") && FALSE_WORDS.includes("错误"));
  });
});

describe("answerMatchesType", () => {
  // The whole point: a bank that answers a single-choice question with prose must be rejected,
  // otherwise we submit something the platform will mark wrong.
  test("rejects answers whose shape does not fit the question", () => {
    assert.equal(answerMatchesType("B", "single"), true);
    assert.equal(answerMatchesType("A#C", "single"), false);
    assert.equal(answerMatchesType("A#C", "multiple"), true);
    assert.equal(answerMatchesType("正确", "judgement"), true);
    assert.equal(answerMatchesType("B", "judgement"), false);
    assert.equal(answerMatchesType("", "completion"), false);
    assert.equal(answerMatchesType("任意文本", "completion"), true);
    assert.equal(answerMatchesType("随便", "unknown"), true);
  });
});

describe("mapQuestionType", () => {
  // type 10 is an essay ("请结合自身…阐述…"); sending that to a bank wastes a query and returns
  // nonsense, so it maps to unknown and is skipped by the solver.
  test("maps platform codes, and keeps essays out of the bank", () => {
    assert.equal(mapQuestionType(1), "single");
    assert.equal(mapQuestionType(2), "multiple");
    assert.equal(mapQuestionType(4), "judgement");
    assert.equal(mapQuestionType(10), "unknown");
    assert.equal(mapQuestionType(null), "unknown");
    assert.equal(mapQuestionType(99), "unknown");
  });
});

describe("matchOptionIds", () => {
  const options = [
    { id: "101", content: "跳、投" },
    { id: "102", content: "走" },
    { id: "103", content: "跑" },
    { id: "104", content: "走、跑、跳、投" },
  ];

  test("matches by option text, which is what actually scored 8/8", () => {
    assert.deepEqual(matchOptionIds("走、跑、跳、投", options), ["104"]);
    assert.deepEqual(matchOptionIds("跑", options), ["103"]);
  });

  test("falls back to letters", () => {
    assert.deepEqual(matchOptionIds("B", options), ["102"]);
    assert.deepEqual(matchOptionIds("A#C", options), ["101", "103"]);
  });

  test("strips option prefixes and html before comparing", () => {
    const withPrefix = [{ id: "1", content: "A. 马拉松" }];
    assert.deepEqual(matchOptionIds("<p>马拉松</p>", withPrefix), ["1"]);
  });

  test("returns nothing when the answer matches no option", () => {
    assert.deepEqual(matchOptionIds("完全不相干的文本", options), []);
  });

  test("judgement answers resolve against 正确/错误 options", () => {
    const judgement = [
      { id: "900", content: "正确" },
      { id: "901", content: "错误" },
    ];
    assert.deepEqual(matchOptionIds("正确", judgement), ["900"]);
    assert.deepEqual(matchOptionIds("错误", judgement), ["901"]);
  });
});

describe("parseTikuConfig", () => {
  test("accepts a bare array and the wrapper shapes", () => {
    const one = [{ url: "http://x/", handler: "return (r)=>[r.q,r.a]" }];
    assert.equal(parseTikuConfig(JSON.stringify(one)).length, 1);
    assert.equal(parseTikuConfig(JSON.stringify({ answerers: one })).length, 1);
    assert.equal(parseTikuConfig(JSON.stringify({ tiku: one })).length, 1);
    assert.equal(parseTikuConfig("").length, 0);
  });

  test("throws a readable error on bad input", () => {
    assert.throws(() => parseTikuConfig("{ not json"), /不是合法 JSON/);
    assert.throws(() => parseTikuConfig(JSON.stringify({ nope: 1 })), /需要一个数组/);
  });

  test("drops entries without url or handler", () => {
    const mixed = [{ url: "http://x/", handler: "return (r)=>[r.q,r.a]" }, { url: "http://y/" }];
    assert.equal(parseTikuConfig(JSON.stringify(mixed)).length, 1);
  });
});

describe("fillPlaceholders / resolveRequestData", () => {
  const question = { title: "1+1=?", type: "single" as const, options: "A. 1\nB. 2" };

  test("substitutes all three placeholders", () => {
    assert.equal(fillPlaceholders("${title}|${type}|${options}", question), "1+1=?|single|A. 1\nB. 2");
  });

  test("string fields get placeholders, handler fields get evaluated", () => {
    const data = resolveRequestData(
      {
        title: "${title}",
        joined: { handler: "return (env) => env.options.split('\\n').length" },
      },
      question,
    );
    assert.equal(data.title, "1+1=?");
    assert.equal(data.joined, 2);
  });
});

describe("interpretHandlerResult", () => {
  test("reads a single pair", () => {
    assert.deepEqual(interpretHandlerResult(["题", "答"]), { answer: "答", answerer: null, note: null });
  });

  test("reads a list of pairs and takes the first usable answer", () => {
    const out = interpretHandlerResult([
      ["题1", "答1"],
      ["题2", "答2"],
    ]);
    assert.equal(out.answer, "答1");
  });

  test("keeps the message when the bank says it found nothing", () => {
    const out = interpretHandlerResult(["搜索不到", undefined]);
    assert.equal(out.answer, null);
    assert.equal(out.note, "搜索不到");
  });
});

describe("stripHtml entity handling", () => {
  // The platform sprinkles bidi marks into stems; leaving them in makes the question-bank query
  // a different string than what the student sees, which is why this was fixed.
  test("decodes and drops the bidi marks seen in real stems", () => {
    assert.equal(stripHtml("&rlm;田径项目主要由     等组成。"), "田径项目主要由 等组成。");
    assert.equal(stripHtml("&lrm;题"), "题");
    assert.equal(stripHtml("&#8207;题"), "题");
    assert.equal(stripHtml("&#x200F;题"), "题");
  });

  test("still decodes the ordinary entities", () => {
    assert.equal(stripHtml("a &amp; b &lt;c&gt; &quot;d&quot;"), 'a & b <c> "d"');
    assert.equal(stripHtml("&middot;"), "·");
  });
});
