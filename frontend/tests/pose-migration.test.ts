import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "idb";
import { database, TABLES } from "../lib/db";

test("v11 原地升级保留历史草稿、生成快照与 computed 内嵌计划，不猜测动作", async () => {
  const legacy = await openDB("roleplay-agent", 11, {
    upgrade(db) {
      for (const table of TABLES)
        db.createObjectStore(table, {
          keyPath:
            table === "settings"
              ? "key"
              : table === "drafts"
                ? "sessionId"
                : "id",
        });
    },
  });
  const plan = {
    id: "plan",
    prompt: "旧提示词包含坐姿",
    referenceImages: [],
    draft: {
      prompt: "用户改为站立",
      width: 512,
      height: 768,
      referenceAssetIds: [],
    },
  };
  await legacy.put("sceneImagePlans", plan);
  await legacy.put("sceneGenerations", {
    id: "generation",
    status: "succeeded",
    submission: {
      prompt: "旧用户文本",
      effectivePrompt: "实际发送的旧动作描述",
      width: 512,
      height: 768,
      referenceImages: [],
    },
  });
  await legacy.put("operations", {
    id: "computed",
    kind: "state_update",
    status: "computed",
    result: { scenePlan: plan, storyChanges: [] },
  });
  await legacy.put("assets", {
    id: "img1",
    originalBlob: new Blob(["原件完整保留"]),
  });
  legacy.close();
  const update = IDBCursor.prototype.update;
  IDBCursor.prototype.update = function (value) {
    if (value.id === "plan" && value.poseQuery === null)
      throw new Error("注入姿势迁移失败");
    return update.call(this, value);
  };
  try {
    await assert.rejects(database(), /注入姿势迁移失败/);
  } finally {
    IDBCursor.prototype.update = update;
  }
  const old = await openDB("roleplay-agent", 11);
  assert.deepEqual(await old.get("sceneImagePlans", "plan"), plan);
  old.close();
  const db = await database();
  assert.equal(db.version, 14);
  const current = (await db.get("sceneImagePlans", "plan"))!;
  assert.equal(current.poseQuery, null);
  assert.equal(current.draft!.poseEnabled, false);
  assert.equal(current.draft!.prompt, "用户改为站立");
  assert.equal(current.draft!.poseSearch.matches.length, 0);
  const generation = (await db.get("sceneGenerations", "generation"))!;
  assert.equal(generation.submission.poseSelection, null);
  assert.equal(generation.submission.effectivePrompt, "实际发送的旧动作描述");
  const operation = (await db.get("operations", "computed"))!;
  assert.equal(operation.status, "computed");
  assert.equal(
    (operation.result as { scenePlan: typeof current }).scenePlan.poseQuery,
    null,
  );
  assert.equal(
    await (await db.get("assets", "img1"))!.originalBlob.text(),
    "原件完整保留",
  );
});
