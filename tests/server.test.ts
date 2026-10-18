import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { COURSE_LIST_RPC_URL, WARMUP_URL } from "../src/auth";
import type { Icourse163Http, Icourse163Ports } from "../src/ports";
import { createIcourse163McpServer } from "../src/server";
import { EMPTY_COURSE_PANEL_BODY } from "./fixtures";

describe("icourse163 MCP server", () => {
  test("registers list_todos and returns auth_expired without a session", async () => {
    const server = createIcourse163McpServer({
      credentials: { getCookie: async () => null },
      http: {
        async request() {
          throw new Error("http should not run");
        },
      },
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, ["get_homework", "list_courses", "list_term_units", "list_todos", "save_homework_answers", "session_status", "solve_quiz", "study_unit", "submit_homework"]);

      const result = await client.callTool({ name: "list_todos", arguments: {} });
      assert.equal("isError" in result && result.isError, true);

      const payload = structuredPayload(result);
      assert.equal(payload.status, "auth_expired");
      assert.notEqual(payload.status, "ok");
      assert.notEqual(payload.status, "not_implemented");
      assert.deepEqual(payload.todos, []);
      assert.equal("cookie" in payload, false);
      assert.equal(JSON.stringify(payload).includes("test-session"), false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("returns ok and empty todos when mock ports have no open items", async () => {
    const http: Icourse163Http = {
      async request(input) {
        if (input.url === WARMUP_URL) {
          return {
            statusCode: 200,
            url: input.url,
            body: "<html>ok</html>",
            cookie: `${input.cookie}; STUDY_INFO=ok`,
          };
        }
        if (input.url.startsWith(COURSE_LIST_RPC_URL)) {
          return {
            statusCode: 200,
            url: input.url,
            body: EMPTY_COURSE_PANEL_BODY,
            cookie: input.cookie,
          };
        }
        throw new Error(`unexpected url ${input.url}`);
      },
    };
    const ports: Icourse163Ports = {
      credentials: { getCookie: async () => "NTESSTUDYSI=test-session" },
      http,
    };
    const server = createIcourse163McpServer(ports);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({ name: "list_todos", arguments: {} });
      assert.equal("isError" in result && result.isError, false);
      const payload = structuredPayload(result);
      assert.equal(payload.status, "ok");
      assert.deepEqual(payload.todos, []);
    } finally {
      await client.close();
      await server.close();
    }
  });
  test("registers list_courses and list_term_units; auth_expired without session", async () => {
    const server = createIcourse163McpServer({
      credentials: { getCookie: async () => null },
      http: {
        async request() {
          throw new Error("http should not run");
        },
      },
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const courses = await client.callTool({ name: "list_courses", arguments: {} });
      assert.equal("isError" in courses && courses.isError, true);
      const coursesPayload = structuredPayload(courses);
      assert.equal(coursesPayload.status, "auth_expired");
      assert.deepEqual(coursesPayload.courses, []);

      const units = await client.callTool({
        name: "list_term_units",
        arguments: { course_id: "1001", term_id: "2001", school_short_name: "SJTU" },
      });
      assert.equal("isError" in units && units.isError, true);
      const unitsPayload = structuredPayload(units);
      assert.equal(unitsPayload.status, "auth_expired");
      assert.deepEqual(unitsPayload.lessons, []);
      assert.equal(JSON.stringify(unitsPayload).includes("test-session"), false);

      const study = await client.callTool({
        name: "study_unit",
        arguments: {
          course_id: "1001",
          term_id: "2001",
          unit_id: "401",
          school_short_name: "SJTU",
        },
      });
      assert.equal("isError" in study && study.isError, true);
      const studyPayload = structuredPayload(study);
      assert.equal(studyPayload.status, "auth_expired");
      assert.equal(studyPayload.completed, false);
      assert.equal(JSON.stringify(studyPayload).includes("test-session"), false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("get_homework / save_homework_answers auth_expired without session; no cookies in payload", async () => {
    const server = createIcourse163McpServer({
      credentials: { getCookie: async () => null },
      http: {
        async request() {
          throw new Error("http should not run");
        },
      },
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const got = await client.callTool({
        name: "get_homework",
        arguments: { todo_id: "1001:2001:quiz:301" },
      });
      assert.equal("isError" in got && got.isError, true);
      const gotPayload = structuredPayload(got);
      assert.equal(gotPayload.status, "auth_expired");
      assert.equal(gotPayload.draft_only, true);
      assert.equal(JSON.stringify(gotPayload).includes("test-session"), false);

      const saved = await client.callTool({
        name: "save_homework_answers",
        arguments: {
          todo_id: "1001:2001:quiz:301",
          answers: [{ question_id: "11", option_ids: ["102"] }],
        },
      });
      assert.equal("isError" in saved && saved.isError, true);
      const savedPayload = structuredPayload(saved);
      assert.equal(savedPayload.status, "auth_expired");
      assert.equal(savedPayload.submitted, false);
      assert.equal(savedPayload.preview, true);
    } finally {
      await client.close();
      await server.close();
    }
  });

});

function structuredPayload(result: unknown): Record<string, unknown> {
  assert.ok(result !== null && typeof result === "object");
  const record = result as Record<string, unknown>;

  if (
    record.structuredContent !== null &&
    typeof record.structuredContent === "object" &&
    record.structuredContent !== undefined &&
    "status" in record.structuredContent
  ) {
    return record.structuredContent as Record<string, unknown>;
  }

  assert.ok(Array.isArray(record.content) && record.content.length > 0);
  const first = record.content[0];
  assert.ok(first !== null && typeof first === "object");
  const item = first as { type?: unknown; text?: unknown };
  assert.equal(item.type, "text");
  const text = item.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text as string) as Record<string, unknown>;
}
