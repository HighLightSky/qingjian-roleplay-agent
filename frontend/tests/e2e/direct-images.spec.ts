import { test, expect, type Page } from "@playwright/test";
import { poseScene } from "../pose-fixture";
import { contextCapabilities } from "../context-fixture";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==",
  "base64",
);
const imageGeneration = {
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

test("结果在设置前展示，首次成功后折叠，手动展开不被保存状态打断", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  const result = page.getByAltText("生成结果", { exact: true });
  await expect(result).toBeVisible();
  await expect(page.getByTestId("generation-settings")).not.toHaveAttribute(
    "open",
  );
  await expect(
    page.getByRole("button", { name: "保存到浏览器资源库", exact: true }),
  ).toBeVisible();
  const resultTop = (await result.boundingBox())!.y;
  const settingsTop = (await page
    .getByTestId("generation-settings")
    .boundingBox())!.y;
  expect(resultTop).toBeLessThan(settingsTop);
  await page.getByText("调整设置", { exact: true }).click();
  await page
    .getByRole("button", { name: "保存到浏览器资源库", exact: true })
    .click();
  await expect(page.getByTestId("generation-settings")).toHaveAttribute("open");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
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

for (const theme of ["light", "dark"] as const) {
  test(`独立姿势检索和编辑在${theme}主题可生成，候选详情按需展示`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120000);
    await page.emulateMedia({ colorScheme: theme });
    await setup(page);
    const libraries: string[] = [];
    const source = poseScene();
    await page.route("**/api/scene-images/poses/search", (route) => {
      libraries.push(route.request().postDataJSON().library);
      return route.fulfill({
        json: {
          matches: [
            {
              poseId: "standing",
              score: 0.7,
              description: {
                zh: "站姿，双臂舒展",
                en: "Standing with arms stretched",
              },
              pose: source,
            },
          ],
        },
      });
    });
    await page.getByLabel("使用姿势参考").check();
    await expect(
      page.getByRole("button", { name: "生成图片", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("姿态检索描述").fill("站姿");
    await page.getByLabel("人物参考图", { exact: true }).selectOption("img1");
    for (const library of ["default", "mixamo", "all"]) {
      await page.getByLabel("动作库检索范围").selectOption(library);
      await page.getByRole("button", { name: "重新检索" }).click();
      await expect(page.getByLabel("选择姿势 站姿，双臂舒展")).toBeVisible();
    }
    expect(libraries).toEqual(["default", "mixamo", "all"]);
    await expect(
      page.getByText("Standing with arms stretched", { exact: true }),
    ).not.toBeVisible();
    await page.getByText("详情", { exact: true }).click();
    await expect(
      page.getByText("Standing with arms stretched", { exact: true }),
    ).toBeVisible();
    await page.getByText("详情", { exact: true }).click();
    await page.getByLabel("选择姿势 站姿，双臂舒展").check();
    await page.getByRole("button", { name: "编辑姿势", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑姿势", exact: true });
    await expect(editor.getByLabel("人物 X", { exact: true })).toBeEnabled({
      timeout: 30000,
    });
    await editor.getByLabel("人物 X", { exact: true }).fill("2");
    await editor.getByLabel("人物 X", { exact: true }).press("Tab");
    await editor.getByRole("button", { name: "应用修改", exact: true }).click();
    await expect(page.getByText("已编辑", { exact: true })).toBeVisible();
    await page.getByLabel("使用姿势参考").uncheck();
    await page.getByLabel("使用姿势参考").check();
    await expect(page.getByText("已编辑", { exact: true })).toBeVisible();
    let submitted: any;
    await page.route("**/api/scene-images/direct", (route) => {
      submitted = route.request().postDataJSON();
      return route.fulfill({
        json: {
          runId: submitted.runId,
          status: "succeeded",
          terminal: true,
          revision: 2,
          submission: submitted,
        },
      });
    });
    await page.screenshot({
      path: testInfo.outputPath("pose-settings.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    await expect(page.getByAltText("生成结果", { exact: true })).toBeVisible();
    expect(submitted.poseEnabled).toBe(true);
    expect(submitted.poseSelection.pose.characters[0].transform.x).toBe(2);
    expect(submitted.characterReferenceAssetId).toBe("img1");
    await expect(page.getByTestId("generation-settings")).not.toHaveAttribute(
      "open",
    );
    await page.screenshot({
      path: testInfo.outputPath("pose-result.png"),
      fullPage: true,
    });
    await page.getByText("调整设置", { exact: true }).click();
    const posedSubmission = submitted;
    await page
      .getByRole("button", { name: "恢复检索姿势", exact: true })
      .click();
    await expect(page.getByText("已编辑", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "编辑姿势", exact: true }).click();
    await expect(editor.getByLabel("人物 X", { exact: true })).toHaveValue(
      "0",
      { timeout: 30000 },
    );
    await editor.getByLabel("人物 X", { exact: true }).fill("1");
    await editor.getByLabel("人物 X", { exact: true }).press("Tab");
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByText("已编辑", { exact: true })).toHaveCount(0);
    expect(posedSubmission.poseSelection.pose.characters[0].transform.x).toBe(
      2,
    );
    await page.getByLabel("使用姿势参考").uncheck();
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    await expect.poll(() => submitted.poseEnabled).toBe(false);
    expect(submitted.poseSelection).toBeNull();
    expect(submitted.width).toBeNull();
  });
}

test("独立页迟到检索不覆盖新范围，删除人物图后必须重新选择", async ({
  page,
}) => {
  await setup(page);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  await page.route("**/api/scene-images/poses/search", async (route) => {
    const { library } = route.request().postDataJSON();
    if (library === "default") {
      entered = true;
      await waiting;
    }
    await route.fulfill({
      json: {
        matches: [
          {
            poseId: library,
            score: 0.7,
            description: { zh: library, en: library },
            pose: { bones: {} },
          },
        ],
      },
    });
  });
  await page.getByLabel("使用姿势参考").check();
  await page.getByLabel("人物参考图", { exact: true }).selectOption("img1");
  await page.getByLabel("姿态检索描述").fill("坐姿");
  await page.getByRole("button", { name: "重新检索" }).click();
  await expect.poll(() => entered).toBe(true);
  await page.getByLabel("动作库检索范围").selectOption("mixamo");
  release();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.getByRole("button", { name: "重新检索" }).click();
  await page.getByLabel("选择姿势 mixamo").check();
  await page.getByRole("button", { name: "移除参考图 1" }).click();
  await expect(page.getByLabel("人物参考图", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "生成图片", exact: true }),
  ).toBeDisabled();
});
