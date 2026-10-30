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
import { takeSnapshot, restoreSnapshot, validateBackup } from "../lib/backup";
import { plainText, type ReasoningTrace } from "../lib/domain";
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

for (const finishReason of ["stop", "length"]) {
  test(`正文失败提示保留具体原因、任务编号与诊断信息：${finishReason}`, async () => {
    const { session } = await setup();
    let runId = "";
    const detail = `java.io.IOException: 正文生成失败；finish_reason=${finishReason}；本次输出上限=8192 token；输入 token=100；输出 token=12；总 token=112`;
    globalThis.fetch = async (path, init) => {
      const fixture = contextFixture(String(path), init);
      if (fixture) return fixture;
      if (String(path).endsWith("/ack")) return Response.json({});
      assert.equal(String(path), "/api/chat");
      const request = JSON.parse(String(init?.body));
      runId = request.runId;
      return sse([
        [
          "snapshot",
          {
            ...snapshot(runId, true),
            segments:
              finishReason === "stop"
                ? []
                : [{ kind: "narration", text: "已收到的部分正文" }],
            stages: { body: { name: "body", status: "failed", error: detail } },
            body: {
              finishReason,
              usage: {
                status: "reported",
                inputTokens: 100,
                outputTokens: 12,
                totalTokens: 112,
              },
            },
            error: detail,
          },
        ],
      ]);
    };
    await sendMessage("继续");
    const reply = (await allMessages(session.id)).find(
      (m) => m.role === "assistant",
    )!;
    assert.equal(reply.status, "error");
    assert.ok(
      reply.error!.startsWith(
        finishReason === "stop"
          ? "正文生成失败：模型已正常结束，但没有返回有效正文。"
          : "正文生成中断：模型达到长度限制，回复未完整生成。",
      ),
    );
    assert.ok(reply.error!.includes("本轮未进行状态整理。"));
    assert.ok(reply.error!.includes(detail));
    assert.ok(reply.error!.includes(`任务 ID：${runId}`));
    assert.equal(
      useAppStore.getState().messages.find((m) => m.id === reply.id)!.error,
      reply.error,
    );
    assert.equal((await (await database()).getAll("stateTasks")).length, 0);
    if (finishReason === "length")
      assert.equal(reply.segments![0].text, "已收到的部分正文");
  });
}

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
      checkpointVersion: 1,
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
    assistantCheckpointVersion: 1,
    messages: [
      {
        id: next.value.assistant.id,
        seq: next.value.assistant.seq,
        role: "assistant",
        text: "回应",
        status: "complete",
        createdAt: next.value.assistant.createdAt,
      },
    ],
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

test("本轮新附件的原件元信息进入生图目录，但仍由系统必选而不参加历史选图", async () => {
  await setup();
  const { sha256 } = await import("../lib/images/hash");
  const bytes = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP2kAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const hash = sha256(bytes);
  const db = await database();
  await db.put("assets", {
    id: "img1",
    creationOrigin: "uploaded",
    sha256: hash,
    mimeType: "image/png",
    byteSize: bytes.length,
    width: 1,
    height: 1,
    displayName: "本轮.png",
    originalBlob: new Blob([bytes], { type: "image/png" }),
    createdAt: new Date().toISOString(),
  });
  let captured: any;
  globalThis.fetch = async (path, init) => {
    const context = contextFixture(String(path), init);
    if (context) return context;
    if (path === "/api/images/missing") return Response.json({ missing: [] });
    if (path === "/api/chat") {
      captured = JSON.parse(String(init!.body));
      return dispatchResponse(captured);
    }
    if (String(path).endsWith("/ack")) return new Response(null);
    throw new Error(`意外请求：${path}`);
  };
  await sendMessage("参考这张照片", [{ type: "image", assetId: "img1" }]);
  assert.ok(captured, useAppStore.getState().error);
  const entry = captured.context.visual.assetCatalog[0];
  assert.equal(entry.assetId, "img1");
  assert.equal(entry.sourceSha256, hash);
  assert.equal(entry.sources[0].messageId, captured.user.id);
  assert.deepEqual(captured.context.visual.imagePayloads, []);
});

test("思考增量按序号去重，重订阅快照替换原内容并保存结束时间", async () => {
  const trace: ReasoningTrace = {
    text: "先思考",
    status: "streaming",
    startedAt: 1000,
    endedAt: null,
  };
  const initial = { ...snapshot("run", false), reasoning: trace };
  const completed: DispatchSnapshot = {
    ...snapshot("run", true),
    revision: 4,
    reasoning: {
      ...trace,
      text: "先思考，再回应",
      status: "complete",
      endedAt: 2000,
    },
  };
  let requests = 0;
  globalThis.fetch = async () =>
    ++requests === 1
      ? sse([
          ["snapshot", initial],
          [
            "reasoning",
            {
              revision: 2,
              value: {
                delta: "，再回应",
                status: "streaming",
                startedAt: 1000,
                endedAt: null,
              },
            },
          ],
          [
            "reasoning",
            {
              revision: 2,
              value: {
                delta: "重复",
                status: "streaming",
                startedAt: 1000,
                endedAt: null,
              },
            },
          ],
        ])
      : sse([
          ["snapshot", { ...completed, terminal: false, revision: 3 }],
          [
            "reasoning",
            {
              revision: 3,
              value: {
                delta: "重复",
                status: "complete",
                startedAt: 1000,
                endedAt: 2000,
              },
            },
          ],
          ["done", { revision: 4, value: completed }],
        ]);
  const seen: DispatchSnapshot[] = [];
  await followDispatch(
    { runId: "run" } as StoredRun,
    new AbortController().signal,
    async (value) => {
      seen.push(value);
    },
  );
  assert.equal(requests, 2);
  assert.equal(seen.at(-1)!.reasoning!.text, "先思考，再回应");
  assert.equal(seen.at(-1)!.reasoning!.endedAt, 2000);
  assert.ok(seen.every((value) => !value.reasoning!.text.includes("重复")));
});

