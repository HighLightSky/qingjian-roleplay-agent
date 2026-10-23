import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

test.use({ reducedMotion: "reduce" });
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "消息内容" }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.locator('[data-operation="state_update"]').last(),
  ).toContainText(/已检查|已更新/);
}

test("历史附件与照片缺图持续提示且可续聊，统计保留正常图片，恢复原件后自动恢复", async ({
  page,
}, info) => {
  const portrait = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==",
    "base64",
  );
  const hash = createHash("sha256").update(portrait).digest("hex");
  await page.request.post("/api/images/cache/clear", {
    data: { hashes: [hash] },
  });
  await page.goto("/");
  const map = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 5;
      canvas.height = 5;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "blue";
      context.fillRect(0, 0, 5, 5);
      return canvas.toDataURL().split(",")[1];
    }),
    "base64",
  );
  await page.getByRole("button", { name: "创建第一个角色" }).click();
  await page.getByPlaceholder("你想如何称呼这个角色？").fill("缺图角色");
  await page.getByLabel("选择角色形象照片", { exact: true }).setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: portrait,
  });
  await expect(
    page.getByRole("img", { name: "角色形象照片", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles([
    { name: "portrait.png", mimeType: "image/png", buffer: portrait },
    { name: "map.png", mimeType: "image/png", buffer: map },
  ]);
  await expect(
    page.getByRole("button", { name: "移除 map.png", exact: true }),
  ).toBeVisible();
  await page.route(`**/api/images/${hash}`, (route) =>
    route.fulfill({ status: 503, json: { message: "测试上传失败" } }),
  );
  await page.getByRole("textbox", { name: "消息内容" }).fill("先看两张图");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "测试上传失败" }).first(),
  ).toBeVisible();
  await page.unroute(`**/api/images/${hash}`);
  const removed = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("roleplay-agent");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const asset = await new Promise<any>((resolve, reject) => {
      const r = db.transaction("assets").objectStore("assets").get("img1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (!asset) throw new Error("上传失败不应删除本地原件");
    const { originalBlob, thumbnailBlob, ...metadata } = asset;
    const original = Array.from(
      new Uint8Array(await originalBlob.arrayBuffer()),
    );
    const thumbnail = Array.from(
      new Uint8Array(await thumbnailBlob.arrayBuffer()),
    );
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("assets", "readwrite");
      tx.objectStore("assets").delete("img1");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return { metadata, original, thumbnail };
  });
  await page.reload();
  const notice = page
    .getByRole("status")
    .filter({ hasText: "对话可继续，已有观察" });
  await expect(notice).toContainText("img1");
  const mobile = (page.viewportSize()?.width ?? 1440) < 768;
  if (mobile) await page.getByRole("button", { name: "打开会话导航" }).click();
  await expect(
    page
      .getByLabel("角色照片 img1 原件缺失，已跳过")
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  if (mobile)
    await page
      .getByRole("dialog", { name: "角色与对话导航" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
  await expect(
    page
      .locator('[data-role="user"]')
      .getByRole("group", { name: /原件缺失，已跳过/ }),
  ).toBeVisible();
  const chatRequest = page.waitForRequest((r) => r.url().endsWith("/api/chat"));
  await send(page, "继续聊，正常地图还在");
  const request = (await chatRequest).postDataJSON();
  expect(
    request.context.visual.missingAssets.map((a: any) => a.assetId),
  ).toEqual(["img1"]);
  expect(
    request.context.visual.missingAssets[0].sources.map((s: any) => s.type),
  ).toEqual(["character_photo", "message"]);
  expect(request.images.map((a: any) => a.assetId)).toEqual(["img2"]);
  await expect(notice).toBeVisible();
  await page.screenshot({
    path: info.outputPath("missing-image-chat.png"),
    animations: "disabled",
  });
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await page.getByRole("button", { name: "打开会话导航" }).click();
  await page.getByRole("button", { name: "设置与数据", exact: true }).click();
  const local = page.getByRole("region", { name: "本地数据明细", exact: true });
  await expect(local).toContainText("4 条消息 · 1 张图片");
  await expect(local).toContainText("缺失 1 张原图");
  await expect(local).toContainText("角色：缺图角色");
  await local.getByRole("button", { name: "刷新数据" }).click();
  await expect(local).toContainText("缺失 1 张原图");
  await page.screenshot({
    path: info.outputPath("missing-image-statistics.png"),
    animations: "disabled",
  });
  await page.evaluate(async (saved) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("roleplay-agent");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("assets", "readwrite");
      tx.objectStore("assets").put({
        ...saved.metadata,
        originalBlob: new Blob([new Uint8Array(saved.original)], {
          type: saved.metadata.mimeType,
        }),
        thumbnailBlob: new Blob([new Uint8Array(saved.thumbnail)], {
          type: "image/png",
        }),
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, removed);
  await page.reload();
  await expect(notice).toHaveCount(0);
  if (mobile) await page.getByRole("button", { name: "打开会话导航" }).click();
  await expect(
    page
      .getByRole("img", { name: "缺图角色的形象缩略图" })
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  if (mobile)
    await page
      .getByRole("dialog", { name: "角色与对话导航" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
  await send(page, "恢复后继续");
  await expect(notice).toHaveCount(0);
});
