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
  poseMaxBytes: 1048576,
  poseSearchMaxRequestBytes: 65536,
  poseSearchMaxResponseBytes: 4194304,
  poseSearchTopK: 3,
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
        const request = indexedDB.open("roleplay-agent", 12);
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
      const request = indexedDB.open("roleplay-agent", 12);
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
        poseQuery: null,
        characterReferenceAssetId: null,
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
    const request = indexedDB.open("roleplay-agent", 12);
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
    const opening = indexedDB.open("roleplay-agent", 12);
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
  await card.getByLabel("上传剧情参考图").setInputFiles({
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

const poseMatches = ["站立", "坐姿", "跳跃"].map((name, index) => ({
  poseId: `pose-${index}`,
  score: 0.4 - index * 0.1,
  description: {
    zh: `${name}，双手撑在身后`,
    en: `${name} with both hands behind`,
  },
  pose: {
    schema_version: 3,
    active_character_id: "hero",
    activeTab: "pose1",
    characters: [
      { id: "hero", poses: { pose1: { bones: { leftArm: [index, 2, 3] } } } },
    ],
    camera: { zoom: 1.5, position: [1, 2, 3] },
    saved_prompt: "旧提示词不参与执行",
  },
}));

async function seedPosePlan(page: Page, secondReference = false) {
  await page.evaluate(async (second) => {
    const request = indexedDB.open("roleplay-agent");
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const get = db
      .transaction("sceneImagePlans")
      .objectStore("sceneImagePlans")
      .get("plan");
    const plan = await new Promise<any>((resolve) => {
      get.onsuccess = () => resolve(get.result);
    });
    let blob: Blob | undefined;
    let hash: string | undefined;
    if (second) {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
      blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!), "image/png"),
      );
      hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
        ),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
    }
    const tx = db.transaction(
      ["sceneImagePlans", "assets", "settings"],
      "readwrite",
    );
    if (second) {
      tx.objectStore("assets").put({
        id: "img2",
        creationOrigin: "uploaded",
        sha256: hash,
        mimeType: "image/png",
        byteSize: blob!.size,
        width: 2,
        height: 2,
        originalBlob: blob,
        displayName: "第二人物.png",
        createdAt: new Date().toISOString(),
      });
      tx.objectStore("settings").put({ key: "imageAssetSequence", value: "2" });
      plan.referenceImages.push({
        assetId: "img2",
        scope: "人物外观",
        sourceSha256: hash,
        sourceGenerationId: null,
      });
    }
    delete plan.draft;
    tx.objectStore("sceneImagePlans").put({
      ...plan,
      poseQuery: "坐在地上，双手撑在身后",
      characterReferenceAssetId: "img1",
      prompt: "保持<image2>的人物身份、发型与服装，草地日光。",
    });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    db.close();
  }, secondReference);
  await page.reload();
}

test("自动检索无需展开卡片；换选候选和人物图后按 image2 顺序提交完整姿势，刷新保留选择", async ({
  page,
}) => {
  let searches = 0;
  await page.route("**/api/scene-images/poses/search", (route) => {
    searches++;
    expect(route.request().postDataJSON().query).toBe("坐在地上，双手撑在身后");
    return route.fulfill({ json: { matches: poseMatches } });
  });
  await setup(page);
  await seedPosePlan(page, true);
  await expect.poll(() => searches).toBe(1);
  const card = page.getByTestId("scene-image-card").last();
  await expect(
    card.getByRole("button", { name: "生成图片", exact: true }),
  ).toBeDisabled();
  await card.locator("summary").click();
  await expect(card.getByLabel("使用姿势参考")).toBeChecked();
  await expect(card.getByRole("radio")).toHaveCount(3);
  await expect(card.getByRole("radio", { checked: true })).toHaveCount(0);
  await card.getByLabel("选择姿势 坐姿，双手撑在身后").check();
  await card.getByLabel("人物参考图", { exact: true }).selectOption("img2");
  await expect(
    card.getByText("参考图 2：img2", { exact: false }),
  ).toBeVisible();
  await page.reload();
  const restored = page.getByTestId("scene-image-card").last();
  await restored.locator("summary").click();
  await expect(
    restored.getByLabel("选择姿势 坐姿，双手撑在身后"),
  ).toBeChecked();
  await expect(restored.getByLabel("人物参考图", { exact: true })).toHaveValue(
    "img2",
  );
  expect(searches).toBe(1);
  let submitted: any;
  await page.route("**/api/scene-images", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: { runId: submitted.runId } });
  });
  await page.route("**/api/scene-images/*/events", (route) =>
    route.fulfill({ status: 404, json: { message: "测试任务结束" } }),
  );
  await restored.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect.poll(() => submitted?.poseSelection?.poseId).toBe("pose-1");
  expect(submitted.referenceImages.map((image: any) => image.assetId)).toEqual([
    "img2",
    "img1",
  ]);
  expect(submitted.poseSelection.pose).toEqual(poseMatches[1].pose);
  expect(submitted.poseEnabled).toBe(true);
});

