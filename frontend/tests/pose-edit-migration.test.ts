import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "idb";
import { database, TABLES } from "../lib/db";

test("v12 升级保留候选、选择、computed 草稿和历史提交，只初始化独立编辑", async () => {
  const old = await openDB("roleplay-agent", 12, {
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
  const poseSearch = {
    status: "succeeded",
    query: "坐姿",
    revision: 7,
    matches: [{ poseId: "sit", pose: { schema_version: 3 } }],
    selectedPoseId: "sit",
    error: null,
  };
  const plan = {
    id: "p",
    poseQuery: "坐姿",
    draft: { prompt: "用户文本", poseEnabled: true, poseSearch },
  };
  await old.put("sceneImagePlans", plan);
  await old.put("operations", {
    id: "computed",
    kind: "state_update",
    status: "computed",
    result: { scenePlan: plan },
  });
  const submission = {
    poseEnabled: true,
    poseSelection: { pose: { original: true } },
    effectivePrompt: "历史发送文本",
  };
  await old.put("sceneGenerations", { id: "g", submission });
  old.close();
  const update = IDBCursor.prototype.update;
  IDBCursor.prototype.update = function (row) {
    if (row.id === "p" && row.draft.poseEdit === null)
      throw new Error("注入编辑迁移失败");
    return update.call(this, row);
  };
  try {
    await assert.rejects(database(), /注入编辑迁移失败/);
  } finally {
    IDBCursor.prototype.update = update;
  }
  const preserved = await openDB("roleplay-agent", 12);
  assert.deepEqual(await preserved.get("sceneImagePlans", "p"), plan);
  preserved.close();
  const db = await database();
  assert.equal(db.version, 14);
  const current = (await db.get("sceneImagePlans", "p"))!;
  assert.equal(current.draft!.poseEdit, null);
  assert.deepEqual(current.draft!.poseSearch, poseSearch);
  assert.deepEqual(
    (await db.get("sceneGenerations", "g"))!.submission,
    submission,
  );
  const computed = (await db.get("operations", "computed"))!;
  assert.equal(computed.status, "computed");
  assert.equal(
    (computed.result as { scenePlan: typeof current }).scenePlan.draft!
      .poseEdit,
    null,
  );
});
