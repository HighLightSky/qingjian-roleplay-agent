import { chromium, test, expect, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

async function createRole(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "创建第一个角色" }).click();
  await page.getByPlaceholder("你想如何称呼这个角色？").fill("林溪");
  await page
    .getByPlaceholder("这个角色是谁，有怎样的经历？")
    .fill("山间旅馆的老板");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
}
async function nav(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await page.getByRole("button", { name: "打开会话导航" }).click();
}
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "消息内容" }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}

test("IME composition survives draft persistence and only committed text is saved", async ({
  page,
  context,
}) => {
  await createRole(page);
  const input = page.getByRole("textbox", { name: "消息内容" });
  await input.focus();
  await input.evaluate((element) => {
    Reflect.set(window, "imeInput", element);
    Reflect.set(window, "draftWrites", []);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "drafts")
        Reflect.get(window, "draftWrites").push(args[0].text);
      return put.apply(this, args);
    };
  });
  let sends = 0;
  await page.route("**/api/chat", (route) => {
    sends++;
    return route.abort();
  });
  // A pending ordinary draft must also pause when IME composition starts.
  await input.fill("前缀：");
  const client = await context.newCDPSession(page);
  await client.send("Input.imeSetComposition", {
    text: "ni",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await page.waitForTimeout(450);
  await expect(input).toHaveValue("前缀：ni");
  expect(await page.evaluate(() => Reflect.get(window, "draftWrites"))).toEqual(
    [],
  );
  await client.send("Input.imeSetComposition", {
    text: "nihao",
    selectionStart: 5,
    selectionEnd: 5,
  });
  await page.waitForTimeout(450);
  await expect(input).toHaveValue("前缀：nihao");
  expect(await page.evaluate(() => Reflect.get(window, "draftWrites"))).toEqual(
    [],
  );
  expect(
    await input.evaluate(
      (element) =>
        document.activeElement === element &&
        Reflect.get(window, "imeInput") === element,
    ),
  ).toBe(true);
  await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 229,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await client.send("Input.insertText", { text: "你好" });
  await expect(input).toHaveValue("前缀：你好");
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "draftWrites")))
    .toEqual(["前缀：你好"]);
  expect(
    await input.evaluate(
      (element) => Reflect.get(window, "imeInput") === element,
    ),
  ).toBe(true);
  expect(sends).toBe(0);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue(
    "前缀：你好",
  );
});

