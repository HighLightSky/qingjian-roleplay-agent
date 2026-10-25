import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { dispatchResponse } from "../dispatch-fixture";
import { contextCapabilities } from "../context-fixture";
const base64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==";
const hash = createHash("sha256")
  .update(Buffer.from(base64, "base64"))
  .digest("hex");
const generationCaps = {
  enabled: true,
  maxImageBytes: 16777216,
  maxPixels: 4194304,
  maxEdge: 8192,
  maxTotalPixels: 16777216,
  maxRequestBytes: 134217728,
  maxPromptCharacters: 16384,
  maxOutputBytes: 67108864,
  maxOutputPixels: 20000000,
  referenceMaxEdge: 1024,
  referenceJpegQuality: 0.85,
};
async function setup(page: Page) {
  await page.route("**/api/chat", async (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: await dispatchResponse(route.request().postDataJSON()).text(),
    }),
  );
  await page.route("**/api/chat/*/ack", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/images/missing", (route) =>
    route.fulfill({ json: { missing: [] } }),
  );
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({
      json: { ...contextCapabilities, imageGeneration: generationCaps },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "创建第一个角色" }).click();
  await page.getByPlaceholder("你想如何称呼这个角色？").fill("林溪");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await page.getByRole("textbox", { name: "消息内容" }).fill("你好");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open("roleplay-agent", 9);
        const db = await new Promise<IDBDatabase>((resolve) => {
          request.onsuccess = () => resolve(request.result);
        });
        const tx = db.transaction("messages");
        const messages = await new Promise<any[]>((resolve) => {
          const r = tx.objectStore("messages").getAll();
          r.onsuccess = () => resolve(r.result);
        });
        db.close();
        const assistant = messages
          .filter((m) => m.role === "assistant")
          .sort((a, b) => a.seq - b.seq)
          .at(-1);
        return assistant?.seq >= 2 && assistant.status === "complete";
      }),
    )
    .toBe(true);
  await page.evaluate(
    async ({ base64, hash }) => {
      const request = indexedDB.open("roleplay-agent", 9);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const read = db.transaction(["sessions", "messages"]);
      const sessions = await new Promise<any[]>((resolve) => {
        const r = read.objectStore("sessions").getAll();
        r.onsuccess = () => resolve(r.result);
      });
      const messages = await new Promise<any[]>((resolve) => {
        const r = read.objectStore("messages").getAll();
        r.onsuccess = () => resolve(r.result);
      });
      const session = sessions[0];
      const assistant = messages
        .filter((m) => m.role === "assistant")
        .sort((a, b) => a.seq - b.seq)
        .at(-1);
      if (assistant.status !== "complete")
        throw new Error(
          "测试正文未完成：" +
            JSON.stringify(
              messages.map((m) => ({
                id: m.id,
                seq: m.seq,
                role: m.role,
                status: m.status,
              })),
            ),
        );
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const tx = db.transaction(
        ["assets", "settings", "sessions", "sceneImagePlans"],
        "readwrite",
      );
      tx.objectStore("assets").put({
        id: "img1",
        creationOrigin: "uploaded",
        sha256: hash,
        mimeType: "image/png",
        byteSize: bytes.length,
        width: 3,
        height: 2,
        originalBlob: new Blob([bytes], { type: "image/png" }),
        displayName: "身份.png",
        createdAt: new Date().toISOString(),
      });
      tx.objectStore("settings").put({ key: "imageAssetSequence", value: "1" });
      tx.objectStore("sessions").put({
        ...session,
        characterSnapshot: {
          ...session.characterSnapshot,
          appearancePhotoAssetId: "img1",
        },
      });
      tx.objectStore("sceneImagePlans").put({
        id: "plan",
        sessionId: session.id,
        assistantMessageId: assistant.id,
        sourceSeq: assistant.seq,
        sourceCheckpointVersion: assistant.checkpointVersion,
        profileVersion: session.profileVersion,
        sceneId: "scene",
        previousPlanId: "",
        continuity: "new_scene",
        target: { outfit: "白裙" },
        referenceImages: [
          {
            assetId: "img1",
            roles: ["base", "identity"],
            scope: "人物身份",
            sourceSha256: hash,
            sourceGenerationId: null,
          },
        ],
        prompt:
          "[参考图说明]参考 <image1> 的人物。\n[画面摘要]白裙人物坐在窗边。",
        summary: "白裙人物坐在窗边。",
        fingerprint: "a".repeat(64),
        status: "ready",
        error: null,
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      window.dispatchEvent(new Event("scene-images-changed"));
    },
    { base64, hash },
  );
  await expect(
    page.getByRole("button", { name: "生成图片", exact: true }),
  ).toBeVisible();
}

test("生成不阻塞输入；刷新只恢复原任务，成功结果保存后展示", async ({
  page,
}) => {
  let starts = 0,
    complete = false,
    runId = "";
  await page.route("**/api/scene-images", async (route) => {
    starts++;
    runId = route.request().postDataJSON().runId;
    await route.fulfill({ json: { runId } });
  });
  await page.route("**/api/scene-images/*/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify({ runId, revision: complete ? 2 : 1, status: complete ? "succeeded" : "running", error: null, errorCode: null, terminal: complete })}\n\n`,
    }),
  );
  await page.route("**/api/scene-images/*/result", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(base64, "base64"),
    }),
  );
  await page.route("**/api/scene-images/*/ack", (route) =>
    route.fulfill({ json: {} }),
  );
  await setup(page);
  expect(starts).toBe(0);
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeEnabled();
  await page.reload();
  complete = true;
  await expect(page.getByAltText("剧情图")).toBeVisible();
  expect(starts).toBe(1);
  await expect(
    page.getByRole("button", { name: "重新生成", exact: true }),
  ).toBeVisible();
});

