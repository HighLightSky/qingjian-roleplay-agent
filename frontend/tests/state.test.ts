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
  allMessages,
  checkpoint,
  putMemory,
  recoverInterrupted,
} from "../lib/db";
import { DEFAULT_INTERACTION_SETTINGS } from "../lib/domain";
import { chatContext, stateSnapshot } from "../lib/chat/context";
import { saveCompletedStateTask, runStateTask } from "../lib/state/coordinator";
import { projectMessages } from "../lib/state/projection";
import { emptyStateResult, type UpdateBody } from "./state-fixture";
import { takeSnapshot, restoreSnapshot, validateBackup } from "../lib/backup";
import type { StateResult, MemoryValue } from "../lib/state/types";

const commit = <T>(task: () => Promise<T>) => task();
const changed = async () => {};
const memory: MemoryValue = {
  content: "用户希望称作阿远",
  scope: "session",
  kind: "preference",
  epistemicStatus: "established",
  status: "active",
};
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
    description: "老板",
  });
  const session = await createSession(character.id);
  const turn = await beginTurn(session.id, "到了旅馆");
  const assistant = {
    ...turn.assistant,
    status: "complete" as const,
    finishReason: "stop",
    segments: [{ kind: "narration" as const, text: "她走入旅馆。" }],
    checkpointVersion: 1,
  };
  const context = chatContext(
    character,
    session,
    [],
    [],
    turn.user.text!,
    DEFAULT_INTERACTION_SETTINGS,
    undefined,
    [],
    `select:${assistant.id}`,
  );
  const task = await saveCompletedStateTask(context, assistant);
  return { character, session, turn, assistant, task };
}
function withModel(
  answer: (body: UpdateBody) => StateResult | Promise<StateResult>,
) {
  const original = globalThis.fetch;
  const calls: UpdateBody[] = [];
  globalThis.fetch = async (path, init) => {
    assert.equal(String(path), "/api/state/update");
    const body: UpdateBody = JSON.parse(String(init!.body));
    calls.push(body);
    return Response.json(await answer(body));
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
function updates(body: UpdateBody): StateResult {
  const result = emptyStateResult(body);
  const sourceMessageIds = [body.messages.at(-1)!.id];
  result.storyChanges = [
    {
      action: "update",
      id: "location",
      expectedVersion: body.context.state.sessionVersion,
      before: "",
      value: "旅馆",
      reason: "正文进入旅馆",
      sourceMessageIds,
    },
  ];
  result.storyChanges.push(
    ...(["characterState", "userState"] as const).map((id) => ({
      action: "update" as const,
      id,
      expectedVersion: body.context.state.sessionVersion,
      before: "",
      value:
        id === "characterState"
          ? "穿灰外套，神情平静，手腕受伤"
          : "穿校服，自述紧张",
      reason: "对话明确呈现",
      sourceMessageIds,
    })),
  );
  result.memoryChanges = [
    {
      action: "create",
      id: "memory-created",
      expectedVersion: 0,
      before: null,
      value: memory,
      reason: "明确偏好",
      sourceMessageIds,
    },
  ];
  result.goalChanges = [
    {
      action: "create",
      id: "goal-created",
      expectedVersion: 0,
      before: null,
      value: {
        description: "寻找哥哥",
        status: "active",
        currentFocus: "询问掌柜",
        progressSummary: "为了寻找哥哥来到旅馆，得知登记册可能留下了相关信息。",
      },
      reason: "对话形成目标",
      sourceMessageIds,
    },
  ];
  return result;
}

test("无变化只推进检查游标，重复执行不再次调用模型或修改领域版本", async () => {
  const { session, task } = await setup();
  const before = await (await database()).get("sessions", session.id);
  const model = withModel(emptyStateResult);
  try {
    await runStateTask(task, new AbortController().signal, commit, changed);
    const db = await database();
    const after = await db.get("sessions", session.id);
    assert.equal(after!.stateProcessedThroughSeq, 2);
    assert.equal(after!.stateVersion, before!.stateVersion);
    assert.equal(after!.updatedAt, before!.updatedAt);
    assert.equal(await db.count("memories"), 0);
    assert.equal(await db.count("goals"), 0);
    assert.equal(await db.count("stateTasks"), 0);
    assert.equal((await db.get("operations", task.id))!.status, "committed");
    await runStateTask(task, new AbortController().signal, commit, changed);
    assert.equal(model.calls.length, 1);
  } finally {
    model.restore();
  }
});

test("剧情、记忆和目标同时提交，下一轮按会话隔离注入", async () => {
  const { character, session, task } = await setup();
  const model = withModel(updates);
  try {
    await runStateTask(task, new AbortController().signal, commit, changed);
    const db = await database();
    const current = (await db.get("sessions", session.id))!;
    const memories = await db.getAll("memories"),
      goals = await db.getAll("goals");
    assert.equal(current.story.location, "旅馆");
    assert.equal(current.story.characterState, "穿灰外套，神情平静，手腕受伤");
    assert.equal(current.story.userState, "穿校服，自述紧张");
    assert.equal(current.stateVersion, 1);
    assert.equal(memories[0].version, 1);
    assert.equal(goals[0].value.currentFocus, "询问掌柜");
    const nextContext = stateSnapshot(character, current, memories, goals);
    assert.equal(
      nextContext.goals[0].value.progressSummary,
      "为了寻找哥哥来到旅馆，得知登记册可能留下了相关信息。",
    );
    assert.equal(
      nextContext.story.characterState,
      current.story.characterState,
    );
    const other = await createSession(character.id);
    assert.deepEqual(
      stateSnapshot(character, other, memories, []).memories,
      [],
    );
    const projected = projectMessages(
      await allMessages(session.id),
      await db.getAll("operations"),
    );
    assert.equal(projected.length, 3);
    assert.equal((projected[2] as { kind: string }).kind, "state_update");
    const snapshot = await takeSnapshot();
    await restoreSnapshot(snapshot);
    assert.deepEqual((await takeSnapshot()).data, snapshot.data);
    const invalid = structuredClone(snapshot);
    invalid.data.operations[0].result = {
      ...(invalid.data.operations[0].result as StateResult),
      throughSeq: 0,
    };
    assert.throws(() => validateBackup(invalid), /序号|版本|范围/);
  } finally {
    model.restore();
  }
});

test("登记任务失败会回滚正文终态，避免完整正文遗漏整理", async () => {
  const { task, assistant } = await setup();
  const db = await database();
  await db.delete("stateTasks", task.id);
  await db.delete("operations", task.id);
  await db.put("messages", { ...assistant, status: "streaming" });
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "stateTasks")
      throw new DOMException("任务存储不足", "QuotaExceededError");
    return put.apply(this, args);
  };
  try {
    await assert.rejects(
      saveCompletedStateTask(task.context, assistant),
      /任务存储不足/,
    );
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  assert.equal((await db.get("messages", assistant.id))!.status, "streaming");
  assert.equal(await db.count("stateTasks"), 0);
});

test("保存中途失败全部回滚，重试只保存已计算结果", async () => {
  const { session, task } = await setup();
  const model = withModel(updates);
  const put = IDBObjectStore.prototype.put;
  let failing = true;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "goals" && failing)
      throw new DOMException("目标保存失败", "QuotaExceededError");
    return put.apply(this, args);
  };
  try {
    await assert.rejects(
      runStateTask(task, new AbortController().signal, commit, changed),
      /目标保存失败/,
    );
    const db = await database();
    assert.equal(await db.count("memories"), 0);
    assert.equal(await db.count("goals"), 0);
    assert.equal(
      (await db.get("sessions", session.id))!.stateProcessedThroughSeq,
      0,
    );
    assert.equal((await db.get("operations", task.id))!.status, "computed");
    failing = false;
    await runStateTask(
      (await db.get("stateTasks", task.id))!,
      new AbortController().signal,
      commit,
      changed,
    );
    assert.equal(model.calls.length, 1);
    assert.equal(await db.count("memories"), 1);
    assert.equal((await db.get("operations", task.id))!.status, "committed");
  } finally {
    IDBObjectStore.prototype.put = put;
    model.restore();
  }
});

