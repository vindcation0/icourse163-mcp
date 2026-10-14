import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildLearnContentHash,
  buildLearnUnitUrl,
  chooseNavStrategy,
  classifyCourseKind,
  cookieHeaderToPlaywrightCookies,
  textIndicatesMissingUnit,
} from "../src/study-playwright";

describe("buildLearnUnitUrl", () => {
  // The content hash takes the 课时 (lesson) id as `id` and the 课件 (unit) id as
  // `cid`. The previous ordering (unit id as `id`, video content id as `cid`)
  // produced a hash the SPA silently fails to resolve, so no player ever mounted.
  test("builds learn hash URL with lesson id as id and unit id as cid", () => {
    const url = buildLearnUnitUrl({
      course_id: "1473617163",
      term_id: "2001",
      school_short_name: "kaopei",
      unit_id: "1305575068",
      lesson_id: "1265444045",
      content_id: "1231832139",
    });
    assert.equal(
      url,
      "https://www.icourse163.org/learn/kaopei-1473617163?tid=2001#/learn/content?type=detail&id=1265444045&cid=1305575068",
    );
  });

  test("never uses content_id as cid", () => {
    const url = buildLearnUnitUrl({
      course_id: "1001",
      term_id: "2001",
      school_short_name: "",
      unit_id: "401",
      lesson_id: "301",
      content_id: "999",
    });
    assert.ok(url.endsWith("#/learn/content?type=detail&id=301&cid=401"), url);
  });

  test("falls back to unit_id for both segments when content_id is missing", () => {
    const url = buildLearnUnitUrl({
      course_id: "1001",
      term_id: "2001",
      school_short_name: "",
      unit_id: "401",
      content_id: null,
    });
    assert.match(url, /#\/learn\/content\?type=detail&id=401&cid=401$/);
  });
});

describe("cookieHeaderToPlaywrightCookies", () => {
  test("maps cookie header pairs to icourse163 domain cookies", () => {
    const cookies = cookieHeaderToPlaywrightCookies(
      "NTESSTUDYSI=abc; STUDY_INFO=xyz",
    );
    assert.equal(cookies.length, 2);
    assert.equal(cookies[0]?.domain, ".icourse163.org");
    assert.equal(cookies[0]?.path, "/");
    const names = cookies.map((c) => c.name).sort();
    assert.deepEqual(names, ["NTESSTUDYSI", "STUDY_INFO"]);
  });
});

describe("classifyCourseKind", () => {
  test("kaopei and empty school are non_school", () => {
    assert.equal(classifyCourseKind("kaopei"), "non_school");
    assert.equal(classifyCourseKind(""), "non_school");
  });

  test("university short names are school", () => {
    assert.equal(classifyCourseKind("JXUFE"), "school");
  });
});

describe("buildLearnContentHash", () => {
  test("matches buildLearnUnitUrl hash fragment", () => {
    const url = buildLearnUnitUrl({
      course_id: "1473617163",
      term_id: "1475287452",
      school_short_name: "kaopei",
      unit_id: "1303386815",
      lesson_id: "1265444045",
      content_id: "1231832139",
    });
    const hash = buildLearnContentHash("1265444045", "1303386815");
    assert.ok(url.endsWith(hash), `url=${url} hash=${hash}`);
  });

  // Verified against the live site: clicking a tree unit lands on
  // #/learn/content?type=detail&id=<lessonId>&cid=<unitId>. Using the unit id as
  // `id` (or the video content id as `cid`) produces a hash the SPA cannot
  // resolve, and no player ever mounts.
  test("uses lesson id as id and unit id as cid", () => {
    assert.equal(
      buildLearnContentHash("1265444045", "1305575068"),
      "#/learn/content?type=detail&id=1265444045&cid=1305575068",
    );
    const swapped = buildLearnContentHash("1305575068", "1265444045");
    assert.notEqual(swapped, "#/learn/content?type=detail&id=1265444045&cid=1305575068");
  });

  test("falls back to unit id when no lesson id is known", () => {
    const url = buildLearnUnitUrl({
      course_id: "1473617163",
      term_id: "1475287452",
      school_short_name: "kaopei",
      unit_id: "1303386815",
      content_id: "1231832139",
    });
    assert.ok(url.endsWith(buildLearnContentHash("1303386815", "1303386815")));
  });
});

describe("textIndicatesMissingUnit", () => {
  test("detects missing-unit copy", () => {
    assert.equal(textIndicatesMissingUnit("提示：该课时数据不存在"), true);
    assert.equal(textIndicatesMissingUnit("正常课件"), false);
  });
});

describe("chooseNavStrategy", () => {
  test("prefers tree_click when tree produced media", () => {
    assert.equal(
      chooseNavStrategy({
        treeClickSucceeded: true,
        mediaVisible: true,
        missingUnitVisible: false,
        deeplinkMediaVisible: false,
      }),
      "tree_click",
    );
  });

  test("uses deeplink_fallback only when deeplink found media", () => {
    assert.equal(
      chooseNavStrategy({
        treeClickSucceeded: false,
        mediaVisible: false,
        missingUnitVisible: true,
        deeplinkMediaVisible: true,
      }),
      "deeplink_fallback",
    );
  });

  test("returns null when nothing worked", () => {
    assert.equal(
      chooseNavStrategy({
        treeClickSucceeded: false,
        mediaVisible: false,
        missingUnitVisible: true,
        deeplinkMediaVisible: false,
      }),
      null,
    );
  });
});
