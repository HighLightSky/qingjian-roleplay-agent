import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "idb";
import { database, saveCharacter } from "../lib/db";

test("仅旧结构升级时清空数据，新结构再次打开保留角色", async () => {
  const old = await openDB("roleplay-agent", 2, {
    upgrade(db) {
      db.createObjectStore("characters", { keyPath: "id" });
      db.createObjectStore("visualTasks", { keyPath: "id" });
    },
  });
  await old.put("characters", { id: "old", name: "旧角色" });
  old.close();
  const current = await database();
  assert.equal(current.version, 7);
  assert.equal(await current.count("characters"), 0);
  assert.equal(
    current.objectStoreNames.contains("visualTasks" as never),
    false,
  );
  const character = await saveCharacter({
    name: "新角色",
    identity: "",
    description: "",
  });
  const reopened = await openDB("roleplay-agent", 7);
  assert.equal((await reopened.get("characters", character.id)).name, "新角色");
  reopened.close();
});
