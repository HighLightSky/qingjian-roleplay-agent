import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "idb";
import { database } from "../lib/db";

test("v1 database upgrades without replacing text messages, drafts or settings", async () => {
  const legacy = await openDB("roleplay-agent", 1, {
    upgrade(db) {
      db.createObjectStore("characters", { keyPath: "id" });
      db.createObjectStore("sessions", { keyPath: "id" }).createIndex(
        "character",
        "characterId",
      );
      const messages = db.createObjectStore("messages", { keyPath: "id" });
      messages.createIndex("sequence", ["sessionId", "seq"], { unique: true });
      messages.createIndex("status", "status");
      db.createObjectStore("memories", { keyPath: "id" }).createIndex(
        "character",
        "characterId",
      );
      db.createObjectStore("drafts", { keyPath: "sessionId" });
      db.createObjectStore("settings", { keyPath: "key" });
    },
  });
  const message = {
    id: "old-message",
    sessionId: "old-session",
    seq: 1,
    role: "user",
    text: "旧对话",
    status: "complete",
    checkpointVersion: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await legacy.put("messages", message);
  await legacy.put("drafts", {
    sessionId: "old-session",
    text: "旧草稿",
    updatedAt: new Date().toISOString(),
  });
  await legacy.put("settings", { key: "themeMode", value: "dark" });
  legacy.close();
  const db = await database();
  assert.equal(db.version, 2);
  assert.deepEqual(await db.get("messages", "old-message"), message);
  assert.equal((await db.get("drafts", "old-session"))?.text, "旧草稿");
  assert.equal((await db.get("settings", "themeMode"))?.value, "dark");
  assert.equal(await db.count("assets"), 0);
  assert.equal(await db.count("visualTasks"), 0);
});
