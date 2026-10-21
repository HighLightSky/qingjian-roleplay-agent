import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "idb";
import { database, TABLES } from "../lib/db";
import { EMPTY_STORY } from "../lib/state/types";

test("v4升级保留原文、图片和待办，冻结的较早原文还原为结构化历史，失败整体回滚", async () => {
  const old = await openDB("roleplay-agent", 4, {
    upgrade(db) {
      for (const name of TABLES.filter((name) => name !== "compactionTasks")) {
        const store = db.createObjectStore(name, {
          keyPath:
            name === "settings"
              ? "key"
              : name === "drafts"
                ? "sessionId"
                : "id",
        });
        if (name === "messages") {
          store.createIndex("sequence", ["sessionId", "seq"], { unique: true });
          store.createIndex("status", "status");
        }
      }
    },
  });
  await old.put("sessions", {
    id: "session",
    profileVersion: 1,
    story: EMPTY_STORY,
    stateVersion: 3,
  });
  for (let seq = 1; seq <= 26; seq++)
    await old.put("messages", {
      id: `message-${seq}`,
      sessionId: "session",
      seq,
      role: seq % 2 ? "user" : "assistant",
      status: "complete",
      checkpointVersion: seq,
      ...(seq % 2
        ? { text: `问题${seq}` }
        : {
            segments: [{ kind: "dialogue", text: `回复${seq}` }],
            replyToMessageId: `message-${seq - 1}`,
          }),
    });
  await old.put("assets", {
    id: "asset",
    originalBlob: new Blob(["original-image"]),
    sha256: "original-hash",
  });
  await old.put("stateTasks", {
    id: "state:message-26",
    sessionId: "session",
    assistantMessageId: "message-26",
    automaticAttempts: 1,
    context: {
      character: { name: "林溪", identity: "", description: "" },
      earlierHistory: "问题1和回复2等较早原文",
      history: [],
      input: { text: "问题25" },
      state: { story: EMPTY_STORY, sessionVersion: 3 },
    },
  });
  old.close();
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "sessions" && args[0]?.summary)
      throw new Error("摘要迁移失败");
    return put.apply(this, args);
  };
  try {
    await assert.rejects(database(), /摘要迁移失败/);
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  const rolledBack = await openDB("roleplay-agent", 4);
  assert.equal(
    (await rolledBack.get("sessions", "session")).summary,
    undefined,
  );
  assert.equal(
    (await rolledBack.get("stateTasks", "state:message-26")).context
      .earlierHistory,
    "问题1和回复2等较早原文",
  );
  assert.equal(rolledBack.objectStoreNames.contains("compactionTasks"), false);
  rolledBack.close();
  const upgraded = await database();
  assert.equal(upgraded.version, 6);
  assert.equal(await upgraded.count("messages"), 26);
  const session = (await upgraded.get("sessions", "session"))!;
  assert.deepEqual(session.summary, { text: "", throughSeq: 0, version: 0 });
  assert.equal(session.stateVersion, 3);
  const task = (await upgraded.get("stateTasks", "state:message-26"))!;
  assert.equal(task.automaticAttempts, 1);
  assert.equal("earlierHistory" in task.context, false);
  assert.equal(task.context.history.length, 24);
  assert.deepEqual(
    task.context.history.map((m) => m.seq),
    Array.from({ length: 24 }, (_, i) => i + 1),
  );
  assert.equal(task.context.history[1].text, "[台词]回复2");
  assert.equal(task.context.history[1].checkpointVersion, 2);
  assert.equal(
    (await upgraded.get("messages", "message-2"))!.usage!.status,
    "unavailable",
  );
  const asset = (await upgraded.get("assets", "asset"))!;
  assert.equal(await asset.originalBlob.text(), "original-image");
  assert.equal(await upgraded.count("compactionTasks"), 0);
});
