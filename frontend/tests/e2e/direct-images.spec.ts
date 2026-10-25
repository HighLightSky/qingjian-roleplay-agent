import { test, expect, type Page } from "@playwright/test";
import { contextCapabilities } from "../context-fixture";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==",
  "base64",
);
const imageGeneration = {
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
  let starts = 0;
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ json: { ...contextCapabilities, imageGeneration } }),
  );
  await page.route("**/api/scene-images/inputs/*", (route) =>
    route.fulfill({ status: 200 }),
  );
  await page.route("**/api/scene-images/direct", (route) => {
    starts++;
    const request = route.request().postDataJSON();
    expect(request.prompt).toBe("将背景改成蓝色");
    expect(request.referenceImages).toHaveLength(1);
    return route.fulfill({
      json: {
        runId: request.runId,
        status: "succeeded",
        terminal: true,
        revision: 2,
        submission: {
          ...request,
          effectivePrompt: request.prompt,
          width: null,
          height: null,
        },
      },
    });
  });
  await page.route("**/api/scene-images/*/result", (route) =>
    route.fulfill({ contentType: "image/png", body: png }),
  );
  await page.route("**/api/scene-images/*/ack", (route) =>
    route.fulfill({ status: 200 }),
  );
  await page.goto("/");
  await page.getByRole("link", { name: "直接生图", exact: true }).click();
  await page
    .getByLabel("上传生图参考图")
    .setInputFiles({ name: "参考.png", mimeType: "image/png", buffer: png });
  await page
    .getByRole("textbox", { name: "直接生图提示词" })
    .fill("将背景改成蓝色");
  await expect(
    page.getByRole("button", { name: "生成图片", exact: true }),
  ).toBeEnabled();
  return () => starts;
}
async function assets(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("roleplay-agent");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve) => {
      const request = db.transaction("assets").objectStore("assets").count();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return count;
  });
}

test("手机端可滚动到生成结果和保存操作", async ({ page, isMobile }) => {
  test.skip(!isMobile);
  await page.setViewportSize({ width: 390, height: 640 });
  await setup(page);
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  const result = page.getByAltText("生成结果", { exact: true });
  await expect(result).toBeVisible();
  const main = page.getByRole("main");
  await main.evaluate((element) => element.scrollTo(0, 0));
  await expect(result).not.toBeInViewport();
  await page.mouse.move(195, 320);
  await page.mouse.wheel(0, 2000);
  await expect
    .poll(() => main.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(result).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "保存到浏览器资源库", exact: true }),
  ).toBeInViewport();
});

test("直接生图默认临时保留，弹窗下载，显式保存后刷新仍可选为参考", async ({
  page,
}) => {
  const starts = await setup(page);
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(page.getByAltText("生成结果", { exact: true })).toBeVisible();
  expect(await assets(page)).toBe(0);
  await page.getByRole("button", { name: "预览生成结果" }).click();
  const preview = page.getByRole("dialog", { name: /查看图片/ });
  await expect(preview).toBeVisible();
  const download = page.waitForEvent("download");
  await preview.getByRole("link", { name: "下载图片" }).click();
  expect((await download).suggestedFilename()).toMatch(/生成图片-.*\.png/);
  await preview.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .getByRole("button", { name: "保存到浏览器资源库", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "已保存到资源库" }),
  ).toBeDisabled();
  expect(await assets(page)).toBe(1);
  await page.reload();
  await expect(page.getByAltText("生成结果", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "从浏览器资源库选择" }).click();
  await page.getByLabel("选择 img1", { exact: true }).check();
  await page.getByRole("button", { name: "添加所选图片（1）" }).click();
  await expect(
    page.getByRole("button", { name: "移除参考图 1" }),
  ).toBeVisible();
  expect(starts()).toBe(1);
});

test("再次生成覆盖临时结果，放弃已保存结果删除本地原件", async ({ page }) => {
  const starts = await setup(page);
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(page.getByAltText("生成结果", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(page.getByAltText("生成结果", { exact: true })).toBeVisible();
  expect(starts()).toBe(2);
  expect(await assets(page)).toBe(0);
  await page
    .getByRole("button", { name: "保存到浏览器资源库", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "已保存到资源库" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "放弃这张" }).click();
  await expect(page.getByAltText("生成结果", { exact: true })).toHaveCount(0);
  expect(await assets(page)).toBe(0);
});

test("直接生图可停止，取消完成后恢复生成按钮且无本地结果", async ({ page }) => {
  await setup(page);
  let request: any;
  let cancelled = false;
  const snapshot = () => ({
    runId: request.runId,
    status: cancelled ? "cancelled" : "running",
    terminal: cancelled,
    revision: cancelled ? 3 : 1,
    error: cancelled ? "任务已取消" : null,
    submission: {
      ...request,
      effectivePrompt: request.prompt,
      width: null,
      height: null,
    },
  });
  await page.route("**/api/scene-images/direct", (route) => {
    request = route.request().postDataJSON();
    return route.fulfill({ json: snapshot() });
  });
  await page.route("**/api/scene-images/*", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: snapshot() });
  });
  await page.route("**/api/scene-images/*/cancel", (route) => {
    cancelled = true;
    return route.fulfill({ status: 202, json: { status: "cancelling" } });
  });
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "任务已取消",
  );
  await expect(
    page.getByRole("button", { name: "生成图片", exact: true }),
  ).toBeEnabled();
  await expect(page.getByAltText("生成结果", { exact: true })).toHaveCount(0);
  expect(await assets(page)).toBe(0);
});