test("自动调用两次失败后停止，人工重试已有任务可以恢复", async () => {
  const { task } = await setup();
  let fail = true;
  const model = withModel((body) => {
    if (fail) throw new Error("模型暂不可用");
    return emptyStateResult(body);
  });
  try {
    const db = await database();
    const run = () =>
      db
        .get("stateTasks", task.id)
        .then((t) =>
          runStateTask(t!, new AbortController().signal, commit, changed),
        );
    await assert.rejects(run(), /模型暂不可用/);
    await assert.rejects(run(), /模型暂不可用/);
    await assert.rejects(run(), /自动整理已尝试两次/);
    assert.equal(model.calls.length, 2);
    assert.equal(
      (await allMessages(task.sessionId)).at(-1)!.status,
      "complete",
    );
    fail = false;
    await runStateTask(
      (await db.get("stateTasks", task.id))!,
      new AbortController().signal,
      commit,
      changed,
      true,
    );
    assert.equal(await db.count("stateTasks"), 0);
    assert.equal(model.calls.length, 3);
  } finally {
    model.restore();
  }
});

test("人工编辑期间返回的旧结果不覆盖编辑，而是读取新版本重算", async () => {
  const { character, session, task } = await setup();
  const saved = await putMemory(character.id, session.id, memory);
  let calls = 0;
  const model = withModel(async (body) => {
    if (++calls === 1) {
      await putMemory(
        character.id,
        session.id,
        { ...memory, content: "人工改为小远" },
        saved,
      );
      const r = emptyStateResult(body);
      r.memoryChanges = [
        {
          action: "update",
          id: saved.id,
          expectedVersion: 1,
          before: memory,
          value: { ...memory, content: "旧模型结果" },
          reason: "旧判断",
          sourceMessageIds: [body.messages.at(-1)!.id],
        },
      ];
      return r;
    }
    assert.equal(body.context.state.memories[0].value.content, "人工改为小远");
    return emptyStateResult(body);
  });
  try {
    await runStateTask(task, new AbortController().signal, commit, changed);
    const db = await database();
    assert.equal(
      (await db.get("memories", saved.id))!.value.content,
      "人工改为小远",
    );
    assert.equal(model.calls.length, 2);
    assert.equal((await db.get("operations", task.id))!.status, "committed");
  } finally {
    model.restore();
  }
});

