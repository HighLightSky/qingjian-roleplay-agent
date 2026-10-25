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
  defaultWidth: 512,
  defaultHeight: 512,
  dimensionAlignment: 32,
  maxReferenceImages: 9,
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
        const request = indexedDB.open("roleplay-agent", 11);
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
  await expect(page.getByTestId("scene-image-card")).toBeVisible();
  await page.evaluate(
    async ({ base64, hash }) => {
      const request = indexedDB.open("roleplay-agent", 11);
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
      tx.objectStore("sceneImagePlans").clear();
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
        referenceImages: [
          {
            assetId: "img1",

            scope: "人物身份",
            sourceSha256: hash,
            sourceGenerationId: null,
          },
        ],
        prompt:
          "[参考图说明]参考 <image1> 的人物。\n[画面摘要]白裙人物坐在窗边。",
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
  let submission: any;
  let starts = 0,
    complete = false,
    runId = "";
  await page.route("**/api/scene-images", async (route) => {
    starts++;
    const request = route.request().postDataJSON();
    runId = request.runId;
    submission = { ...request, effectivePrompt: request.prompt };
    await route.fulfill({ json: { runId } });
  });
  await page.route("**/api/scene-images/*/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify({ runId, revision: complete ? 2 : 1, status: complete ? "succeeded" : "running", error: null, errorCode: null, terminal: complete, submission })}\n\n`,
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
  await page.getByRole("button", { name: "预览剧情图" }).click();
  const preview = page.getByRole("dialog", { name: "查看图片 剧情图.png" });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("link", { name: "下载图片" })).toHaveAttribute(
    "download",
    "剧情图.png",
  );
  await preview.getByRole("button", { name: "关闭", exact: true }).click();
  expect(starts).toBe(1);
  await expect(
    page.getByRole("button", { name: "再次生成", exact: true }),
  ).toBeVisible();
});

test("停止收到 202 显示取消中，等原任务终态才允许重新生成", async ({
  page,
}) => {
  let submission: any;
  let runId = "",
    cancelling = false,
    cancelled = false,
    stops = 0;
  await page.route("**/api/scene-images", (route) => {
    const request = route.request().postDataJSON();
    runId = request.runId;
    submission = { ...request, effectivePrompt: request.prompt };
    return route.fulfill({ json: { runId } });
  });
  await page.route("**/api/scene-images/*/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify({ runId, revision: cancelled ? 3 : cancelling ? 2 : 1, status: cancelled ? "cancelled" : cancelling ? "cancelling" : "running", error: null, errorCode: null, terminal: cancelled, submission })}\n\n`,
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
    page.getByRole("button", { name: "再次生成", exact: true }),
  ).toBeDisabled();
  cancelled = true;
  await expect(
    page.getByRole("button", { name: "再次生成", exact: true }),
  ).toBeVisible();
});

