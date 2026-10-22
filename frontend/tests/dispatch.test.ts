import "fake-indexeddb/auto";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  database,
  TABLES,
  saveCharacter,
  createSession,
  beginTurn,
  allMessages,
  recoverInterrupted,
} from "../lib/db";
import { IMAGE_SEQUENCE_KEY } from "../lib/images/ids";
import { DEFAULT_INTERACTION_SETTINGS } from "../lib/domain";
import { chatContext } from "../lib/chat/context";
import {
  followDispatch,
  type StoredRun,
  type DispatchSnapshot,
} from "../lib/chat/dispatch";
import { warmImageCache } from "../lib/images/coordinator";
import {
  saveCompletedStateTask,
  acceptStateResult,
  runStateTask,
} from "../lib/state/coordinator";
import {
  sendMessage,
  resumeDispatch,
  useAppStore,
} from "../stores/use-app-store";
import { emptyStateResult } from "./state-fixture";
import { dispatchResponse } from "./dispatch-fixture";
import { contextFixture } from "./context-fixture";
const original = globalThis.fetch;
beforeEach(async () => {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  for (const table of TABLES) await tx.objectStore(table).clear();
  await tx.objectStore("settings").put({ key: IMAGE_SEQUENCE_KEY, value: "0" });
  await tx.done;
  useAppStore.setState({
    ready: true,
    readOnly: false,
    activeSessionId: null,
    messages: [],
    operations: [],
    goals: [],
    error: "",
    interactionSettings: DEFAULT_INTERACTION_SETTINGS,
  });
});
afterEach(() => {
  globalThis.fetch = original;
});
async function setup() {
  const character = await saveCharacter({
    name: "林溪",
    identity: "",
    description: "",
  });
  const session = await createSession(character.id);
  useAppStore.setState({
    characterId: character.id,
    sessionId: session.id,
    characters: [character],
    sessions: [session],
  });
  return { character, session };
}
const sse = (events: [string, unknown][]) =>
  new Response(
    events
      .map(
        ([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
function snapshot(runId: string, terminal: boolean): DispatchSnapshot {
  return {
    runId,
    revision: 1,
    segments: [{ kind: "dialogue", text: "先说" }],
    stages: {},
    budget: null,
    plan: null,
    body: null,
    state: null,
    terminal,
    error: null,
  };
}

test("断流后只恢复订阅，完整快照替换旧正文，不重复提交生成", async () => {
  const calls: string[] = [];
  const run = {
    runId: "run",
    sessionId: "session",
    assistantMessageId: "assistant",
    context: {},
  } as StoredRun;
  globalThis.fetch = async (path, init) => {
    calls.push(`${init?.method} ${path}`);
    return calls.length === 1
      ? sse([["snapshot", snapshot("run", false)]])
      : sse([
          [
            "snapshot",
            {
              ...snapshot("run", true),
              revision: 4,
              segments: [{ kind: "dialogue", text: "先说，然后继续" }],
            },
          ],
        ]);
  };
  const seen: string[] = [];
  await followDispatch(
    run,
    new AbortController().signal,
    async (state) => {
      seen.push(state.segments.map((s) => s.text).join(""));
    },
    {},
  );
  assert.deepEqual(calls, ["POST /api/chat", "GET /api/chat/run/events"]);
  assert.deepEqual(seen, ["先说", "先说，然后继续"]);
});

test("恢复边界重复序号不再次追加，拆分 UTF-8 正文完整保留", async () => {
  const run = { runId: "run" } as StoredRun;
  const initial = snapshot("run", false);
  const terminal = {
    ...snapshot("run", true),
    revision: 3,
    segments: [{ kind: "dialogue", text: "先说你好🌱" }],
  };
  const bytes = new TextEncoder().encode(
    await sse([
      ["snapshot", initial],
      ["delta", { revision: 1, value: { kind: "dialogue", text: "重复" } }],
      ["delta", { revision: 2, value: { kind: "dialogue", text: "你好🌱" } }],
      ["done", { revision: 3, value: terminal }],
    ]).text(),
  );
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i++)
            controller.enqueue(bytes.slice(i, i + 1));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const seen: string[] = [];
  await followDispatch(run, new AbortController().signal, async (state) => {
    seen.push(state.segments.map((s) => s.text).join(""));
  });
  assert.equal(seen.at(-1), "先说你好🌱");
  assert.ok(seen.every((text) => !text.includes("重复")));
});

test("一次发送包含完整上下文，整理失败不触发补做，下一轮继续", async () => {
  const { session } = await setup();
  const calls: string[] = [];
  let requests = 0;
  globalThis.fetch = async (path, init) => {
    calls.push(String(path));
    const fixture = contextFixture(String(path), init);
    if (fixture) return fixture;
    if (String(path).endsWith("/ack")) return Response.json({});
    assert.equal(String(path), "/api/chat");
    requests++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.context.visual.imagePayloads.length, 0);
    return dispatchResponse(request, true);
  };
  await sendMessage("第一轮");
  await sendMessage("第二轮");
  assert.equal(requests, 2);
  assert.ok(!calls.includes("/api/state/update"));
  const messages = await allMessages(session.id);
  assert.deepEqual(
    messages.filter((m) => m.role === "assistant").map((m) => m.status),
    ["complete", "complete"],
  );
  const tasks = await (await database()).getAll("stateTasks");
  assert.equal(tasks.length, 1);
  const operations = (await (await database()).getAll("operations")).filter(
    (o) => o.kind === "state_update",
  );
  assert.equal(operations.filter((o) => o.status === "stale").length, 1);
});

test("正文已保存后 ACK 失败，恢复只重取结果且不重复推进版本", async () => {
  const { session } = await setup();
  let saved = "";
  let acks = 0;
  let generations = 0;
  globalThis.fetch = async (path, init) => {
    const fixture = contextFixture(String(path), init);
    if (fixture) return fixture;
    if (String(path).endsWith("/ack")) {
      acks++;
      return acks === 1
        ? Response.json({ message: "确认失败" }, { status: 502 })
        : Response.json({});
    }
    if (String(path) === "/api/chat") {
      generations++;
      saved = await dispatchResponse(JSON.parse(String(init?.body))).text();
    }
    return new Response(saved, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  await sendMessage("继续");
  assert.equal(
    (await (await database()).getAll("settings")).filter((s) =>
      s.key.startsWith("dispatch:"),
    ).length,
    1,
  );
  const first = await (await database()).get("sessions", session.id);
  await resumeDispatch();
  assert.equal(generations, 1);
  assert.equal(acks, 2);
  assert.equal(
    (await (await database()).get("sessions", session.id))!.stateVersion,
    first!.stateVersion,
  );
  assert.equal(
    (await (await database()).getAll("settings")).filter((s) =>
      s.key.startsWith("dispatch:"),
    ).length,
    0,
  );
});

test("领域提交失败不发送 ACK，保留后台句柄以便再次取回", async () => {
  await setup();
  let acks = 0;
  globalThis.fetch = async (path, init) => {
    const fixture = contextFixture(String(path), init);
    if (fixture) return fixture;
    if (String(path).endsWith("/ack")) {
      acks++;
      return Response.json({});
    }
    const request = JSON.parse(String(init?.body));
    const response = dispatchResponse(request);
    const raw = await response.text();
    const parsed = JSON.parse(raw.split("data: ")[1].trim());
    parsed.state.goalChanges = [
      {
        action: "update",
        id: "missing-goal",
        expectedVersion: 2,
        before: {},
        value: {},
        reason: "依据",
        sourceMessageIds: [request.assistant.id],
      },
    ];
    return sse([["snapshot", parsed]]);
  };
  await sendMessage("继续");
  assert.equal(acks, 0);
  assert.equal(
    (await (await database()).getAll("settings")).filter((s) =>
      s.key.startsWith("dispatch:"),
    ).length,
    1,
  );
});

test("启动恢复不把持有后台任务的正文标记为中断，过期后才标记", async () => {
  const { character, session } = await setup();
  const turn = await beginTurn(session.id, "继续");
  const context = chatContext(
    character,
    session,
    [],
    [],
    "继续",
    DEFAULT_INTERACTION_SETTINGS,
  );
  const stored: StoredRun = {
    runId: "expired",
    sessionId: session.id,
    assistantMessageId: turn.assistant.id,
    context,
  };
  await (
    await database()
  ).put("settings", { key: "dispatch:expired", value: JSON.stringify(stored) });
  await recoverInterrupted();
  assert.equal(
    (await (await database()).get("messages", turn.assistant.id))!.status,
    "pending",
  );
  globalThis.fetch = async () =>
    Response.json(
      { code: "RESULT_EXPIRED", message: "结果已过期" },
      { status: 404 },
    );
  await resumeDispatch();
  assert.equal(
    (await (await database()).get("messages", turn.assistant.id))!.status,
    "interrupted",
  );
});

test("新整理任务使旧任务不可重试，已提交结果重复取回不重复写入", async () => {
  const { character, session } = await setup();
  async function turn(text: string) {
    const value = await beginTurn(session.id, text);
    const assistant = {
      ...value.assistant,
      status: "complete" as const,
      segments: [{ kind: "narration" as const, text: "回应" }],
    };
    const context = chatContext(
      character,
      session,
      [],
      [],
      text,
      DEFAULT_INTERACTION_SETTINGS,
    );
    return {
      task: await saveCompletedStateTask(context, assistant),
      context,
      value,
    };
  }
  const old = await turn("第一轮");
  const next = await turn("第二轮");
  await assert.rejects(
    runStateTask(
      old.task,
      new AbortController().signal,
      (fn) => fn(),
      async () => {},
    ),
    /缺少待办/,
  );
  const result = emptyStateResult({
    operationId: next.task.id,
    context: next.context,
    fromExclusiveSeq: next.value.user.seq - 1,
    throughSeq: next.value.assistant.seq,
    messages: [],
  });
  await acceptStateResult(
    next.task,
    result,
    (fn) => fn(),
    async () => {},
  );
  await acceptStateResult(
    next.task,
    result,
    (fn) => fn(),
    async () => {},
  );
  assert.equal(
    (await (await database()).get("sessions", session.id))!.stateVersion,
    0,
  );
});
