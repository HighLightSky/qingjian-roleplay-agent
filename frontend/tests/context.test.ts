import { IMAGE_SEQUENCE_KEY } from "../lib/images/ids";
import "fake-indexeddb/auto";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  database,
  TABLES,
  saveCharacter,
  createSession,
  beginTurn,
  checkpoint,
  allMessages,
} from "../lib/db";
import { chatContext, type ChatContext } from "../lib/chat/context";
import { DEFAULT_INTERACTION_SETTINGS } from "../lib/domain";
import {
  ensureContextBudget,
  resumeCompactionTasks,
  inspectBudget,
} from "../lib/context/coordinator";
import { takeSnapshot, restoreSnapshot, validateBackup } from "../lib/backup";
import { contextCapabilities } from "./context-fixture";
import type { CompactionResult } from "../lib/context/types";

const commit = <T>(task: () => Promise<T>) => task();
const changed = async () => {};
beforeEach(async () => {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  for (const table of TABLES) await tx.objectStore(table).clear();
  await tx.objectStore("settings").put({ key: IMAGE_SEQUENCE_KEY, value: "0" });
  await tx.done;
});
async function setup() {
  const character = await saveCharacter({
    name: "林溪",
    identity: "旧友",
    description: "旅馆老板",
  });
  const session = await createSession(character.id);
  for (let i = 0; i < 40; i++) {
    const { assistant } = await beginTurn(session.id, `问题${i}`);
    await checkpoint({
      ...assistant,
      status: "complete",
      segments: [{ kind: "dialogue", text: `回复${i}` }],
      checkpointVersion: 1,
    });
  }
  const turn = await beginTurn(session.id, "下一步去废塔");
  const context: ChatContext = chatContext(
    character,
    session,
    [],
    (await allMessages(session.id)).filter((m) => m.seq < turn.user.seq),
    turn.user.text!,
    DEFAULT_INTERACTION_SETTINGS,
  );
  return { context, turn, session };
}
function model(
  transform?: (
    result: CompactionResult,
    context: ChatContext,
  ) => CompactionResult | Promise<CompactionResult>,
) {
  const original = globalThis.fetch;
  const calls: ChatContext[] = [];
  const tokens = (context: ChatContext) =>
    1000 + context.history.length * 2000 + (context.summary.text ? 500 : 0);
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === "/api/capabilities") return Response.json(contextCapabilities);
    const body = JSON.parse(String(init!.body));
    const context: ChatContext = body.context;
    const starts = context.history
      .map((m, i) => (m.role === "user" ? i : -1))
      .filter((i) => i >= 0);
    const through =
      starts.length > 10
        ? context.history[starts[starts.length - 10] - 1].seq
        : context.summary.throughSeq;
    if (path === "/api/context/budget")
      return Response.json({
        inputTokens: tokens(context),
        contextWindowTokens: 193024,
        usageRatio: tokens(context) / 193024,
        outputReserveTokens: 8192,
        safetyTokens: 1024,
        accuracy: "exact",
        needsCompaction: tokens(context) >= 193024 * 0.7,
        fits: tokens(context) + 9216 <= 193024,
        requestFingerprint: `context:${context.summary.version}:${context.history.length}`,
        compactThroughSeq: through,
      });
    assert.equal(path, "/api/context/compact");
    calls.push(context);
    const result: CompactionResult = {
      operationId: body.operationId,
      sessionId: context.state.sessionId,
      baseSessionVersion: context.state.sessionVersion,
      baseMemoryVersion: context.state.memoryVersion,
      baseSummaryVersion: context.summary.version,
      fromExclusiveSeq: context.summary.throughSeq,
      throughSeq: through,
      summary: {
        text: "旅人约定探访废塔，地图线索仍未解决。",
        throughSeq: through,
        version: context.summary.version + 1,
      },
      beforeTokens: tokens(context),
      afterTokens: 41500,
      sourceMessageIds: context.history
        .filter((m) => m.seq <= through)
        .map((m) => m.id),
      sourceFingerprint: "source-fingerprint",
    };
    return Response.json(transform ? await transform(result, context) : result);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("40轮压缩前30轮，最近10轮保持原文，摘要和本轮usage可完整备份恢复", async () => {
  const { context, turn, session } = await setup();
  const mock = model();
  try {
    const result = await ensureContextBudget(
      context,
      "required",
      turn.assistant.id,
      new AbortController().signal,
      commit,
      changed,
      { batches: 0 },
    );
    assert.equal(mock.calls.length, 1);
    assert.equal(result.context.summary.throughSeq, 60);
    assert.deepEqual(
      result.context.history.map((m) => m.seq),
      Array.from({ length: 20 }, (_, i) => i + 61),
    );
    assert.equal((await allMessages(session.id)).length, 82);
    assert.ok(result.budget.usageRatio < 0.5);
    assert.equal(result.compacted, true);
    await checkpoint({
      ...turn.assistant,
      status: "complete",
      segments: [{ kind: "dialogue", text: "一起去吧。" }],
      usage: {
        status: "reported",
        inputTokens: 41500,
        outputTokens: 200,
        totalTokens: 41700,
      },
      checkpointVersion: 1,
    });
    const backup = await takeSnapshot();
    assert.equal(backup.formatVersion, 11);
    validateBackup(backup);
    await restoreSnapshot(backup);
    const restored = await takeSnapshot();
    assert.deepEqual(restored.data, backup.data);
    const corrupt = structuredClone(backup);
    corrupt.data.sessions[0].summary.throughSeq = 900;
    assert.throws(() => validateBackup(corrupt), /摘要覆盖/);
  } finally {
    mock.restore();
  }
});