test("停止收到 202 显示取消中，等原任务终态才允许重新生成", async ({
  page,
}) => {
  let runId = "",
    cancelling = false,
    cancelled = false,
    stops = 0;
  await page.route("**/api/scene-images", (route) => {
    runId = route.request().postDataJSON().runId;
    return route.fulfill({ json: { runId } });
  });
  await page.route("**/api/scene-images/*/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify({ runId, revision: cancelled ? 3 : cancelling ? 2 : 1, status: cancelled ? "cancelled" : cancelling ? "cancelling" : "running", error: null, errorCode: null, terminal: cancelled })}\n\n`,
    }),
  );
  await page.route("**/api/scene-images/*/cancel", (route) => {
    cancelling = true;
    stops++;
    return route.fulfill({ status: 202, json: { status: "cancelling" } });
  });
  await page.route("**/api/scene-images/*/ack", (route) =>
    route.fulfill({ json: {} }),
  );
  await setup(page);
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "取消中…", exact: true }),
  ).toBeDisabled();
  expect(stops).toBe(1);
  await expect(
    page.getByRole("button", { name: "重新生成", exact: true }),
  ).toHaveCount(0);
  cancelled = true;
  await expect(
    page.getByRole("button", { name: "重新生成", exact: true }),
  ).toBeVisible();
});

test("底图与身份上传原件，辅助服装按用途压缩且顺序不变", async ({ page }) => {
  await setup(page);
  const auxiliaryHash = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 1024;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#cc3344";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((value) => resolve(value!), "image/jpeg", 0.95),
    );
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const request = indexedDB.open("roleplay-agent", 9);
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const plan = await new Promise<any>((resolve) => {
      const r = db
        .transaction("sceneImagePlans")
        .objectStore("sceneImagePlans")
        .get("plan");
      r.onsuccess = () => resolve(r.result);
    });
    const tx = db.transaction(
      ["assets", "settings", "sceneImagePlans"],
      "readwrite",
    );
    tx.objectStore("assets").put({
      id: "img2",
      creationOrigin: "uploaded",
      sha256: hash,
      mimeType: "image/jpeg",
      byteSize: blob.size,
      width: 2048,
      height: 1024,
      originalBlob: blob,
      displayName: "衣服.jpg",
      createdAt: new Date().toISOString(),
    });
    tx.objectStore("settings").put({ key: "imageAssetSequence", value: "2" });
    tx.objectStore("sceneImagePlans").put({
      ...plan,
      referenceImages: [
        ...plan.referenceImages,
        {
          assetId: "img2",
          roles: ["outfit"],
          scope: "服装细节",
          sourceSha256: hash,
          sourceGenerationId: null,
        },
      ],
    });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    db.close();
    window.dispatchEvent(new Event("scene-images-changed"));
    return hash;
  });
  const uploaded: { hash: string; bytes: Buffer }[] = [];
  await page.route("**/api/images/missing", (route) =>
    route.fulfill({ json: { missing: route.request().postDataJSON().hashes } }),
  );
  await page.route("**/api/scene-images/inputs/*", async (route) => {
    uploaded.push({
      hash: route.request().url().split("/").at(-1)!,
      bytes: route.request().postDataBuffer()!,
    });
    await route.fulfill({ status: 200 });
  });
  let inputs: { assetId: string; sha256: string; sourceSha256: string }[] = [];
  await page.route("**/api/scene-images", async (route) => {
    inputs = route.request().postDataJSON().images;
    await route.fulfill({ json: {} });
  });
  await page.route("**/api/scene-images/*/events", (route) =>
    route.fulfill({ status: 404, json: { message: "测试任务结束" } }),
  );
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect.poll(() => inputs.length).toBe(2);
  expect(inputs.map((i) => i.assetId)).toEqual(["img1", "img2"]);
  expect(inputs[0].sha256).toBe(hash);
  expect(inputs[1].sourceSha256).toBe(auxiliaryHash);
  expect(inputs[1].sha256).not.toBe(auxiliaryHash);
  expect(uploaded[0].bytes).toEqual(Buffer.from(base64, "base64"));
  const dimensions = await page.evaluate(async (encoded) => {
    const blob = new Blob(
      [Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))],
      { type: "image/jpeg" },
    );
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }, uploaded[1].bytes.toString("base64"));
  expect(dimensions).toEqual({ width: 1024, height: 512 });
});