test("取消后迟到结果不提交，刷新保留可恢复任务", async () => {
  const { task, session } = await setup();
  const controller = new AbortController();
  const model = withModel((body) => {
    controller.abort();
    return updates(body);
  });
  try {
    await assert.rejects(
      runStateTask(task, controller.signal, commit, changed),
    );
    const db = await database();
    assert.equal(await db.count("memories"), 0);
    assert.equal(
      (await db.get("sessions", session.id))!.stateProcessedThroughSeq,
      0,
    );
    assert.equal((await db.get("operations", task.id))!.status, "cancelled");
    assert.equal(await db.count("stateTasks"), 1);
    const backup = await takeSnapshot();
    await restoreSnapshot(backup);
    assert.equal(await db.count("stateTasks"), 1);
  } finally {
    model.restore();
  }
});

test("待检查区间排除未完成正文，保留对应用户的明确信息", async () => {
  const { character, session } = await setup();
  const db = await database();
  const old = (await allMessages(session.id)).at(-1)!;
  await db.delete("stateTasks", `state:${old.id}`);
  await db.delete("operations", `state:${old.id}`);
  await db.put("messages", { ...old, status: "cancelled" });
  const next = await beginTurn(session.id, "继续");
  const complete = {
    ...next.assistant,
    status: "complete" as const,
    finishReason: "stop",
    segments: [{ kind: "dialogue" as const, text: "好的" }],
    checkpointVersion: 1,
  };
  const context = chatContext(
    character,
    session,
    [],
    [],
    "继续",
    DEFAULT_INTERACTION_SETTINGS,
  );
  const task = await saveCompletedStateTask(context, complete);
  const model = withModel(emptyStateResult);
  try {
    await runStateTask(task, new AbortController().signal, commit, changed);
    assert.deepEqual(
      model.calls[0].messages.map((m) => m.seq),
      [1, 3, 4],
    );
    assert.equal(
      (await db.get("sessions", session.id))!.stateProcessedThroughSeq,
      4,
    );
  } finally {
    model.restore();
  }
});

