import { test, expect } from "@playwright/test";
import { TABLES } from "../../lib/db";
import { legacyImageSnapshot, oldPhoto } from "../image-id-migration-fixture";

test("真实浏览器升级v6图片数据库并恢复已计算整理结果，刷新不重复迁移", async ({
  page,
}) => {
  await page.route("**/__image-migration-seed", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>迁移夹具</title>",
    }),
  );
  await page.goto("/__image-migration-seed");
  await page.evaluate(
    async ({ tables, snapshot }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("roleplay-agent", 6);
        request.onupgradeneeded = () => {
          for (const table of tables) {
            const store = request.result.createObjectStore(table, {
              keyPath:
                table === "settings"
                  ? "key"
                  : table === "drafts"
                    ? "sessionId"
                    : "id",
            });
            if (table === "assets")
              store.createIndex("sha256", "sha256", { unique: true });
            else if (table === "messages") {
              store.createIndex("sequence", ["sessionId", "seq"], {
                unique: true,
              });
              store.createIndex("status", "status");
            } else if (table === "sessions" || table === "memories")
              store.createIndex("character", "characterId");
            else if (!["characters", "drafts", "settings"].includes(table))
              store.createIndex("session", "sessionId");
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const tx = db.transaction(tables, "readwrite");
        for (const table of tables)
          for (const row of snapshot[table]) {
            if (table === "assets") {
              const { base64, ...meta } =
                row as (typeof snapshot.assets)[number];
              const originalBlob = new Blob(
                [Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))],
                { type: meta.mimeType },
              );
              tx.objectStore(table).put({ ...meta, originalBlob });
            } else tx.objectStore(table).put(row);
          }
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    { tables: [...TABLES], snapshot: legacyImageSnapshot() },
  );

  let modelCalls = 0;
  page.on("request", (request) => {
    if (
      ["/api/chat", "/api/context/inspect", "/api/state/update"].some((path) =>
        request.url().endsWith(path),
      )
    )
      modelCalls++;
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "旧对话", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-operation="state_update"]')).toContainText(
    "已记录 2 张图片",
  );
  const inspect = () =>
    page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("roleplay-agent", 7);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const tx = db.transaction([
          "assets",
          "settings",
          "sessions",
          "visualObservations",
          "stateTasks",
          "compactionTasks",
        ]);
        const get = <T>(request: IDBRequest<T>) =>
          new Promise<T>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const [ids, counter, session, observations, tasks, compact] =
          await Promise.all([
            get(tx.objectStore("assets").getAllKeys()),
            get(tx.objectStore("settings").get("imageAssetSequence")),
            get(tx.objectStore("sessions").get("session")),
            get(tx.objectStore("visualObservations").getAll()),
            get(tx.objectStore("stateTasks").count()),
            get(tx.objectStore("compactionTasks").get("compact")),
          ]);
        return {
          version: db.version,
          ids,
          counter: counter.value,
          photo: session.characterSnapshot.appearancePhotoAssetId,
          summary: session.summary.text,
          observations,
          tasks,
          historyPart: compact.context.history[0].parts[1].assetId,
        };
      } finally {
        db.close();
      }
    });
  const migrated = await inspect();
  expect(migrated.version).toBe(7);
  expect(migrated.ids).toEqual(["img1", "img2"]);
  expect(migrated.counter).toBe("2");
  expect(migrated.photo).toBe("img1");
  expect(migrated.summary).toContain("图片img1");
  expect(migrated.historyPart).toBe("img2");
  expect(migrated.tasks).toBe(0);
  expect(
    migrated.observations.find((o: any) => o.assetId === "img1").extractedText,
  ).toEqual([oldPhoto]);
  expect(modelCalls).toBe(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "旧对话", exact: true }),
  ).toBeVisible();
  expect(await inspect()).toEqual(migrated);
});
