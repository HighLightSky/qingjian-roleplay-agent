import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "idb";
import { database, TABLES } from "../lib/db";

test("v10 原地升级失败回滚，成功移除用途分类并保留草稿、快照和原件", async () => {
  const legacy = await openDB("roleplay-agent", 10, {
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
  const reference = {
    assetId: "img8",
    roles: ["environment"],
    scope: "室内环境",
    sourceSha256: "a".repeat(64),
    sourceGenerationId: null,
  };
  const draft = {
    prompt: "用户编辑的<image3>场景。",
    width: 256,
    height: 512,
    referenceAssetIds: ["img8"],
  };
  await legacy.put("assets", {
    id: "img8",
    sha256: "a".repeat(64),
    originalBlob: new Blob(["完整原件"]),
  });
  await legacy.put("sceneImagePlans", {
    id: "plan",
    sessionId: "s",
    referenceImages: [reference],
    prompt: "原模型文本",
    draft,
  });
  await legacy.put("sceneGenerations", {
    id: "g",
    status: "succeeded",
    submission: {
      prompt: "真实提交",
      effectivePrompt: "追加说明后的真实提交",
      width: 256,
      height: 512,
      referenceImages: [{ ...reference, sha256: "b".repeat(64) }],
    },
  });
  await legacy.put("operations", {
    id: "state:a",
    kind: "state_update",
    status: "computed",
    result: { storyChanges: [] },
  });
  await legacy.put("settings", { key: "dispatch:old", value: "旧句柄" });
  legacy.close();
  const update = IDBCursor.prototype.update;
  IDBCursor.prototype.update = function (value) {
    if (value.id === "plan" && !value.referenceImages[0].roles)
      throw new Error("注入用途迁移失败");
    return update.call(this, value);
  };
  try {
    await assert.rejects(database(), /注入用途迁移失败/);
  } finally {
    IDBCursor.prototype.update = update;
  }
  const preserved = await openDB("roleplay-agent", 10);
  assert.deepEqual(
    (await preserved.get("sceneImagePlans", "plan")).referenceImages[0].roles,
    ["environment"],
  );
  preserved.close();
  const current = await database();
  assert.equal(current.version, 12);
  const plan = (await current.get("sceneImagePlans", "plan"))!;
  assert.equal("roles" in plan.referenceImages[0], false);
  assert.deepEqual(plan.draft, {
    ...draft,
    poseEnabled: false,
    poseQuery: "",
    characterReferenceAssetId: null,
    poseSearch: {
      status: "idle",
      query: null,
      revision: 0,
      matches: [],
      selectedPoseId: null,
      error: null,
    },
  });
  const submission = (await current.get("sceneGenerations", "g"))!.submission;
  assert.equal(submission.effectivePrompt, "追加说明后的真实提交");
  assert.equal("roles" in submission.referenceImages[0], false);
  assert.equal(
    await (await current.get("assets", "img8"))!.originalBlob.text(),
    "完整原件",
  );
  assert.equal(
    (
      (await current.get("operations", "state:a"))!
        .result as import("../lib/state/types").StateResult
    ).scenePlan,
    null,
  );
  assert.equal(await current.get("settings", "dispatch:old"), undefined);
});
