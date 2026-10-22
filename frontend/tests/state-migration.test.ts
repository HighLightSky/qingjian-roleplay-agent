import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "idb";
import { database, TABLES } from "../lib/db";
import { validateGoalValue, validateStory } from "../lib/state/validation";

test("v3 升级事务一次性转换目标、剧情、待办和缓存结果，失败回滚且不丢失原文", async () => {
  const old = await openDB("roleplay-agent", 3, {
    upgrade(db) {
      for (const name of TABLES.filter((name) => name !== "compactionTasks"))
        db.createObjectStore(name, {
          keyPath:
            name === "settings"
              ? "key"
              : name === "drafts"
                ? "sessionId"
                : "id",
        });
    },
  });
  const value = {
    description: "寻找哥哥",
    status: "active",
    currentFocus: "查登记册",
    clues: ["哥哥曾住过旅馆"],
    milestones: [{ description: "到达旅馆", status: "completed" }],
    blockers: ["登记册上锁"],
  };
  const story = {
    location: "旅馆",
    storyTime: "傍晚",
    presentCharacters: ["林溪"],
    relationships: [],
    items: ["上锁的登记册"],
    openThreads: [],
  };
  const entry = {
    id: "goal",
    sessionId: "session",
    value,
    version: 3,
    origin: "manual",
    sourceMessageIds: ["user"],
    createdAt: "2026-10-21T00:00:00Z",
    updatedAt: "2026-10-21T00:00:01Z",
  };
  const state = {
    sessionId: "session",
    characterId: "character",
    sessionVersion: 7,
    memoryVersion: 2,
    processedThroughSeq: 2,
    story,
    storySources: {},
    memories: [],
    goals: [entry],
  };
  await old.put("sessions", {
    id: "session",
    characterSnapshot: { name: "林溪", identity: "", description: "" },
    profileVersion: 1,
    story,
    storySources: {},
    stateVersion: 7,
  });
  await old.put("characters", { id: "character", name: "林溪" });
  await old.put("messages", {
    id: "user",
    sessionId: "session",
    seq: 1,
    role: "user",
    status: "complete",
    checkpointVersion: 0,
    text: "我们来到旅馆找哥哥",
  });
  await old.put("messages", {
    id: "assistant",
    sessionId: "session",
    seq: 2,
    role: "assistant",
    status: "complete",
    checkpointVersion: 1,
    replyToMessageId: "user",
    segments: [{ kind: "narration", text: "她走入旅馆。" }],
  });
  await old.put("goals", entry);
  await old.put("stateTasks", {
    id: "task",
    sessionId: "session",
    assistantMessageId: "assistant",
    context: {
      character: { name: "林溪", identity: "", description: "" },
      state,
      earlierHistory: "",
      history: [],
      input: { text: "我们来到旅馆找哥哥" },
    },
    automaticAttempts: 1,
  });
  await old.put("operations", {
    id: "task",
    kind: "state_update",
    status: "computed",
    result: {
      visualObservations: [],
      goalChanges: [
        {
          id: "goal",
          before: value,
          value: { ...value, currentFocus: "问掌柜借钥匙" },
        },
      ],
    },
  });
  old.close();

  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "goals") throw new Error("目标迁移写入失败");
    return put.apply(this, args);
  };
  try {
    await assert.rejects(database(), /目标迁移写入失败/);
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  const rolledBack = await openDB("roleplay-agent", 3);
  assert.deepEqual((await rolledBack.get("sessions", "session")).story, story);
  assert.deepEqual((await rolledBack.get("goals", "goal")).value, value);
  rolledBack.close();

  const upgraded = await database();
  assert.equal(upgraded.version, 7);
  const migratedGoal = (await upgraded.get("goals", "goal"))!;
  validateGoalValue(migratedGoal.value);
  assert.deepEqual(Object.keys(migratedGoal.value).sort(), [
    "currentFocus",
    "description",
    "progressSummary",
    "status",
  ]);
  assert.equal(migratedGoal.version, 3);
  assert.deepEqual(migratedGoal.sourceMessageIds, ["user"]);
  assert.equal(
    migratedGoal.value.progressSummary,
    "哥哥曾住过旅馆；到达旅馆（已完成）；尚待解决：登记册上锁",
  );
  const migratedSession = (await upgraded.get("sessions", "session"))!;
  validateStory(migratedSession.story);
  assert.deepEqual(migratedSession.story, {
    ...story,
    characterState: "",
    userState: "",
  });
  assert.equal(migratedSession.stateVersion, 7);
  const task = (await upgraded.get("stateTasks", "task"))!;
  assert.deepEqual(task.context.state.goals[0].value, migratedGoal.value);
  assert.deepEqual(task.context.state.story, migratedSession.story);
  assert.equal(task.automaticAttempts, 1);
  const operation = (await upgraded.get("operations", "task"))!;
  assert.equal(operation.status, "computed");
  assert.ok(operation.result && "goalChanges" in operation.result);
  assert.deepEqual(operation.result.goalChanges[0].before, migratedGoal.value);
  assert.equal(
    operation.result.goalChanges[0].value.currentFocus,
    "问掌柜借钥匙",
  );
  assert.equal(
    (await upgraded.get("messages", "user"))!.text,
    "我们来到旅馆找哥哥",
  );

  await upgraded.put("goals", {
    ...migratedGoal,
    value: { ...migratedGoal.value, progressSummary: "升级后继续推进的内容" },
  });
  const reopened = await openDB("roleplay-agent", 7);
  assert.equal(
    (await reopened.get("goals", "goal")).value.progressSummary,
    "升级后继续推进的内容",
  );
  reopened.close();
});

test("运行时拒绝旧目标与旧剧情结构", () => {
  assert.throws(
    () =>
      validateGoalValue({
        description: "目标",
        status: "active",
        currentFocus: "",
        clues: [],
        milestones: [],
        blockers: [],
      }),
    /文字字段缺失/,
  );
  assert.throws(
    () =>
      validateStory({
        location: "",
        storyTime: "",
        presentCharacters: [],
        relationships: [],
        items: [],
        openThreads: [],
      }),
    /文字字段缺失/,
  );
});