test("刷新将执行中的操作终止，已完成正文和待办保持完整", async () => {
  const { task } = await setup();
  const db = await database();
  const op = (await db.get("operations", task.id))!;
  await db.put("operations", { ...op, status: "running" });
  await recoverInterrupted();
  assert.equal((await db.get("operations", task.id))!.status, "cancelled");
  assert.equal((await allMessages(task.sessionId)).at(-1)!.status, "complete");
  const model = withModel(emptyStateResult);
  try {
    await runStateTask(task, new AbortController().signal, commit, changed);
    assert.equal((await db.get("operations", task.id))!.status, "committed");
  } finally {
    model.restore();
  }
});

test("保存重试前来源版本改变时，废弃缓存结果并重新调用模型", async () => {
  const { task, assistant } = await setup();
  let fail = true;
  const model = withModel(emptyStateResult);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "sessions" && fail)
      throw new DOMException("提交失败", "QuotaExceededError");
    return put.apply(this, args);
  };
  try {
    await assert.rejects(
      runStateTask(task, new AbortController().signal, commit, changed),
      /提交失败/,
    );
    fail = false;
    await checkpoint({
      ...assistant,
      segments: [{ kind: "narration", text: "正文已经修订。" }],
      checkpointVersion: 2,
    });
    await runStateTask(task, new AbortController().signal, commit, changed);
    assert.equal(model.calls.length, 2);
    assert.equal(model.calls[1].messages.at(-1)!.text, "正文已经修订。");
    assert.equal(
      (await (await database()).get("operations", task.id))!.status,
      "committed",
    );
  } finally {
    IDBObjectStore.prototype.put = put;
    model.restore();
  }
});

test("编辑旧角色对象时保留最新共享记忆版本", async () => {
  const { character, session } = await setup();
  await putMemory(character.id, session.id, { ...memory, scope: "character" });
  const edited = await saveCharacter(
    { name: "林溪", identity: "更新的身份", description: "老板" },
    character,
  );
  assert.equal(edited.memoryVersion, 1);
});

test("整轮发送登记任务失败时不会单独补写完整正文终态", async () => {
  const { sendMessage, useAppStore } = await import("../stores/use-app-store");
  const character = await saveCharacter({
    name: "林溪",
    identity: "",
    description: "",
  });
  const session = await createSession(character.id);
  useAppStore.setState({
    ready: true,
    readOnly: false,
    busy: false,
    activeSessionId: null,
    characterId: character.id,
    sessionId: session.id,
    messages: [],
    operations: [],
    goals: [],
    interactionSettings: { ...DEFAULT_INTERACTION_SETTINGS },
  });
  const fetch = globalThis.fetch;
  const put = IDBObjectStore.prototype.put;
  globalThis.fetch = async () =>
    new Response(
      'event: delta\ndata: {"kind":"dialogue","text":"已收到。"}\n\nevent: done\ndata: {"finishReason":"stop","usage":{"status":"reported","inputTokens":100,"outputTokens":20,"totalTokens":120}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "stateTasks")
      throw new DOMException("任务登记失败", "QuotaExceededError");
    return put.apply(this, args);
  };
  try {
    await sendMessage("你好");
    const db = await database();
    assert.equal((await allMessages(session.id)).at(-1)!.status, "error");
    assert.equal(await db.count("stateTasks"), 0);
    assert.equal(await db.count("operations"), 0);
  } finally {
    globalThis.fetch = fetch;
    IDBObjectStore.prototype.put = put;
  }
});
