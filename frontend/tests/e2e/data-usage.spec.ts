import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

test.use({ reducedMotion: "reduce" });

async function createRole(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "创建第一个角色" }).click();
  await page.getByPlaceholder("你想如何称呼这个角色？").fill("李白");
  await page.getByPlaceholder("角色是谁，以及与我的关系？").fill("诗人");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
}

async function settings(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await page.getByRole("button", { name: "打开会话导航" }).click();
  await page.getByRole("button", { name: "设置与数据", exact: true }).click();
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "消息内容" }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.locator('[data-operation="state_update"]').last(),
  ).toContainText(/已检查|已更新/);
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
}

test("本地数据标题右侧刷新，存储查询不可用时仍展示统计且没有持久存储入口", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: undefined,
    });
  });
  await createRole(page);
  await send(page, "你好");
  await settings(page);
  const local = page.getByRole("region", { name: "本地数据明细", exact: true });
  await expect(local).toContainText(
    "1 个角色 · 1 段对话 · 2 条消息 · 0 张图片",
  );
  await expect(local).toContainText("当前浏览器环境不支持站点存储用量查询");
  await expect(page.getByText(/持久存储/)).toHaveCount(0);
  const heading = await local
    .getByRole("heading", { name: "本地数据明细" })
    .boundingBox();
  const refresh = await local
    .getByRole("button", { name: "刷新数据" })
    .boundingBox();
  expect(refresh!.x).toBeGreaterThan(heading!.x + heading!.width);
  expect(
    Math.abs(
      refresh!.y + refresh!.height / 2 - (heading!.y + heading!.height / 2),
    ),
  ).toBeLessThan(2);
  const meter = local.getByRole("meter", { name: "李白", exact: true });
  await expect(meter).toHaveAttribute("aria-valuetext", /占.*%/);
  await expect(local.getByRole("meter")).toHaveCount(3);
  await local.getByRole("button", { name: "刷新数据" }).click();
  await expect(local).toContainText("2 条消息");
  await page.getByText("深色", { exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("dialog")).toHaveCSS(
    "background-color",
    "rgb(16, 19, 22)",
  );
  await expect(meter).toBeVisible();
  const box = await local.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: info.outputPath("data-usage-dark.png"),
    animations: "disabled",
  });
});

test("释放缓存保留本地图片与消息，下一轮自动补传且重复点击只发一次请求", async ({
  page,
}) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==",
    "base64",
  );
  const hash = createHash("sha256").update(png).digest("hex");
  const initial = await page.request.post("/api/images/cache/clear", {
    data: { hashes: [hash] },
  });
  expect(initial.ok()).toBeTruthy();
  await createRole(page);
  let uploads = 0,
    clears = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      request.url().endsWith(`/api/images/${hash}`)
    )
      uploads++;
    if (request.url().endsWith("/api/images/cache/clear")) clears++;
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: "map.png", mimeType: "image/png", buffer: png });
  await expect(
    page.getByRole("button", { name: "移除 map.png", exact: true }),
  ).toBeVisible();
  await send(page, "看看这张地图");
  expect(uploads).toBe(1);
  await settings(page);
  const local = page.getByRole("region", { name: "本地数据明细", exact: true });
  const cloud = page.getByRole("region", { name: "后端图片缓存", exact: true });
  await expect(local).toContainText("2 条消息 · 1 张图片");
  await expect(cloud).toContainText("当前浏览器图片对应的缓存 · 1 张");
  await page.route("**/api/images/cache/clear", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });
  await cloud
    .getByRole("button", { name: "释放图片缓存", exact: true })
    .evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
  await expect(cloud).toContainText("已释放 1 张图片缓存");
  await expect(cloud).toContainText("当前浏览器图片对应的缓存 · 0 张");
  expect(clears).toBe(1);
  await expect(local).toContainText("2 条消息 · 1 张图片");
  await expect(
    page.getByRole("button", { name: "查看 map.png", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await page
      .getByRole("dialog", { name: "角色与对话导航" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
  await send(page, "再看看地图里的标记");
  expect(uploads).toBe(2);
});

test("缓存接口不存在时显示HTTP原因，刷新后恢复；占用冲突不会显示清理成功", async ({
  page,
}) => {
  await createRole(page);
  await page.route("**/api/images/cache/stats", (route) =>
    route.fulfill({ status: 404, json: { error: "Not Found" } }),
  );
  await settings(page);
  const cloud = page.getByRole("region", { name: "后端图片缓存", exact: true });
  const local = page.getByRole("region", { name: "本地数据明细", exact: true });
  await expect(cloud.getByRole("alert")).toContainText("HTTP 404");
  await expect(local).toContainText("应用数据估算容量");
  await page.unroute("**/api/images/cache/stats");
  await page.route("**/api/images/cache/stats", (route) =>
    route.fulfill({
      json: {
        imageCount: 1,
        bytes: 1024,
        inUseImageCount: 1,
        inUseBytes: 1024,
      },
    }),
  );
  await page.getByRole("button", { name: "刷新数据" }).click();
  await expect(cloud).toContainText("1.00 KiB");
  await expect(
    cloud.getByRole("meter", { name: "任务使用中", exact: true }),
  ).toHaveAttribute("aria-valuenow", "100");
  await page.route("**/api/images/cache/clear", (route) =>
    route.fulfill({
      status: 409,
      json: {
        code: "IMAGE_IN_USE",
        message: "图片正在被任务使用，请在任务完成后重试",
      },
    }),
  );
  await cloud
    .getByRole("button", { name: "释放图片缓存", exact: true })
    .click();
  await expect(cloud.getByRole("alert")).toHaveText(
    "图片正在被任务使用，请在任务完成后重试",
  );
  await expect(cloud.getByText(/已释放/)).toHaveCount(0);
});