test("身份和服装参考均可压缩，黑图由后端注入", async ({ page }) => {
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
    const request = indexedDB.open("roleplay-agent", 11);
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
  const card = page.getByTestId("scene-image-card").last();
  await card.locator("summary").click();
  await card.getByLabel("使用参考图 img2").check();
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
    inputs = route.request().postDataJSON().referenceImages;
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

test("编辑提示词先确认；取消不提交，确认后冻结参数；放弃后继续编辑生成", async ({
  page,
}) => {
  const requests: any[] = [];
  await page.route("**/api/scene-images", async (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    await route.fulfill({ json: { runId: request.runId } });
  });
  await page.route("**/api/scene-images/*/events", (route) => {
    const request = requests.find((request) =>
      route.request().url().includes(request.runId),
    );
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify({
        runId: request.runId,
        revision: 2,
        status: "succeeded",
        error: null,
        terminal: true,
        submission: {
          ...request,
          effectivePrompt: `实际提交：${request.prompt}`,
        },
      })}\n\n`,
    });
  });
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
  const card = page.getByTestId("scene-image-card").last();
  await card.locator("summary").click();
  await card
    .getByLabel("生图提示词")
    .fill("李白穿蓝袍站在瀑布旁，参考 img1。无需图片编号和固定段落。");
  await card.getByLabel("画面宽度").fill("257");
  await card.getByLabel("画面高度").fill("513");
  await expect(card.getByText("实际画幅：288 × 544")).toBeVisible();
  await card.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(
    page.getByText("修改提示词可能导致视觉上下文不连贯，是否要继续？", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回修改", exact: true }).click();
  expect(requests).toHaveLength(0);
  await page.reload();
  const restored = page.getByTestId("scene-image-card").last();
  await restored.locator("summary").click();
  await expect(restored.getByLabel("生图提示词")).toHaveValue(/李白穿蓝袍/);
  await expect(restored.getByLabel("画面宽度")).toHaveValue("257");
  await restored.getByRole("button", { name: "生成图片", exact: true }).click();
  await page.getByRole("button", { name: "继续生成", exact: true }).click();
  await expect(
    restored.getByRole("button", { name: "放弃这张", exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].width).toBe(288);
  expect(requests[0].height).toBe(544);
  expect(requests[0].prompt).toContain("参考 img1");
  await restored.getByRole("button", { name: "放弃这张", exact: true }).click();
  await expect(restored.getByAltText("剧情图", { exact: true })).toHaveCount(0);
  await restored.getByLabel("生图提示词").fill("李白换成红袍。");
  await restored.getByRole("button", { name: "再次生成", exact: true }).click();
  await page.getByRole("button", { name: "继续生成", exact: true }).click();
  await expect(restored.getByAltText("剧情图")).toHaveCount(1);
  expect(requests).toHaveLength(2);
  expect(requests[1].runId).not.toBe(requests[0].runId);
  expect(requests[1].prompt).toBe("李白换成红袍。");
});

test("无身份照片且参考建议报错时，仍允许仅用提示词生成；只改尺寸不弹窗", async ({
  page,
}) => {
  let request: any;
  await page.route("**/api/scene-images", (route) => {
    request = route.request().postDataJSON();
    return route.fulfill({ json: { runId: request.runId } });
  });
  await page.route("**/api/scene-images/*/events", (route) =>
    route.fulfill({ status: 404, json: { message: "测试任务结束" } }),
  );
  await setup(page);
  await page.evaluate(async () => {
    const opening = indexedDB.open("roleplay-agent", 11);
    const db = await new Promise<IDBDatabase>((resolve) => {
      opening.onsuccess = () => resolve(opening.result);
    });
    const tx = db.transaction(["sceneImagePlans", "sessions"], "readwrite");
    const getPlan = tx.objectStore("sceneImagePlans").get("plan");
    getPlan.onsuccess = () => {
      const plan = getPlan.result;
      tx.objectStore("sceneImagePlans").put({
        ...plan,
        id: "free-plan",
        referenceImages: [],
        prompt: "李白站在瀑布旁。",
        error: "参考建议解析失败",
      });
      tx.objectStore("sceneImagePlans").delete("plan");
      const getSession = tx.objectStore("sessions").get(plan.sessionId);
      getSession.onsuccess = () => {
        const session = getSession.result;
        delete session.characterSnapshot.appearancePhotoAssetId;
        tx.objectStore("sessions").put(session);
      };
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    window.dispatchEvent(new Event("scene-images-changed"));
  });
  const card = page.getByTestId("scene-image-card").last();
  await card.locator("summary").click();
  await expect(card.getByLabel("生图提示词")).toHaveValue("李白站在瀑布旁。");
  await expect(card.getByLabel("画面宽度")).toHaveValue("512");
  await expect(card.getByLabel("画面高度")).toHaveValue("512");
  await card.getByLabel("画面宽度").fill("768");
  await card.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect.poll(() => request?.width).toBe(768);
  expect(request.referenceImages).toEqual([]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("剧情图从资源库添加列表外参考，上传先入库且刷新保留选择", async ({
  page,
}) => {
  await setup(page);
  const encodedImage = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#3366ff";
    context.fillRect(0, 0, 1, 1);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const image = Buffer.from(encodedImage, "base64");
  await page.evaluate(
    async ({ encoded, hash }) => {
      const request = indexedDB.open("roleplay-agent");
      const db = await new Promise<IDBDatabase>((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      const tx = db.transaction(["assets", "settings"], "readwrite");
      const bytes = Uint8Array.from(atob(encoded), (value) =>
        value.charCodeAt(0),
      );
      tx.objectStore("assets").put({
        id: "img2",
        creationOrigin: "uploaded",
        sha256: hash,
        mimeType: "image/png",
        byteSize: bytes.length,
        width: 1,
        height: 1,
        originalBlob: new Blob([bytes], { type: "image/png" }),
        displayName: "服装.png",
        createdAt: new Date().toISOString(),
      });
      tx.objectStore("settings").put({ key: "imageAssetSequence", value: "2" });
      tx.objectStore("settings").put({
        key: "libraryAsset:img2",
        value: "img2",
      });
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
      });
      db.close();
    },
    {
      encoded: image.toString("base64"),
      hash: createHash("sha256").update(image).digest("hex"),
    },
  );
  const card = page.getByTestId("scene-image-card").last();
  await card.locator("summary").click();
  await card.getByRole("button", { name: "从资源库添加" }).click();
  await page.getByLabel("选择 img2", { exact: true }).check();
  await page.getByRole("button", { name: "添加所选图片（1）" }).click();
  await expect(card.getByLabel("使用参考图 img2")).toBeChecked();
  const uploaded = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await card
    .getByLabel("上传剧情参考图")
    .setInputFiles({
      name: "新参考.png",
      mimeType: "image/png",
      buffer: Buffer.from(uploaded, "base64"),
    });
  await expect(card.getByLabel("使用参考图 img3")).toBeChecked();
  await page.reload();
  const restored = page.getByTestId("scene-image-card").last();
  await restored.locator("summary").click();
  await expect(restored.getByLabel("使用参考图 img2")).toBeChecked();
  await expect(restored.getByLabel("使用参考图 img3")).toBeChecked();
  const pin = await page.evaluate(async () => {
    const request = indexedDB.open("roleplay-agent");
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const row = await new Promise<any>((resolve) => {
      const request = db
        .transaction("settings")
        .objectStore("settings")
        .get("libraryAsset:img3");
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return row;
  });
  expect(pin.value).toBe("img3");
});
