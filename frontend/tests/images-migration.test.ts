import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "idb";
import { database, TABLES } from "../lib/db";
import { EMPTY_STORY } from "../lib/state/types";

test("v5视觉来源在同一升级事务中转换，保留原件、观察版本和冻结快照，失败回滚", async () => {
  const old = await openDB("roleplay-agent", 5, {
    upgrade(db) {
      for (const name of TABLES) {
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
        } else if (name === "assets")
          store.createIndex("sha256", "sha256", { unique: true });
        else if (name === "sessions" || name === "memories")
          store.createIndex("character", "characterId");
        else if (
          [
            "stateTasks",
            "compactionTasks",
            "operations",
            "imageUsages",
            "visualObservations",
            "goals",
          ].includes(name)
        )
          store.createIndex("session", "sessionId");
      }
    },
  });
  const profile = { name: "林溪", identity: "旧友", description: "银发" };
  const timestamp = "2026-10-21T00:00:00Z";
  const source = {
    messageId: "upload",
    seq: 1,
    text: "参考图",
    imageIndex: 1,
    uploadIndex: 1,
  };
  const observation = {
    assetId: "image",
    summary: "黑发红斗篷",
    visibleDetails: [],
    extractedText: [],
    uncertainDetails: ["耳环模糊"],
    sourceMessageIds: ["upload"],
    version: 3,
  };
  const catalog = [{ assetId: "image", sources: [source], observation }];
  const context = {
    character: profile,
    input: { text: "" },
    history: [],
    summary: { text: "", throughSeq: 0, version: 0 },
    visual: {
      sessionId: "session",
      assetCatalog: catalog,
      plan: null,
      imagePayloads: [],
    },
  };
  await old.put("characters", {
    id: "character",
    ...profile,
    profileVersion: 7,
  });
  await old.put("sessions", {
    id: "session",
    characterId: "character",
    characterSnapshot: profile,
    profileVersion: 7,
    story: EMPTY_STORY,
    summary: { text: "", throughSeq: 0, version: 0 },
  });
  await old.put("messages", {
    id: "upload",
    sessionId: "session",
    seq: 1,
    role: "user",
    text: "参考图",
    parts: [
      { type: "text", text: "参考图" },
      { type: "image", assetId: "image" },
    ],
  });
  await old.put("assets", {
    id: "image",
    sha256: "hash",
    originalBlob: new Blob(["原件"]),
    createdAt: timestamp,
  });
  await old.put("visualObservations", {
    ...observation,
    id: "session:image",
    sessionId: "session",
  });
  for (const table of ["stateTasks", "compactionTasks"])
    await old.put(table, { id: table, sessionId: "session", context });
  await old.put("operations", {
    id: "select",
    sessionId: "session",
    kind: "selection",
    result: {
      catalog,
      plan: { selectedHistoricalImages: [], candidateAssetIds: [] },
    },
  });
  await old.put("operations", {
    id: "state",
    sessionId: "session",
    kind: "state_update",
    result: { visualObservations: [observation] },
  });
  old.close();

  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "operations") throw new Error("视觉来源迁移写入失败");
    return put.apply(this, args);
  };
  try {
    await assert.rejects(database(), /视觉来源迁移写入失败/);
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  const rolledBack = await openDB("roleplay-agent", 5);
  assert.deepEqual(
    (await rolledBack.get("visualObservations", "session:image"))
      .sourceMessageIds,
    ["upload"],
  );
  assert.equal(
    (await rolledBack.get("stateTasks", "stateTasks")).context.character
      .profileVersion,
    undefined,
  );
  rolledBack.close();

  const upgraded = await database();
  const expected = [{ type: "message", ...source }];
  const current = (await upgraded.get("visualObservations", "session:img1"))!;
  assert.equal(current.version, 3);
  assert.deepEqual(current.sources, expected);
  assert.equal("sourceMessageIds" in current, false);
  for (const table of ["stateTasks", "compactionTasks"] as const) {
    const task = (await upgraded.get(table, table))!;
    assert.equal(task.context.character.profileVersion, 7);
    assert.deepEqual(task.context.visual!.assetCatalog[0].sources, expected);
    assert.deepEqual(
      task.context.visual!.assetCatalog[0].observation!.sources,
      expected,
    );
  }
  const selection = (await upgraded.get("operations", "select"))!.result!;
  assert.ok("catalog" in selection);
  assert.deepEqual(selection.catalog[0].sources, expected);
  const state = (await upgraded.get("operations", "state"))!.result!;
  assert.ok("visualObservations" in state);
  assert.deepEqual(state.visualObservations[0].sources, expected);
  assert.equal(
    await (await upgraded.get("assets", "img1"))!.originalBlob.text(),
    "原件",
  );
});
