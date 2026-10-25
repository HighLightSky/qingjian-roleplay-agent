import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "idb";
import { database, TABLES } from "../lib/db";

test("v9 到 v10 升级失败整体回滚；成功保留原件和生成记录并转换嵌套来源", async () => {
  const legacy = await openDB("roleplay-agent", 9, {
    upgrade(db) {
      for (const table of TABLES) {
        const store = db.createObjectStore(table, {
          keyPath:
            table === "settings"
              ? "key"
              : table === "drafts"
                ? "sessionId"
                : "id",
        });
        if (
          [
            "sceneImagePlans",
            "sceneGenerations",
            "sessions",
            "visualObservations",
            "stateTasks",
            "compactionTasks",
            "operations",
            "goals",
            "imageUsages",
          ].includes(table)
        )
          store.createIndex("session", "sessionId");
        if (["sceneImagePlans", "sceneGenerations"].includes(table))
          store.createIndex("message", "assistantMessageId");
        if (table === "assets")
          store.createIndex("sha256", "sha256", { unique: true });
      }
    },
  });
  const source = {
    type: "scene_generation",
    generationId: "g",
    planId: "p",
    messageId: "a",
    seq: 2,
    sceneId: "old-scene",
    target: { outfit: "白裙" },
    summary: "原生成要求",
    rejected: false,
  };
  await legacy.put("assets", {
    id: "img1",
    sha256: "a".repeat(64),
    width: 128,
    height: 256,
    originalBlob: new Blob(["原件"]),
  });
  await legacy.put("sceneImagePlans", {
    id: "p",
    sessionId: "s",
    assistantMessageId: "a",
    sourceSeq: 2,
    sourceCheckpointVersion: 1,
    profileVersion: 1,
    sceneId: "old-scene",
    previousPlanId: "",
    continuity: "new_scene",
    target: { outfit: "白裙" },
    summary: "旧摘要",
    fingerprint: "b".repeat(64),
    status: "ready",
    prompt: "实际绘图要求",
    error: null,
    referenceImages: [
      {
        assetId: "img1",
        roles: ["base", "identity"],
        scope: "人物",
        sourceSha256: "a".repeat(64),
        sourceGenerationId: null,
      },
    ],
  });
  await legacy.put("sceneGenerations", {
    id: "g",
    planId: "p",
    sessionId: "s",
    assistantMessageId: "a",
    sourceSeq: 2,
    sourceCheckpointVersion: 1,
    sceneId: "old-scene",
    status: "succeeded",
    assetId: "img1",
    referenceStatus: "eligible",
  });
  await legacy.put("sceneGenerations", {
    id: "running",
    planId: "p",
    sessionId: "s",
    status: "running",
  });
  await legacy.put("visualObservations", { id: "o", sources: [source] });
  await legacy.put("stateTasks", {
    id: "state",
    context: { visual: { assetCatalog: [{ sources: [source] }] } },
  });
  await legacy.put("settings", { key: "dispatch:old", value: "旧句柄" });
  legacy.close();
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    if (this.name === "sceneGenerations" && value.submission)
      throw new Error("注入迁移失败");
    return put.call(this, value, key);
  };
  try {
    await assert.rejects(database(), /注入迁移失败/);
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  const preserved = await openDB("roleplay-agent", 9);
  assert.equal(
    (await preserved.get("sceneImagePlans", "p")).target.outfit,
    "白裙",
  );
  assert.equal(
    (await preserved.get("sceneGenerations", "g")).submission,
    undefined,
  );
  assert.equal(
    (await preserved.get("assets", "img1")).originalBlob.size,
    new Blob(["原件"]).size,
  );
  preserved.close();
  const current = await database();
  assert.equal(current.version, 11);
  assert.equal(
    await (await current.get("assets", "img1"))!.originalBlob.text(),
    "原件",
  );
  const generation = (await current.get("sceneGenerations", "g"))!;
  assert.equal(generation.submission.effectivePrompt, "实际绘图要求");
  assert.equal(generation.submission.width, 128);
  assert.equal(generation.submission.height, 256);
  assert.equal("sceneId" in generation, false);
  assert.equal("target" in (await current.get("sceneImagePlans", "p"))!, false);
  assert.equal(
    (await current.get("sceneGenerations", "running"))!.status,
    "unknown",
  );
  assert.equal(
    (await current.get("sceneGenerations", "running"))!.submission.width,
    null,
  );
  const nested = (await current.get("stateTasks", "state"))!.context.visual!
    .assetCatalog[0].sources[0];
  assert.equal("target" in nested, false);
  assert.equal("sceneId" in nested, false);
  assert.equal(await current.get("settings", "dispatch:old"), undefined);
});
