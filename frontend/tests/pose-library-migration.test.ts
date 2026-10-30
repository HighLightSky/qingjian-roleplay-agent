import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "idb";
import { database, TABLES } from "../lib/db";

test("v13 升级为旧草稿和 computed 计划补默认库，保留候选与编辑并支持失败回滚", async () => {
  const old = await openDB("roleplay-agent", 13, {
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
    id: "p",
    draft: {
      poseQuery: "坐姿",
      poseSearch: {
        revision: 7,
        selectedPoseId: "sit",
        matches: [{ poseId: "sit", pose: { bones: {} } }],
      },
      poseEdit: {
        sourcePoseId: "sit",
        searchRevision: 7,
        runtimeRevision: "test",
        scene: { bones: { edited: true } },
      },
    },
  };
  await old.put("sceneImagePlans", plan);
  await old.put("operations", {
    id: "computed",
    kind: "state_update",
    status: "computed",
    result: { scenePlan: plan },
  });
  old.close();
  const update = IDBCursor.prototype.update;
  IDBCursor.prototype.update = function (row) {
    if (row.id === "p" && row.draft.poseLibrary === "default")
      throw new Error("注入检索范围迁移失败");
    return update.call(this, row);
  };
  try {
    await assert.rejects(database(), /注入检索范围迁移失败/);
  } finally {
    IDBCursor.prototype.update = update;
  }
  const preserved = await openDB("roleplay-agent", 13);
  assert.deepEqual(await preserved.get("sceneImagePlans", "p"), plan);
  preserved.close();
  const db = await database();
  assert.equal(db.version, 14);
  const expected = {
    ...plan,
    draft: { ...plan.draft, poseLibrary: "default" },
  };
  assert.deepEqual(await db.get("sceneImagePlans", "p"), expected);
  const computed = (await db.get("operations", "computed"))!;
  assert.equal(computed.status, "computed");
  assert.deepEqual(
    (computed.result as { scenePlan: unknown }).scenePlan,
    expected,
  );
});
