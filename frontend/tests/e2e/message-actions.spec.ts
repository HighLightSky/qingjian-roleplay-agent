import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.head.append(style);
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "创建第一个角色" }).click();
  await page.getByPlaceholder("你想如何称呼这个角色？").fill("林溪");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
}

async function upload(
  page: Page,
  colors: string[],
  scope = page.locator(".aui-composer-root"),
) {
  const images = await page.evaluate(
    (colors) =>
      colors.map((color) => {
        const canvas = document.createElement("canvas");
        canvas.width = 5;
        canvas.height = 5;
        const context = canvas.getContext("2d")!;
        context.fillStyle = color;
        context.fillRect(0, 0, 5, 5);
        return canvas.toDataURL().split(",")[1];
      }),
    colors,
  );
  const chooser = page.waitForEvent("filechooser");
  await scope.getByRole("button", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles(
    images.map((image, i) => ({
      name: `${colors[i]}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(image, "base64"),
    })),
  );
  await expect(scope.locator(".aui-attachment-tile-uploading")).toHaveCount(0);
}

async function saved(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("roleplay-agent");
      request.onsuccess = () => resolve(request.result);
    });
    const read = (table: string) =>
      new Promise<any[]>((resolve) => {
        const request = db.transaction(table).objectStore(table).getAll();
        request.onsuccess = () => resolve(request.result);
      });
    const result = {
      assets: (await read("assets")).map((a) => a.id),
      messages: await read("messages"),
      drafts: await read("drafts"),
    };
    db.close();
    return result;
  });
}

test("多图同时准备、刷新与发送均保留完整原件", async ({ page }) => {
  await setup(page);
  await upload(page, ["red", "blue", "green", "yellow", "purple"]);
  await expect.poll(async () => (await saved(page)).assets.length).toBe(5);
  await page.reload();
  await expect(page.locator(".aui-composer-attachments img")).toHaveCount(5);
  const chat = page.waitForRequest((request) =>
    request.url().endsWith("/api/chat"),
  );
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const request = (await chat).postDataJSON();
  expect(request.images).toHaveLength(5);
  expect(request.context.input.parts.map((p: any) => p.assetId)).toEqual([
    "img1",
    "img2",
    "img3",
    "img4",
    "img5",
  ]);
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  expect((await saved(page)).assets).toHaveLength(5);
});

test("缺失草稿原图明确报错，移除后保留其他图片并恢复发送", async ({ page }) => {
  await setup(page);
  await upload(page, ["red", "blue"]);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("roleplay-agent");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("assets", "readwrite");
      tx.objectStore("assets").delete("img1");
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "移除缺失图片 img1", exact: true })
    .click();
  await expect(page.locator(".aui-composer-attachments img")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
});

test("失败轮使用铅笔内联编辑，增删图片和刷新不影响普通草稿，原位重发", async ({
  page,
}) => {
  await setup(page);
  let fail = true;
  await page.route("**/api/chat", async (route) => {
    if (fail)
      await route.fulfill({ status: 502, json: { message: "测试正文失败" } });
    else await route.continue();
  });
  await upload(page, ["red"]);
  await page
    .getByRole("textbox", { name: "消息内容", exact: true })
    .fill("旧消息");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "编辑并重发" })).toBeVisible();
  const before = (await saved(page)).messages;
  await page
    .getByRole("textbox", { name: "消息内容", exact: true })
    .fill("下一轮普通草稿");
  await upload(page, ["blue"]);
  await page.getByRole("button", { name: "编辑并重发" }).click();
  const editor = page.locator(".aui-edit-composer-root");
  const input = page.getByRole("textbox", {
    name: "编辑消息内容",
    exact: true,
  });
  await expect(input).toBeEnabled();
  await input.fill("编辑后的消息");
  await editor.getByRole("button", { name: /移除/ }).click();
  await expect
    .poll(async () => (await saved(page)).drafts[0].edit?.parts)
    .toEqual([]);
  await upload(page, ["green"], editor);
  await expect
    .poll(async () => (await saved(page)).drafts[0].edit?.text)
    .toBe("编辑后的消息");
  await page.reload();
  await expect(input).toHaveValue("编辑后的消息");
  await expect(editor.locator(".aui-composer-attachments img")).toHaveCount(1);
  await expect(
    page.getByRole("textbox", { name: "消息内容", exact: true }),
  ).toHaveValue("下一轮普通草稿");
  fail = false;
  const chat = page.waitForRequest((request) =>
    request.url().endsWith("/api/chat"),
  );
  await page.getByRole("button", { name: "重新发送", exact: true }).click();
  const request = (await chat).postDataJSON();
  expect(request.context.input.text).toBe("编辑后的消息");
  expect(request.context.history).toHaveLength(0);
  expect(
    request.context.input.parts.filter((p: any) => p.type === "image"),
  ).toEqual([{ type: "image", assetId: "img3" }]);
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await expect(
    page.getByRole("textbox", { name: "消息内容", exact: true }),
  ).toHaveValue("下一轮普通草稿");
  const after = (await saved(page)).messages;
  expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());
  await page.reload();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "编辑并重发" })).toHaveCount(0);
});

test("取消内联编辑保留原轮次，回收编辑独有图片", async ({ page }) => {
  await setup(page);
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 502, json: { message: "正文失败" } }),
  );
  await page
    .getByRole("textbox", { name: "消息内容", exact: true })
    .fill("原消息");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByRole("button", { name: "编辑并重发" }).click();
  await expect(
    page.getByRole("textbox", { name: "编辑消息内容" }),
  ).toBeEnabled();
  await upload(page, ["red"], page.locator(".aui-edit-composer-root"));
  await page.getByRole("button", { name: "取消编辑" }).click();
  await expect(page.getByRole("textbox", { name: "编辑消息内容" })).toHaveCount(
    0,
  );
  expect((await saved(page)).messages.find((m) => m.role === "user").text).toBe(
    "原消息",
  );
  await expect.poll(async () => (await saved(page)).assets.length).toBe(0);
});

test("复制实际正文、HTTP兼容复制及权限错误均有反馈", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page);
  await page
    .getByRole("textbox", { name: "消息内容", exact: true })
    .fill("复制消息\n第二行");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  await page.locator('[data-slot="aui_user-message-root"]').hover();
  await page.getByRole("button", { name: "复制消息", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("复制消息\n第二行");
  await page
    .locator('[data-slot="aui_assistant-message-root"]')
    .filter({ has: page.locator('[data-slot="turn-token-usage"]') })
    .hover();
  await page.getByRole("button", { name: "复制回复", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("（她放下烛台，望向门口。）\n“欢迎回来，旅人。”");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const original = document.execCommand.bind(document);
    document.execCommand = (command) => {
      (window as any).copiedFallback = (
        document.activeElement as HTMLTextAreaElement
      ).value;
      return original(command);
    };
  });
  await page.getByRole("button", { name: "复制回复", exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedFallback)).toContain(
    "欢迎回来",
  );
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          Promise.reject(new DOMException("拒绝", "NotAllowedError")),
      },
    }),
  );
  await page.getByRole("button", { name: "复制回复", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "复制失败：浏览器拒绝" }),
  ).toBeVisible();
});
