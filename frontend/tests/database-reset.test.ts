import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB, deleteDB } from "idb";
import { database, TABLES } from "../lib/db";
import { IMAGE_SEQUENCE_KEY } from "../lib/images/ids";

const stamp = "2026-10-20T00:00:00.000Z";
test("旧于 v8 阻止升级；v8 升级失败回滚，重试完整保留原件、版本和冻结任务", async () => {
  const unsupported = await openDB("roleplay-agent", 7, {
    upgrade(db) {
      db.createObjectStore("characters", { keyPath: "id" });
    },
  });
  await unsupported.put("characters", { id: "old", name: "旧角色" });
  unsupported.close();
  await assert.rejects(database(), /原数据已保留/);
  const preserved = await openDB("roleplay-agent", 7);
  assert.equal((await preserved.get("characters", "old")).name, "旧角色");
  preserved.close();
  await deleteDB("roleplay-agent");
  const legacyTables = TABLES.filter(
    (t) => !["sceneImagePlans", "sceneGenerations"].includes(t),
  );
  const old = await openDB("roleplay-agent", 8, {
    upgrade(db) {
      for (const table of legacyTables) {
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
            "visualObservations",
            "imageUsages",
            "stateTasks",
            "compactionTasks",
            "operations",
            "goals",
          ].includes(table)
        )
          store.createIndex("session", "sessionId");
        if (table === "sessions" || table === "memories")
          store.createIndex("character", "characterId");
        if (table === "assets")
          store.createIndex("sha256", "sha256", { unique: true });
        if (table === "messages") {
          store.createIndex("sequence", ["sessionId", "seq"], { unique: true });
          store.createIndex("status", "status");
        }
      }
    },
  });
  const originalBlob = new Blob(["原图字节保持不变"]);
  const state = {
    sessionId: "s",
    characterId: "c",
    sessionVersion: 7,
    memoryVersion: 3,
    story: {},
    storySources: {},
    memories: [],
    goals: [],
  };
  const context = {
    state,
    character: { appearancePhotoAssetId: "img1" },
    input: { text: "旧正文" },
  };
  const fixtures: Record<string, object[]> = {
    characters: [
      {
        id: "c",
        name: "林溪",
        profileVersion: 3,
        memoryVersion: 3,
        appearancePhotoAssetId: "img1",
      },
    ],
    sessions: [
      {
        id: "s",
        characterId: "c",
        characterSnapshot: { name: "旧快照", appearancePhotoAssetId: "img1" },
        stateVersion: 7,
        nextMessageSeq: 9,
        summary: { throughSeq: 4 },
        story: {},
        storySources: {},
      },
    ],
    messages: [
      {
        id: "a",
        sessionId: "s",
        seq: 8,
        status: "streaming",
        segments: [{ kind: "dialogue", text: "保留正文" }],
        checkpointVersion: 6,
      },
    ],
    assets: [
      {
        id: "img1",
        sha256: "a".repeat(64),
        originalBlob,
        thumbnailBlob: new Blob(["缩略图"]),
        createdAt: stamp,
      },
    ],
    visualObservations: [
      {
        id: "s:img1",
        sessionId: "s",
        assetId: "img1",
        version: 4,
        summary: "原观察",
      },
    ],
    imageUsages: [
      { id: "usage", sessionId: "s", assetId: "img1", messageId: "a" },
    ],
    memories: [{ id: "memory", characterId: "c", version: 3 }],
    goals: [{ id: "goal", sessionId: "s", version: 2 }],
    stateTasks: [{ id: "state:a", sessionId: "s", context }],
    compactionTasks: [{ id: "compact", sessionId: "s", context }],
    operations: [
      {
        id: "state:a",
        sessionId: "s",
        kind: "state_update",
        status: "computed",
        result: {
          storyChanges: [],
          memoryChanges: [],
          goalChanges: [],
          visualObservations: [],
        },
      },
    ],
    drafts: [
      {
        sessionId: "s",
        text: "未发草稿",
        edit: {
          userMessageId: "u",
          parts: [{ type: "image", assetId: "img1" }],
        },
      },
    ],
    settings: [
      { key: IMAGE_SEQUENCE_KEY, value: "9" },
      { key: "themeMode", value: "dark" },
      { key: "dispatch:old", value: "{}" },
    ],
  };
  for (const [table, records] of Object.entries(fixtures))
    for (const row of records) await old.put(table, row);
  old.close();
  const update = IDBCursor.prototype.update;
  IDBCursor.prototype.update = function () {
    throw new Error("注入升级失败");
  };
  await assert.rejects(database(), /注入升级失败/);
  IDBCursor.prototype.update = update;
  const rollback = await openDB("roleplay-agent", 8);
  assert.equal(
    (await rollback.get("assets", "img1")).creationOrigin,
    undefined,
  );
  assert.equal(await rollback.count("characters"), 1);
  rollback.close();
  const current = await database();
  assert.equal(current.version, 11);
  for (const table of legacyTables.filter((t) => t !== "settings"))
    assert.equal(await current.count(table), fixtures[table].length, table);
  assert.equal((await current.get("settings", IMAGE_SEQUENCE_KEY))!.value, "9");
  assert.equal(await current.get("settings", "dispatch:old"), undefined);
  const asset = (await current.get("assets", "img1"))!;
  assert.equal(asset.creationOrigin, "uploaded");
  assert.equal(await asset.originalBlob.text(), await originalBlob.text());
  assert.equal((await current.get("visualObservations", "s:img1"))!.version, 4);
  assert.equal((await current.get("sessions", "s"))!.stateVersion, 7);
  assert.equal(
    (await current.get("sessions", "s"))!.characterSnapshot.name,
    "旧快照",
  );
  assert.deepEqual(
    (await current.get("stateTasks", "state:a"))!.context.state.visualState,
    { outfit: "", hairstyle: "", accessories: [], appearanceChanges: [] },
  );
  assert.deepEqual((await current.get("operations", "state:a"))!.result, {
    storyChanges: [],
    memoryChanges: [],
    goalChanges: [],
    visualObservations: [],
    visualChanges: [],
    scenePlan: null,
  });
  assert.equal((await current.get("messages", "a"))!.status, "error");
  assert.equal(
    (await current.get("messages", "a"))!.segments![0].text,
    "保留正文",
  );
  const reopened = await openDB("roleplay-agent", 11);
  assert.equal(await reopened.count("characters"), 1);
  assert.equal(await reopened.count("sceneImagePlans"), 0);
  reopened.close();
});