test("检索失败只影响姿势区域，关闭参考可普通生成并保留动作描述", async ({
  page,
}) => {
  let searches = 0;
  await page.route("**/api/scene-images/poses/search", (route) => {
    searches++;
    return route.fulfill({
      status: 503,
      json: {
        code: "POSE_INDEX_NOT_READY",
        message: "姿势索引未就绪，服务请求 ID：pose-123",
      },
    });
  });
  await setup(page);
  await seedPosePlan(page);
  const card = page.getByTestId("scene-image-card").last();
  await card.locator("summary").click();
  await expect(card.getByRole("alert")).toContainText("pose-123");
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeEnabled();
  await page.reload();
  const restored = page.getByTestId("scene-image-card").last();
  await restored.locator("summary").click();
  await expect(restored.getByRole("alert")).toContainText("pose-123");
  expect(searches).toBe(1);
  await restored.getByLabel("使用姿势参考").uncheck();
  let submitted: any;
  await page.route("**/api/scene-images", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: { runId: submitted.runId } });
  });
  await page.route("**/api/scene-images/*/events", (route) =>
    route.fulfill({ status: 404, json: { message: "测试任务结束" } }),
  );
  await restored.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect.poll(() => submitted?.poseEnabled).toBe(false);
  expect(submitted.poseSelection).toBeNull();
  expect(submitted.poseQuery).toBe("坐在地上，双手撑在身后");
});

test("修改描述后旧候选与选择失效，重新检索为空时提示修改描述", async ({
  page,
}) => {
  let searches = 0;
  await page.route("**/api/scene-images/poses/search", (route) => {
    searches++;
    return route.fulfill({
      json: { matches: searches === 1 ? poseMatches : [] },
    });
  });
  await setup(page);
  await seedPosePlan(page);
  const card = page.getByTestId("scene-image-card").last();
  await card.locator("summary").click();
  await card.getByLabel("选择姿势 坐姿，双手撑在身后").check();
  await expect(
    card.getByRole("button", { name: "生成图片", exact: true }),
  ).toBeEnabled();
  await card.getByLabel("姿态检索描述").fill("人物跳跃，双臂举起");
  await expect(card.getByRole("radio")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "生成图片", exact: true }),
  ).toBeDisabled();
  await card.getByRole("button", { name: "重新检索" }).click();
  await expect(
    card.getByText("没有姿势候选，请修改描述后重新检索。", { exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "生成图片", exact: true }),
  ).toBeDisabled();
});

test("新回复整理落库立即触发姿势检索，等待检索不阻塞聊天输入", async ({
  page,
}) => {
  await setup(page);
  let searches = 0;
  await page.route("**/api/scene-images/poses/search", async (route) => {
    searches++;
    expect(route.request().postDataJSON().query).toBe("人物站立，双手下垂");
    await route.fulfill({ json: { matches: poseMatches } });
  });
  await page.route("**/api/chat", async (route) => {
    const body = await dispatchResponse(route.request().postDataJSON()).text();
    const snapshot = JSON.parse(body.split("data: ")[1].trim());
    snapshot.state.scenePlan.poseQuery = "人物站立，双手下垂";
    snapshot.state.scenePlan.prompt = "与<image2>相同的人物，窗边日光。";
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
    });
  });
  await page.getByRole("textbox", { name: "消息内容" }).fill("站到窗前");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => searches).toBe(1);
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeEnabled();
  const card = page.getByTestId("scene-image-card").last();
  await card.locator("summary").click();
  await expect(card.getByLabel("姿态检索描述")).toHaveValue(
    "人物站立，双手下垂",
  );
  await expect(card.getByRole("radio")).toHaveCount(3);
});