test("摘要提交失败回滚游标并保留computed，恢复只提交缓存结果", async () => {
  const { context, turn, session } = await setup();
  const mock = model();
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "sessions" && args[0]?.summary?.version > 0)
      throw new Error("摘要存储失败");
    return put.apply(this, args);
  };
  try {
    await assert.rejects(
      () =>
        ensureContextBudget(
          context,
          "required",
          turn.assistant.id,
          new AbortController().signal,
          commit,
          changed,
          { batches: 0 },
        ),
      /摘要存储失败/,
    );
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  try {
    const db = await database();
    assert.equal((await db.get("sessions", session.id))!.summary.version, 0);
    assert.equal((await db.getAll("operations"))[0].status, "computed");
    const frozen = await takeSnapshot();
    validateBackup(frozen);
    await restoreSnapshot(frozen);
    await resumeCompactionTasks(
      session.id,
      new AbortController().signal,
      commit,
      changed,
    );
    assert.equal(mock.calls.length, 1);
    assert.equal(
      (await db.get("sessions", session.id))!.summary.throughSeq,
      60,
    );
    assert.equal(await db.count("compactionTasks"), 0);
  } finally {
    mock.restore();
  }
});

test("压缩期间领域版本变化会重新计算，旧摘要不覆盖新状态", async () => {
  const { context, turn, session } = await setup();
  let changedVersion = false;
  const mock = model(async (result) => {
    if (!changedVersion) {
      changedVersion = true;
      const db = await database();
      const current = (await db.get("sessions", session.id))!;
      await db.put("sessions", {
        ...current,
        stateVersion: 1,
        story: { ...current.story, location: "人工修改地点" },
      });
    }
    return result;
  });
  try {
    await ensureContextBudget(
      context,
      "required",
      turn.assistant.id,
      new AbortController().signal,
      commit,
      changed,
      { batches: 0 },
    );
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[1].state.sessionVersion, 1);
    const current = (await (await database()).get("sessions", session.id))!;
    assert.equal(current.story.location, "人工修改地点");
    assert.equal(current.summary.version, 1);
  } finally {
    mock.restore();
  }
});

test("取消后的迟到摘要不提交，错误来源也不能推进游标", async () => {
  const { context, turn, session } = await setup();
  const controller = new AbortController();
  const mock = model((result) => {
    controller.abort();
    return result;
  });
  try {
    await assert.rejects(() =>
      ensureContextBudget(
        context,
        "required",
        turn.assistant.id,
        controller.signal,
        commit,
        changed,
        { batches: 0 },
      ),
    );
    assert.equal(
      (await (await database()).get("sessions", session.id))!.summary.version,
      0,
    );
    assert.equal(
      (await (await database()).getAll("operations"))[0].status,
      "cancelled",
    );
  } finally {
    mock.restore();
  }
  const bad = model((result) => ({
    ...result,
    sourceMessageIds: ["another-session"],
  }));
  try {
    await assert.rejects(
      () =>
        resumeCompactionTasks(
          session.id,
          new AbortController().signal,
          commit,
          changed,
        ),
      /来源不一致/,
    );
    assert.equal(
      (await (await database()).get("sessions", session.id))!.summary.version,
      0,
    );
  } finally {
    bad.restore();
  }
});

test("配置预算不需要压缩时不创建任务，未知用量不伪装成零", async () => {
  const { context, turn } = await setup();
  context.history = context.history.slice(-20);
  const mock = model();
  try {
    const result = await ensureContextBudget(
      context,
      "required",
      turn.assistant.id,
      new AbortController().signal,
      commit,
      changed,
      { batches: 0 },
    );
    assert.equal(result.compacted, false);
    assert.equal(mock.calls.length, 0);
    assert.equal(await (await database()).count("compactionTasks"), 0);
    const budget = await inspectBudget(
      context,
      "preview",
      new AbortController().signal,
    );
    assert.equal(budget.inputTokens, 41000);
  } finally {
    mock.restore();
  }
});
