import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==";
const hash = createHash("sha256")
  .update(Buffer.from(png, "base64"))
  .digest("hex");

for (const legacyVersion of [8, 9, 10, 11]) {
  test(`原生 IndexedDB 的 v${legacyVersion} 库保留原件、正文与草稿后升级为 v12`, async ({
    page,
    baseURL,
  }) => {
    const root = `${baseURL}/`;
    await page.route(root, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<html><body>旧库夹具</body></html>",
      }),
    );
    await page.goto("/");
    await page.evaluate(
      async ({ png, hash, legacyVersion }) => {
        const tables = [
          "characters",
          "sessions",
          "messages",
          "memories",
          "drafts",
          "settings",
          "assets",
          "visualObservations",
          "imageUsages",
          "stateTasks",
          "compactionTasks",
          "operations",
          "goals",
          ...(legacyVersion >= 9
            ? ["sceneImagePlans", "sceneGenerations"]
            : []),
        ];
        const request = indexedDB.open("roleplay-agent", legacyVersion);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const table of tables) {
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
                "sceneImagePlans",
                "sceneGenerations",
              ].includes(table)
            )
              store.createIndex("session", "sessionId");
            if (["sceneImagePlans", "sceneGenerations"].includes(table))
              store.createIndex("message", "assistantMessageId");
            if (table === "sessions" || table === "memories")
              store.createIndex("character", "characterId");
            if (table === "assets")
              store.createIndex("sha256", "sha256", { unique: true });
            if (table === "messages") {
              store.createIndex("sequence", ["sessionId", "seq"], {
                unique: true,
              });
              store.createIndex("status", "status");
            }
          }
        };
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const stamp = "2026-10-20T00:00:00.000Z";
        const profile = {
          name: "迁移前的林溪",
          identity: "旅馆老板",
          description: "谨慎好奇",
          appearancePhotoAssetId: "img1",
        };
        const story = {
          location: "旅馆",
          storyTime: "午后",
          characterState: "穿着旧外套",
          userState: "",
          presentCharacters: [],
          relationships: [],
          items: [],
          openThreads: [],
        };
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        const tx = db.transaction(tables, "readwrite");
        tx.objectStore("characters").put({
          ...profile,
          id: "c",
          archived: false,
          profileVersion: 3,
          memoryVersion: 2,
          createdAt: stamp,
          updatedAt: stamp,
        });
        tx.objectStore("sessions").put({
          id: "s",
          characterId: "c",
          title: "旧旅馆",
          titleSource: "manual",
          characterSnapshot: profile,
          profileVersion: 3,
          story,
          storySources: {},
          stateVersion: 7,
          nextMessageSeq: 3,
          summary: { text: "旧摘要", throughSeq: 0, version: 2 },
          ...(legacyVersion >= 9
            ? {
                visualState: {
                  outfit: "旧蓝袍",
                  hairstyle: "",
                  accessories: [],
                  appearanceChanges: [],
                },
                visualSources: {},
              }
            : {}),
          createdAt: stamp,
          updatedAt: stamp,
        });
        tx.objectStore("messages").put({
          id: "u",
          sessionId: "s",
          seq: 1,
          role: "user",
          text: "原来的用户正文",
          parts: [{ type: "image", assetId: "img1" }],
          status: "complete",
          checkpointVersion: 1,
          createdAt: stamp,
          updatedAt: stamp,
        });
        tx.objectStore("messages").put({
          id: "a",
          sessionId: "s",
          seq: 2,
          role: "assistant",
          segments: [{ kind: "narration", text: "原来的角色正文。" }],
          replyToMessageId: "u",
          status: "complete",
          finishReason: "stop",
          checkpointVersion: 4,
          createdAt: stamp,
          updatedAt: stamp,
        });
        tx.objectStore("assets").put({
          id: "img1",
          ...(legacyVersion >= 9 ? { creationOrigin: "uploaded" } : {}),
          sha256: hash,
          mimeType: "image/png",
          byteSize: bytes.length,
          width: 3,
          height: 2,
          originalBlob: new Blob([bytes], { type: "image/png" }),
          displayName: "旧照片.png",
          createdAt: stamp,
        });
        if (legacyVersion >= 9) {
          tx.objectStore("sceneImagePlans").put({
            id: "p",
            sessionId: "s",
            assistantMessageId: "a",
            sourceSeq: 2,
            sourceCheckpointVersion: 4,
            profileVersion: 3,
            sceneId: "scene",
            previousPlanId: "",
            continuity: "new_scene",
            target: { outfit: "旧蓝袍" },
            summary: "旧摘要",
            fingerprint: "a".repeat(64),
            status: "ready",
            error: null,
            prompt: "旧蓝袍人物站在瀑布旁。",
            referenceImages: [],
          });
          tx.objectStore("sceneGenerations").put({
            id: "g",
            planId: "p",
            sessionId: "s",
            assistantMessageId: "a",
            sourceSeq: 2,
            sourceCheckpointVersion: 4,
            sceneId: "scene",
            ...(legacyVersion >= 10
              ? {
                  submission: {
                    prompt: "原始提交",
                    effectivePrompt: "原始提交",
                    width: 256,
                    height: 512,
                    referenceImages: [
                      {
                        assetId: "img1",
                        ...(legacyVersion === 10
                          ? { roles: ["identity"] }
                          : {}),
                        scope: "人物身份",
                        sha256: hash,
                        sourceSha256: hash,
                        sourceGenerationId: null,
                      },
                    ],
                  },
                }
              : {}),
            status: "succeeded",
            referenceStatus: "eligible",
            assetId: "img1",
            acknowledged: true,
            revision: 2,
            createdAt: stamp,
            updatedAt: stamp,
          });
        }
        tx.objectStore("drafts").put({
          sessionId: "s",
          text: "原来未发的草稿",
          updatedAt: stamp,
        });
        tx.objectStore("settings").put({ key: "characterId", value: "c" });
        tx.objectStore("settings").put({ key: "sessionId", value: "s" });
        tx.objectStore("settings").put({
          key: "imageAssetSequence",
          value: "9",
        });
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      },
      { png, hash, legacyVersion },
    );
    await page.unroute(root);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "旧旅馆", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("原来的角色正文。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue(
      "原来未发的草稿",
    );
    const migrated = await page.evaluate(async () => {
      const request = indexedDB.open("roleplay-agent", 12);
      const db = await new Promise<IDBDatabase>((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      const tx = db.transaction(["sessions", "assets", "settings", "messages"]);
      const get = (table: string, key: string) =>
        new Promise<any>((resolve) => {
          const r = tx.objectStore(table).get(key);
          r.onsuccess = () => resolve(r.result);
        });
      const [session, asset, counter, message] = await Promise.all([
        get("sessions", "s"),
        get("assets", "img1"),
        get("settings", "imageAssetSequence"),
        get("messages", "a"),
      ]);
      const bytes = Array.from(
        new Uint8Array(await asset.originalBlob.arrayBuffer()),
      );
      const result = {
        version: db.version,
        tables: Array.from(db.objectStoreNames),
        stateVersion: session.stateVersion,
        nextSeq: session.nextMessageSeq,
        outfit: session.visualState.outfit,
        sources: session.visualSources,
        summary: session.summary.text,
        origin: asset.creationOrigin,
        sha256: asset.sha256,
        bytes,
        counter: counter.value,
        checkpoint: message.checkpointVersion,
      };
      db.close();
      return result;
    });
    expect(migrated.version).toBe(12);
    expect(migrated.tables).toEqual(
      expect.arrayContaining(["sceneImagePlans", "sceneGenerations"]),
    );
    expect(migrated.stateVersion).toBe(7);
    expect(migrated.nextSeq).toBe(3);
    expect(migrated.outfit).toBe(legacyVersion >= 9 ? "旧蓝袍" : "");
    expect(migrated.sources).toEqual({});
    expect(migrated.summary).toBe("旧摘要");
    expect(migrated.origin).toBe("uploaded");
    expect(migrated.sha256).toBe(hash);
    expect(migrated.bytes).toEqual(Array.from(Buffer.from(png, "base64")));
    expect(migrated.counter).toBe("9");
    expect(migrated.checkpoint).toBe(4);
  });
}