test("LAN HTTP access hydrates, creates IDs and restores the conversation", async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "局域网入口只需验证一次");
  const address = Object.values(networkInterfaces())
    .flat()
    .find((item) => item?.family === "IPv4" && !item.internal)?.address;
  test.skip(!address, "当前环境无局域网 IPv4 地址");
  const port = new URL(testInfo.project.use.baseURL ?? "http://127.0.0.1:3100")
    .port;
  const context = await browser.newContext({
    baseURL: `http://${address}:${port}`,
  });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/chat", (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: 'event: delta\ndata: {"kind":"dialogue","text":"“欢迎回来，旅人。”"}\n\nevent: done\ndata: {"finishReason":"stop"}\n\n',
      }),
    );
    await createRole(page);
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    await send(page, "从局域网访问的故事");
    await expect(
      page.getByText("“欢迎回来，旅人。”", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "从局域网访问的故事", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("“欢迎回来，旅人。”", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
test("chat, shared memory, one-click sessions, theme, drafts and browser recovery", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests: { memories: string[]; history: unknown[] }[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/chat"))
      requests.push(request.postDataJSON());
  });
  await createRole(page);
  await send(page, "你好，旅人");
  await expect(
    page.getByText("（她放下烛台，望向门口。）", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "你好，旅人", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开角色记忆" }).click();
  await page.getByRole("button", { name: "新增", exact: true }).click();
  await page
    .getByRole("textbox", { name: "内容", exact: true })
    .fill("用户希望被称为阿远");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  await expect(
    page.getByText("用户希望被称为阿远", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭记忆" }).click();
  await nav(page);
  await page
    .getByRole("button", { name: "新建对话", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "新对话", exact: true }),
  ).toBeVisible();
  await send(page, "我们再出发吧");
  await expect(
    page.getByText("“欢迎回来，阿远。”", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)?.memories).toEqual(["用户希望被称为阿远"]);
  expect(requests.at(-1)?.history).toEqual([]);
  await page.getByRole("button", { name: "角色与会话菜单" }).click();
  await page.getByRole("menuitem", { name: "重命名对话" }).click();
  await page.getByRole("textbox", { name: "对话标题" }).fill("第二段故事");
  await page.getByRole("button", { name: "保存标题", exact: true }).click();
  await send(page, "还记得我吗");
  await expect(
    page.getByText("“欢迎回来，阿远。”", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "第二段故事", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "消息内容" })
    .fill("还没发出的草稿🌿");
  await expect(
    page.getByText("已保存到本机", { exact: false }).first(),
  ).toBeVisible();
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue(
    "还没发出的草稿🌿",
  );
  await nav(page);
  await page
    .getByRole("button", { name: "设置与数据", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("combobox", { name: "外观" }).selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("heading", { name: "第二段故事", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "打开角色记忆" }).click();
  await page.screenshot({
    path: `/tmp/qingjian-${testInfo.project.name}.png`,
    animations: "disabled",
  });
  if (testInfo.project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
test("stopping and reloading during a stream retain partial content", async ({
  page,
}) => {
  await createRole(page);
  await send(page, "慢慢回复我");
  await expect(page.getByText("“欢迎回来，", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(
    page.getByText("已停止，保留已收到的内容。", { exact: true }),
  ).toBeVisible();
  await send(page, "慢慢回复，随后刷新");
  await expect(
    page.getByText("“欢迎回来，", { exact: true }).last(),
  ).toBeVisible();
  await page.waitForTimeout(700);
  await page.reload();
  await expect(
    page.getByText("上次生成中断，已保留保存的内容。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("“欢迎回来，", { exact: true }).last(),
  ).toBeVisible();
});
test("API errors retain user messages and a second tab cannot mutate data", async ({
  page,
  context,
}) => {
  await createRole(page);
  await send(page, "接口失败");
  await expect(page.getByRole("alert").first()).toContainText(
    "测试模型暂不可用",
  );
  await expect(
    page.getByText("接口失败", { exact: true }).last(),
  ).toBeVisible();
  const second = await context.newPage();
  await second.goto("/");
  await expect(
    second.getByText("另一个标签页正在使用数据", { exact: false }),
  ).toBeVisible();
  await expect(
    second.getByRole("textbox", { name: "消息内容" }),
  ).toBeDisabled();
  await second.close();
});

test("a running reply stays in its original session while navigating", async ({
  page,
}) => {
  await createRole(page);
  await send(page, "原来的故事");
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  await nav(page);
  await page
    .getByRole("button", { name: "新建对话", exact: true })
    .filter({ visible: true })
    .click();
  await send(page, "慢慢回复新的故事");
  await expect(page.getByText("“欢迎回来，", { exact: true })).toBeVisible();
  await nav(page);
  await page
    .getByRole("button", { name: "原来的故事", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "原来的故事", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("另一段对话正在回复", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('[data-role="user"]')
      .getByText("慢慢回复新的故事", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "前往", exact: true }).click();
  await expect(page.getByText("“欢迎回来，", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(
    page.getByText("已停止，保留已收到的内容。", { exact: true }),
  ).toBeVisible();
});

test("backup download, destructive confirmation and import restore the complete story", async ({
  page,
}) => {
  await createRole(page);
  await send(page, "备份里的故事");
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  await nav(page);
  await page
    .getByRole("button", { name: "设置与数据", exact: true })
    .filter({ visible: true })
    .click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出全部", exact: true }).click();
  const download = await downloadEvent;
  const buffer = await readFile((await download.path())!);
  const data = JSON.parse(buffer.toString());
  expect(data.data.characters).toHaveLength(1);
  expect(data.data.sessions).toHaveLength(1);
  expect(data.data.messages).toHaveLength(2);
  await page.getByRole("button", { name: "清空本地数据", exact: true }).click();
  await page.getByRole("textbox", { name: "输入「清空」确认" }).fill("清空");
  await page.getByRole("button", { name: "清空全部", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "创建第一个角色", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "导入备份", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByLabel("导入备份", { exact: true }).setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer,
  });
  await page.getByRole("button", { name: "覆盖恢复", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "备份里的故事", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
});

test("closing and reopening a browser profile restores committed data and drafts", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "磁盘持久化只需验证一次");
  const directory = await mkdtemp(join(tmpdir(), "qingjian-profile-"));
  const options = {
    headless: true,
    baseURL: "http://127.0.0.1:3100",
    viewport: { width: 1280, height: 900 },
  };
  let context = await chromium.launchPersistentContext(directory, options);
  try {
    let page = await context.newPage();
    await createRole(page);
    await send(page, "重开浏览器也记得");
    await expect(
      page.getByText("“欢迎回来，旅人。”", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "消息内容" })
      .fill("写到一半的草稿");
    await expect(
      page.getByText("林溪 · 已保存到本机", { exact: true }),
    ).toBeVisible();
    await context.close();
    context = await chromium.launchPersistentContext(directory, options);
    page = await context.newPage();
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "重开浏览器也记得", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("“欢迎回来，旅人。”", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue(
      "写到一半的草稿",
    );
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