test("思考随消息及 v13 备份保存，普通复制和下一轮上下文不含思考，兼容 v12", async () => {
  const { session } = await setup();
  const trace: ReasoningTrace = {
    text: "仅供查看的推理，不应发回模型",
    status: "complete",
    startedAt: 1000,
    endedAt: 2000,
  };
  let calls = 0;
  globalThis.fetch = async (path, init) => {
    const fixture = contextFixture(String(path), init);
    if (fixture) return fixture;
    if (String(path).endsWith("/ack")) return Response.json({});
    const request = JSON.parse(String(init?.body));
    assert.ok(!JSON.stringify(request.context).includes(trace.text));
    calls++;
    const raw = await dispatchResponse(request).text();
    const complete = JSON.parse(
      raw.split("data: ")[1].trim(),
    ) as DispatchSnapshot;
    return sse([["snapshot", { ...complete, reasoning: trace }]]);
  };
  await sendMessage("你好");
  await sendMessage("继续");
  assert.equal(calls, 2);
  const replies = (await allMessages(session.id)).filter(
    (m) => m.role === "assistant",
  );
  assert.deepEqual(replies[0].reasoning, trace);
  assert.ok(!plainText(replies[0]).includes(trace.text));
  const backup = await takeSnapshot();
  assert.equal(backup.formatVersion, 16);
  await restoreSnapshot(backup);
  assert.deepEqual(
    (await allMessages(session.id)).find((m) => m.id === replies[0].id)!
      .reasoning,
    trace,
  );
  const legacy = JSON.parse(JSON.stringify(backup));
  legacy.formatVersion = 12;
  for (const message of legacy.data.messages) delete message.reasoning;
  const converted = validateBackup(legacy);
  assert.equal(converted.formatVersion, 16);
  assert.ok(converted.data.messages.every((m) => m.reasoning === undefined));
  const corrupt = JSON.parse(JSON.stringify(backup));
  corrupt.data.messages.find(
    (m: { role: string }) => m.role === "assistant",
  ).reasoning.endedAt = 500;
  assert.throws(() => validateBackup(corrupt), /序号或版本/);
  const badStatus = JSON.parse(JSON.stringify(backup));
  badStatus.data.messages.find(
    (m: { role: string }) => m.role === "assistant",
  ).reasoning.status = "unknown";
  assert.throws(() => validateBackup(badStatus), /思考状态/);
});

for (const status of ["cancelled", "error"] as const) {
  test(`仅思考时${status}保留内容，不触发状态整理`, async () => {
    const { session } = await setup();
    const trace: ReasoningTrace = {
      text: "已生成的思考",
      status,
      startedAt: 1000,
      endedAt: 2000,
    };
    globalThis.fetch = async (path, init) => {
      const fixture = contextFixture(String(path), init);
      if (fixture) return fixture;
      if (String(path).endsWith("/ack")) return Response.json({});
      const request = JSON.parse(String(init?.body));
      return sse([
        [
          "snapshot",
          {
            ...snapshot(request.runId, true),
            segments: [],
            reasoning: trace,
            stages: {
              body: {
                name: "body",
                status: status === "error" ? "failed" : "cancelled",
                error: "生成中断",
              },
            },
            error: "生成中断",
          },
        ],
      ]);
    };
    await sendMessage("继续");
    const reply = (await allMessages(session.id)).find(
      (m) => m.role === "assistant",
    )!;
    assert.equal(reply.status, status);
    assert.deepEqual(reply.reasoning, trace);
    assert.equal((await (await database()).getAll("stateTasks")).length, 0);
  });
}

test("后台句柄缺失的思考检查点恢复为中断，保留思考内容", async () => {
  const { session } = await setup();
  const { assistant } = await beginTurn(session.id, "继续");
  const db = await database();
  await db.put("messages", {
    ...assistant,
    reasoning: {
      text: "保存中的思考",
      status: "streaming",
      startedAt: 1000,
      endedAt: null,
    },
  });
  await recoverInterrupted();
  const restored = (await db.get("messages", assistant.id))!;
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.reasoning!.status, "error");
  assert.equal(restored.reasoning!.text, "保存中的思考");
  assert.ok(restored.reasoning!.endedAt! >= 1000);
});
