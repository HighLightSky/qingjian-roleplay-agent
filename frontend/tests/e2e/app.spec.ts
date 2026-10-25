import { chromium, test, expect, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchSnapshot } from "../../lib/chat/dispatch";
import { dispatchResponse } from "../dispatch-fixture";

async function createRole(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "创建第一个角色" }).click();
  await page.getByPlaceholder("你想如何称呼这个角色？").fill("林溪");
  await page
    .getByPlaceholder("角色是谁，以及与我的关系？")
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

test("选图时隐藏思考提示，正文首字前显示角色名与 Reasoning UI，刷新后保持阶段", async ({
  page,
}) => {
  await createRole(page);
  let current: DispatchSnapshot;
  let completed: DispatchSnapshot;
  let subscriptions = 0;
  await page.route("**/api/chat", async (route) => {
    const response = await dispatchResponse(
      route.request().postDataJSON(),
    ).text();
    completed = JSON.parse(response.split("data: ")[1].trim());
    current = {
      ...completed,
      segments: [],
      stages: {
        selection: { name: "selection", status: "running", error: null },
      },
      plan: null,
      body: null,
      state: null,
      terminal: false,
    };
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify(current)}\n\n`,
    });
  });
  await page.route("**/api/chat/*/events", async (route) => {
    subscriptions++;
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify(current)}\n\n`,
    });
  });
  const thinking = page.locator('[data-slot="reasoning-root"][role="status"]');
  const selection = page.locator('[data-operation="selection"]');
  await send(page, "你好");
  await expect(selection).toContainText("正在请求");
  await expect(thinking).toHaveCount(0);
  const previousSubscriptions = subscriptions;
  await page.reload();
  await expect.poll(() => subscriptions).toBeGreaterThan(previousSubscriptions);
  await expect(selection).toContainText("正在请求");
  await expect(thinking).toHaveCount(0);

  current = {
    ...current!,
    plan: completed!.plan,
    stages: {
      selection: completed!.stages.selection,
      body: { name: "body", status: "running", error: null },
    },
  };
  await expect(thinking).toBeVisible();
  await expect(thinking).toHaveText("林溪正在思考中");
  await expect(
    thinking.locator('[data-slot="reasoning-trigger-icon"]'),
  ).toBeVisible();
  await expect(
    thinking.locator('[data-slot="reasoning-trigger-label"]'),
  ).toHaveClass(/shimmer/);
  await page.reload();
  await expect(thinking).toBeVisible();
  await expect(thinking).toHaveText("林溪正在思考中");

  current = { ...current, segments: completed!.segments };
  await expect(page.getByText("她检查地图。", { exact: true })).toBeVisible();
  await expect(thinking).toHaveCount(0);
  current = {
    ...current,
    body: completed!.body,
    stages: {
      ...current.stages,
      body: completed!.stages.body,
      state_update: { name: "state_update", status: "running", error: null },
    },
  };
  await expect(page.locator('[data-operation="state_update"]')).toContainText(
    "正在请求",
  );
  await expect(thinking).toHaveCount(0);
  current = completed!;
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  await expect(thinking).toHaveCount(0);
});

test("上下文环位于32px发送按钮左侧，支持查看预留，本轮usage刷新后保留", async ({
  page,
}) => {
  await createRole(page);
  const ring = page.getByRole("button", { name: "上下文用量", exact: true });
  const sendButton = page.getByRole("button", {
    name: "发送消息",
    exact: true,
  });
  await expect(ring).toBeVisible();
  const layout = await Promise.all([
    ring.boundingBox(),
    sendButton.boundingBox(),
    page.getByRole("button", { name: "图片", exact: true }).boundingBox(),
    page.getByRole("button", { name: /^回复长度：/ }).boundingBox(),
  ]);
  for (const box of layout) expect(Math.round(box!.height)).toBe(32);
  expect(layout[0]!.x + layout[0]!.width).toBeLessThanOrEqual(layout[1]!.x);
  if ((page.viewportSize()?.width ?? 1440) < 768) await ring.tap();
  else await ring.hover();
  await expect(page.getByText("输出预留：8,192 token")).toBeVisible();
  await expect(page.getByText(/精确计数/)).toBeVisible();
  await expect(
    page.locator(
      '[data-slot="context-display-popover"] [data-slot="tooltip-arrow"]',
    ),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "消息内容" }).click();
  await send(page, "你好");
  await expect(
    page.locator('[data-slot="turn-token-usage"]').last(),
  ).toHaveText("输入 12,300 · 输出 780 · 合计 13,080 token");
  await page.reload();
  await expect(
    page.locator('[data-slot="turn-token-usage"]').last(),
  ).toHaveText("输入 12,300 · 输出 780 · 合计 13,080 token");
});

test("达到70%自动压缩前30轮并保留最近10轮，原始历史不删除", async ({
  page,
}) => {
  await createRole(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("roleplay-agent", 10);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(["sessions", "messages"], "readwrite");
      const request = tx.objectStore("sessions").getAll();
      request.onsuccess = () => {
        const session = request.result[0];
        const timestamp = new Date().toISOString();
        for (let i = 0; i < 40; i++) {
          const userId = `old-user-${i}`;
          tx.objectStore("messages").put({
            id: userId,
            sessionId: session.id,
            seq: i * 2 + 1,
            role: "user",
            text: `旧问题${i}`,
            status: "complete",
            checkpointVersion: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          tx.objectStore("messages").put({
            id: `old-assistant-${i}`,
            sessionId: session.id,
            seq: i * 2 + 2,
            role: "assistant",
            replyToMessageId: userId,
            segments: [
              {
                kind: "narration",
                text: "旧剧情中的地图与人物约定。".repeat(1000),
              },
            ],
            usage: {
              status: "unavailable",
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
            },
            status: "complete",
            checkpointVersion: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        }
        tx.objectStore("sessions").put({
          ...session,
          nextMessageSeq: 81,
        });
      };
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
  await page.reload();
  let input:
    { summary: { throughSeq: number }; history: { seq: number }[] } | undefined;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/chat"))
      input = request.postDataJSON().context;
  });
  await send(page, "继续");
  await expect(
    page.locator('[data-slot="turn-token-usage"]').last(),
  ).toContainText("合计 13,080 token");
  expect(input!.summary.throughSeq).toBe(60);
  expect(input!.history.map((m) => m.seq)).toEqual(
    Array.from({ length: 20 }, (_, i) => i + 61),
  );
  await expect(page.locator('[data-operation="compaction"]')).toContainText(
    "已压缩较早剧情",
  );
  const count = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("roleplay-agent", 10);
      r.onsuccess = () => resolve(r.result);
    });
    try {
      return await new Promise<number>((resolve) => {
        const r = db.transaction("messages").objectStore("messages").count();
        r.onsuccess = () => resolve(r.result);
      });
    } finally {
      db.close();
    }
  });
  expect(count).toBe(82);
});

async function chooseSetting(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: new RegExp(`^${label}：`) }).click();
  await page
    .getByRole("menuitemradio", { name: new RegExp(`^${option}`) })
    .click();
  await expect(
    page.getByRole("button", { name: `${label}：${option}`, exact: true }),
  ).toBeEnabled();
}

test("三字段角色支持仅名字创建、草稿恢复、快照隔离与复制", async ({ page }) => {
  const requests: {
    character: {
      name: string;
      identity: string;
      description: string;
      profileVersion: number;
    };
  }[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/chat"))
      requests.push(request.postDataJSON().context);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "创建第一个角色" }).click();
  await expect(page.getByRole("dialog").getByRole("textbox")).toHaveCount(3);
  await expect(
    page.getByPlaceholder("角色是谁，以及与我的关系？"),
  ).not.toHaveAttribute("maxlength");
  await expect(
    page.getByPlaceholder("自由描述经历、性格、说话方式和世界背景"),
  ).not.toHaveAttribute("maxlength");
  await page.getByPlaceholder("你想如何称呼这个角色？").fill("林溪");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(0);

  async function edit() {
    await page.getByRole("button", { name: "角色与会话菜单" }).click();
    await page
      .getByRole("menuitem", { name: "编辑角色设定", exact: true })
      .click();
  }
  await edit();
  await page
    .getByPlaceholder("角色是谁，以及与我的关系？")
    .fill("旅馆老板，也是我的旧友");
  await page
    .getByPlaceholder("自由描述经历、性格、说话方式和世界背景")
    .fill("谨慎好奇，说话直接。");
  await page.getByRole("button", { name: "暂时关闭", exact: true }).click();
  await edit();
  await expect(page.getByPlaceholder("角色是谁，以及与我的关系？")).toHaveValue(
    "旅馆老板，也是我的旧友",
  );
  await page.reload();
  await edit();
  await expect(
    page.getByPlaceholder("自由描述经历、性格、说话方式和世界背景"),
  ).toHaveValue("谨慎好奇，说话直接。");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();

  await send(page, "旧会话仍然使用创建时的设定");
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)!.character).toMatchObject({
    name: "林溪",
    identity: "",
    description: "",
  });
  await nav(page);
  await page
    .getByRole("button", { name: "新建对话", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(0);
  await send(page, "新会话使用新设定");
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)!.character).toMatchObject({
    name: "林溪",
    identity: "旅馆老板，也是我的旧友",
    description: "谨慎好奇，说话直接。",
  });

  await page.getByRole("button", { name: "角色与会话菜单" }).click();
  await page
    .getByRole("menuitem", { name: "复制为新角色", exact: true })
    .click();
  await expect(page.getByPlaceholder("你想如何称呼这个角色？")).toHaveValue(
    "林溪（副本）",
  );
  await expect(page.getByPlaceholder("角色是谁，以及与我的关系？")).toHaveValue(
    "旅馆老板，也是我的旧友",
  );
  await expect(
    page.getByPlaceholder("自由描述经历、性格、说话方式和世界背景"),
  ).toHaveValue("谨慎好奇，说话直接。");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(0);
});

test("dialogue and narration retain their styles and typed history across turns and reloads", async ({
  page,
}) => {
  const requests: { history: { role: string; text: string }[] }[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/chat"))
      requests.push(request.postDataJSON().context);
  });
  await createRole(page);
  for (let turn = 1; turn <= 4; turn++) {
    await send(page, `第${turn}轮，看看地图`);
    await expect(
      page.getByRole("button", { name: "发送消息", exact: true }),
    ).toBeVisible();
    await expect.poll(() => requests.length).toBe(turn);
    expect(
      requests
        .at(-1)!
        .history.filter((message) => message.role === "assistant")
        .map(({ role, text }) => ({ role, text })),
    ).toEqual(
      Array.from({ length: turn - 1 }, () => ({
        role: "assistant",
        text: "[描写]（她放下烛台，望向门口。）\n[台词]“欢迎回来，旅人。”",
      })),
    );
    const dialogue = page.getByText("“欢迎回来，旅人。”", { exact: true });
    const narration = page.getByText("（她放下烛台，望向门口。）", {
      exact: true,
    });
    await expect(dialogue).toHaveCount(turn);
    await expect(narration).toHaveCount(turn);
    await expect(dialogue.last()).toHaveClass(/bg-accent/);
    await expect(narration.last()).not.toHaveClass(/bg-accent/);
    if (turn === 2) await page.reload();
  }
});

test("interaction settings persist globally across sessions, characters and reloads", async ({
  page,
}) => {
  const requests: {
    interactionSettings: { replyLength: string; narrativeMode: string };
  }[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/chat"))
      requests.push(request.postDataJSON().context);
  });
  await createRole(page);
  await expect(
    page.getByRole("button", { name: "回复长度：标准", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "叙事推进：场景推进", exact: true }),
  ).toBeVisible();
  await chooseSetting(page, "回复长度", "详细");
  await chooseSetting(page, "叙事推进", "频繁互动");
  await expect.poll(() => requests.length).toBe(0);
  await send(page, "第一段故事");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)?.interactionSettings).toEqual({
    replyLength: "detailed",
    narrativeMode: "interactive",
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "回复长度：详细", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "叙事推进：频繁互动", exact: true }),
  ).toBeVisible();
  await nav(page);
  await page
    .getByRole("button", { name: "新建对话", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("button", { name: "回复长度：详细", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "叙事推进：频繁互动", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "角色与会话菜单" }).click();
  await page
    .getByRole("menuitem", { name: "复制为新角色", exact: true })
    .click();
  await page.getByPlaceholder("你想如何称呼这个角色？").fill("顾川");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "回复长度：详细", exact: true }),
  ).toBeVisible();
  await chooseSetting(page, "回复长度", "简短");
  await nav(page);
  await page
    .getByRole("button", { name: "切换角色", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: /^林溪/ }).click();
  await expect(
    page.getByRole("button", { name: "回复长度：简短", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "叙事推进：频繁互动", exact: true }),
  ).toBeVisible();
  await send(page, "全局设置仍然生效");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)?.interactionSettings).toEqual({
    replyLength: "short",
    narrativeMode: "interactive",
  });
});

test("changing settings during generation affects only the next request", async ({
  page,
}) => {
  const requests: {
    interactionSettings: { replyLength: string; narrativeMode: string };
  }[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/chat"))
      requests.push(request.postDataJSON().context);
  });
  await createRole(page);
  await send(page, "慢慢回复，我把地图递给她");
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toBeVisible();
  await chooseSetting(page, "回复长度", "详细");
  await chooseSetting(page, "叙事推进", "频繁互动");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].interactionSettings).toEqual({
    replyLength: "standard",
    narrativeMode: "scene",
  });
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  await send(page, "下一段采用新的设置");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].interactionSettings).toEqual({
    replyLength: "detailed",
    narrativeMode: "interactive",
  });
});

test("a failed settings write keeps the previous UI choice", async ({
  page,
}) => {
  await createRole(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "settings")
        throw new DOMException("设置保存测试失败", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await page
    .getByRole("button", { name: "回复长度：标准", exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: /^详细/ }).click();
  await expect(
    page.getByRole("button", { name: "回复长度：标准", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("设置保存测试失败", { exact: true }),
  ).toBeVisible();
});

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
  const requests: {
    state: { memories: { value: { content: string } }[] };
    history: unknown[];
  }[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/chat"))
      requests.push(request.postDataJSON().context);
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
  await page.getByRole("button", { name: "打开剧情与记忆" }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await page.getByRole("button", { name: "新增记忆", exact: true }).click();
  await page
    .getByRole("textbox", { name: "记忆内容", exact: true })
    .fill("用户希望被称为阿远");
  await page
    .getByRole("combobox", { name: "使用范围" })
    .selectOption("character");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByText("用户希望被称为阿远", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭剧情与记忆" }).click();
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
  expect(requests.at(-1)?.state.memories.map((m) => m.value.content)).toEqual([
    "用户希望被称为阿远",
  ]);
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
  await page.getByText("深色", { exact: true }).click();
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
  await page.getByRole("button", { name: "打开剧情与记忆" }).click();
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
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("“欢迎回来，", { exact: true }).last(),
  ).toBeVisible();
});
test("空正文错误明确展示原因和完整诊断信息，刷新后仍可查看", async ({
  page,
}) => {
  await createRole(page);
  let runId = "";
  await page.route("**/api/chat/*/ack", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/chat", async (route) => {
    const request = route.request().postDataJSON();
    runId = request.runId;
    const detail =
      "java.io.IOException: 正文生成失败：模型正常结束，但正文为空；finish_reason=stop；本次输出上限=8192 token；输入 token=100；输出 token=12；总 token=112；已返回正文=0 字符";
    const snapshot = {
      runId,
      revision: 1,
      segments: [],
      stages: { body: { name: "body", status: "failed", error: detail } },
      budget: null,
      plan: null,
      body: {
        finishReason: "stop",
        usage: {
          status: "reported",
          inputTokens: 100,
          outputTokens: 12,
          totalTokens: 112,
        },
      },
      state: null,
      terminal: true,
      error: detail,
    };
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
    });
  });
  await send(page, "触发空回复");
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "模型已正常结束，但没有返回有效正文" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("本轮未进行状态整理。");
  await expect(alert).toContainText("finish_reason=stop");
  await expect(alert).toContainText("已返回正文=0 字符");
  await expect(alert).toContainText(`任务 ID：${runId}`);
  await page.reload();
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(`任务 ID：${runId}`);
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

test("switching sessions cancels the active run and retains its partial reply", async ({
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
  await expect(
    page.getByRole("heading", { name: "新对话", exact: true }),
  ).toBeVisible();
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
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "消息内容" }).fill("切换后可发送");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .locator('[data-role="user"]')
      .getByText("慢慢回复新的故事", { exact: true }),
  ).toHaveCount(0);
  await nav(page);
  await page
    .getByRole("button", { name: "慢慢回复新的故事", exact: true })
    .filter({ visible: true })
    .click();
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
    baseURL: testInfo.project.use.baseURL,
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

test("image drafts, first send, history selection and settings gallery survive reload", async ({
  page,
}) => {
  const calls: { path: string; body: any }[] = [];
  page.on("request", (request) => {
    if (
      ["/api/chat", "/api/context/inspect", "/api/state/update"].some((p) =>
        request.url().endsWith(p),
      )
    )
      calls.push({
        path: new URL(request.url()).pathname,
        body: request.postDataJSON(),
      });
  });
  await createRole(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "map.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(
    page.getByRole("button", { name: "移除 map.png", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".aui-attachment-tile-uploading")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".aui-composer-attachments img")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.locator('[data-slot="turn-token-usage"]').last(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  expect(calls.filter((c) => c.path === "/api/chat")).toHaveLength(1);
  const first = calls.find((c) => c.path === "/api/chat")!.body;
  expect(first.context.visual.imagePayloads).toHaveLength(0);
  expect(first.images[0]).toMatchObject({ assetId: "img1" });
  expect(first.images[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  await send(page, "看看地图里的标记");
  await expect(page.locator('[data-operation="state_update"]')).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  expect(calls.filter((c) => c.path === "/api/chat")).toHaveLength(2);
  expect(calls.filter((c) => c.path !== "/api/chat")).toHaveLength(0);
  expect(
    calls.filter((c) => c.path === "/api/chat").at(-1)!.body.context.visual
      .imagePayloads,
  ).toHaveLength(0);
  await send(page, "不需要图片");
  await expect(
    page.locator('[data-operation="selection"]').last(),
  ).toContainText("本轮无需历史图");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  await nav(page);
  await page.getByRole("button", { name: "设置与数据", exact: true }).click();
  await page.getByRole("button", { name: "查看 map.png", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "map.png", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("3 × 2", { exact: false })).toBeVisible();
});

test("ambiguous image selection retains submitted input and exposes candidates", async ({
  page,
}) => {
  await createRole(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "map.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(
    page.getByRole("button", { name: "移除 map.png", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".aui-attachment-tile-uploading")).toHaveCount(0);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  await page.route("**/api/chat", async (route) => {
    const request = route.request().postDataJSON();
    const plan = {
      operationId: request.context.operationId,
      status: "ambiguous",
      selectedHistoricalImages: [],
      candidateAssetIds: request.context.visual.assetCatalog.map(
        (a: any) => a.assetId,
      ),
      message: "请说明你指哪张图片。",
      contextFingerprint: "fixture",
    };
    const snapshot = {
      runId: request.runId,
      revision: 1,
      segments: [],
      stages: {
        selection: {
          name: "selection",
          status: "failed",
          error: plan.message,
          plan,
        },
      },
      budget: null,
      plan,
      body: null,
      state: null,
      terminal: true,
      error: plan.message,
    };
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
    });
  });
  await send(page, "再看一下之前那张");
  await expect(
    page.getByText("请说明你指哪张图片。", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue("");
  await expect(page.locator('[data-role="user"]')).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue("");
  await expect(page.locator('[data-role="user"] img')).toBeVisible();
});

test("图库按图片编号数值排序后分页，img10不会排在img2之前", async ({
  page,
}) => {
  await createRole(page);
  await page.evaluate(async () => {
    const assets = [];
    for (let index = 1; index <= 13; index++) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.fillStyle = `rgb(${index}, 0, 0)`;
      context.fillRect(0, 0, 1, 1);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!), "image/png"),
      );
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
      );
      assets.push({
        id: `img${index}`,
        sha256: Array.from(digest, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
        mimeType: "image/png",
        byteSize: blob.size,
        width: 1,
        height: 1,
        displayName: `image-${index}.png`,
        originalBlob: blob,
        createdAt: new Date().toISOString(),
      });
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("roleplay-agent", 10);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(["assets", "settings"], "readwrite");
      for (const asset of assets) tx.objectStore("assets").put(asset);
      tx.objectStore("settings").put({
        key: "imageAssetSequence",
        value: "13",
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
  await nav(page);
  await page.getByRole("button", { name: "设置与数据", exact: true }).click();
  await expect(page.getByRole("button", { name: /^查看 image-/ })).toHaveText(
    Array.from({ length: 12 }, (_, index) => `image-${index + 1}.png`),
  );
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("button", { name: /^查看 image-/ })).toHaveText([
    "image-13.png",
  ]);
  await page
    .getByRole("button", { name: "查看 image-13.png", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "image-13.png", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "image-13.png", exact: true }).last(),
  ).toBeVisible();
});

test("retrying a failed reply keeps one saved user input", async ({ page }) => {
  await createRole(page);
  let fail = true;
  await page.route("**/api/chat", async (route) => {
    if (fail) {
      await route.fulfill({
        status: 502,
        json: { code: "MODEL_ERROR", message: "临时失败，可重试" },
      });
    } else await route.continue();
  });
  await send(page, "重试这条消息");
  await expect(
    page.getByRole("button", { name: "重试回复", exact: true }),
  ).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "重试回复", exact: true }).click();
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
});

test("自动整理过程可展开，结果持久化且只有统一人工维护入口", async ({
  page,
}) => {
  await createRole(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await send(
    page,
    "自动整理测试，慢慢整理：我们到了旅馆，我叫阿远，要寻找哥哥",
  );
  await expect(
    page.getByRole("button", { name: "整理视觉、剧情、记忆与目标：正在请求" }),
  ).toBeVisible();
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  const result = page.getByRole("button", {
    name: "已更新：剧情 1 项，记忆 1 项，目标 1 项",
  });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByText("依据：本轮明确说明").first()).toBeVisible();
  await expect(
    page
      .locator('[data-slot="change-current"]')
      .getByText("寻找失踪的哥哥", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("无需更新。", { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "记忆变更" })
      .getByText("查看原内容", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(result).toBeVisible();
  await page.getByRole("button", { name: "打开剧情与记忆" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("旅馆");
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("用户希望被称为阿远");
  await page.getByRole("tab", { name: "目标", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("寻找失踪的哥哥");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("combobox", { name: "目标状态" }).selectOption("paused");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("暂停");
  await page.getByRole("button", { name: "关闭剧情与记忆" }).click();
  await expect(page.getByRole("button", { name: "加入角色记忆" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "角色与会话菜单" }).click();
  await expect(page.getByRole("menuitem", { name: "整理剧情" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await send(page, "普通寒暄");
  await expect(
    page.getByRole("button", {
      name: "已检查，剧情、记忆和目标无变化",
      exact: true,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("精简目标详情、双方剧情状态、折叠消息预览及手动星标持久化", async ({
  page,
}) => {
  await createRole(page);
  await send(
    page,
    "自动整理测试，人物状态测试：我们来到旅馆寻找哥哥，她穿灰外套且手腕受伤，我穿校服并明确说很紧张，柜台上有登记册。",
  );
  await expect(
    page.getByRole("button", {
      name: "已更新：剧情 4 项，记忆 1 项，目标 1 项",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开剧情与记忆" }).click();
  const panel = page.getByRole("tabpanel");
  await expect(
    panel.locator('[data-story-field="characterState"]'),
  ).toContainText("灰色外套，神情平静，手腕受伤。");
  await expect(panel.locator('[data-story-field="userState"]')).toContainText(
    "白色校服，自述紧张",
  );
  await expect(panel).not.toContainText("自动整理");
  await expect(panel).not.toContainText("人工修改");
  await expect(panel.getByRole("img", { name: "手动修改" })).toHaveCount(0);
  const references = panel.locator(
    '[data-story-field="characterState"] details',
  );
  await expect(references).not.toHaveAttribute("open");
  await expect(
    references.getByRole("button", { name: /^消息1：/ }),
  ).not.toBeVisible();
  await references.locator("summary").focus();
  await page.keyboard.press("Enter");
  const messageLink = references.getByRole("button", {
    name: /^消息1：自动整理测试，人物状态测试：我们来到旅馆/,
  });
  await expect(messageLink).toBeVisible();
  await expect(
    references.getByRole("button", {
      name: /^消息2：（她放下烛台，望向门口。）/,
    }),
  ).toBeVisible();
  await messageLink.click();
  await expect(
    page.getByRole("button", { name: "关闭剧情与记忆", exact: true }),
  ).not.toBeVisible();
  await expect(page.locator('[data-role="user"]')).toBeInViewport();
  await page.getByRole("button", { name: "打开剧情与记忆" }).click();
  await page.getByRole("button", { name: "修改剧情" }).click();
  await page
    .getByRole("textbox", { name: "我的状态", exact: true })
    .fill("白色校服，明确说已放松，身体无变化。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    panel
      .locator('[data-story-field="userState"]')
      .getByRole("img", { name: "手动修改" }),
  ).toBeVisible();
  await expect(
    panel
      .locator('[data-story-field="characterState"]')
      .getByRole("img", { name: "手动修改" }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "目标", exact: true }).click();
  await expect(panel.locator("h3")).toHaveText("寻找失踪的哥哥");
  await expect(panel.locator("h3 + [data-goal-status]")).toHaveText("进行中");
  await expect(panel.locator("dt")).toHaveText(["当前关注点", "完成过程"]);
  await expect(panel).toContainText("为了寻找哥哥来到旅馆");
  await expect(panel.locator("details")).not.toHaveAttribute("open");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(panel.getByRole("textbox")).toHaveCount(3);
  await panel
    .getByRole("textbox", { name: "当前关注点", exact: true })
    .fill("继续询问掌柜");
  await panel
    .getByRole("textbox", { name: "完成过程", exact: true })
    .fill("为了寻找哥哥来到旅馆，已看到登记册和他留下的纸条。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "关闭剧情与记忆" }).click();
  const nextRequest = page.waitForRequest((request) =>
    request.url().endsWith("/api/chat"),
  );
  await send(
    page,
    "目标进展测试：掌柜确认哥哥昨天离店，并留下前往码头的信息。",
  );
  const body = (await nextRequest).postDataJSON();
  expect(body.context.state.goals[0].value).toEqual({
    description: "寻找失踪的哥哥",
    status: "active",
    currentFocus: "继续询问掌柜",
    progressSummary: "为了寻找哥哥来到旅馆，已看到登记册和他留下的纸条。",
  });
  expect(body.context.state.story.userState).toContain("已放松");
  await expect(
    page.getByRole("button", { name: "已更新：目标 1 项" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "已更新：目标 1 项", exact: true })
    .click();
  const goalChanges = page.getByRole("region", { name: "目标变更" });
  await expect(
    goalChanges.locator('[data-slot="change-current"]'),
  ).toContainText("核实码头消息");
  await expect(
    goalChanges.locator('[data-slot="change-before"]'),
  ).not.toBeVisible();
  await goalChanges.getByText("查看原内容", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    goalChanges.locator('[data-slot="change-before"]'),
  ).toContainText("继续询问掌柜");
  await page.reload();
  await page.getByRole("button", { name: "打开剧情与记忆" }).click();
  await expect(
    panel
      .locator('[data-story-field="userState"]')
      .getByRole("img", { name: "手动修改" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "目标", exact: true }).click();
  await expect(panel).toContainText(
    "为了寻找哥哥来到旅馆，已看到登记册和他留下的纸条。掌柜确认哥哥昨天离店，留下前往码头的信息。",
  );
  await expect(panel).toContainText("核实码头消息");
  await expect(panel.locator("details[open]")).toHaveCount(0);
});

test("整理失败保留正文并仅重试整理，刷新后仍可展开", async ({ page }) => {
  await createRole(page);
  let fail = true;
  let chatCalls = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/chat")) chatCalls++;
  });
  await page.route("**/api/state/update", async (route) => {
    if (fail)
      await route.fulfill({
        status: 502,
        json: { message: "整理服务暂不可用" },
      });
    else await route.continue();
  });
  await send(page, "这一轮检查失败");
  const operation = page.getByRole("button", {
    name: "正文已保存，整理待重试",
    exact: true,
  });
  await expect(operation).toBeVisible();
  await operation.click();
  await expect(
    page.getByText("“欢迎回来，旅人。”", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重试回复", exact: true }),
  ).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "重试此步骤", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "已检查，剧情、记忆和目标无变化",
      exact: true,
    }),
  ).toBeVisible();
  expect(chatCalls).toBe(1);
  await page.reload();
  await page
    .getByRole("button", {
      name: "已检查，剧情、记忆和目标无变化",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("已检查消息范围：1—2", { exact: true }),
  ).toBeVisible();
});

test("角色照片草稿恢复、首次原图、后续选图与旧会话快照", async ({ page }) => {
  const chats: any[] = [];
  let inspections = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/chat"))
      chats.push(request.postDataJSON().context);
    if (request.url().endsWith("/api/context/inspect")) inspections++;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "创建第一个角色" }).click();
  await page.getByPlaceholder("你想如何称呼这个角色？").fill("林溪");
  await page
    .getByPlaceholder("自由描述经历、性格、说话方式和世界背景")
    .fill("银发，谨慎好奇。");
  await page.getByLabel("选择角色形象照片", { exact: true }).setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(
    page.getByRole("img", { name: "角色形象照片", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "暂时关闭", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "创建第一个角色" }).click();
  await expect(
    page.getByRole("img", { name: "角色形象照片", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByPlaceholder("自由描述经历、性格、说话方式和世界背景"),
  ).toHaveValue("银发，谨慎好奇。");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await nav(page);
  const switcher = page
    .getByRole("button", { name: "切换角色", exact: true })
    .filter({ visible: true });
  await expect(
    switcher.getByRole("img", { name: "林溪的形象缩略图" }),
  ).toBeVisible();
  await switcher.click();
  const library = page.getByRole("dialog").last();
  await expect(
    library.getByRole("img", { name: "林溪的形象缩略图" }),
  ).toBeVisible();
  await library.getByRole("button", { name: "关闭", exact: true }).click();
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await page
      .getByRole("dialog", { name: "角色与对话导航" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
  await send(page, "你好");
  await expect(page.locator('[data-operation="state_update"]')).toContainText(
    "已记录 1 张图片",
  );
  expect(inspections).toBe(0);
  const first = chats[0];
  expect(first.character.appearancePhotoAssetId).toBe("img1");
  expect(first.visual.imagePayloads).toHaveLength(0);
  expect(first.visual.assetCatalog[0].sources[0].type).toBe("character_photo");
  expect(first.input.parts).toBeUndefined();
  await send(page, "不需要图片");
  await expect(
    page.locator('[data-operation="selection"]').last(),
  ).toContainText("本轮无需历史图");
  expect(inspections).toBe(0);
  await expect.poll(() => chats.length).toBe(2);
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  expect(chats.at(-1).visual.imagePayloads).toHaveLength(0);
  await page.reload();
  await send(page, "她耳环上的文字是什么？");
  await expect(page.locator('[data-operation="state_update"]')).toHaveCount(3);
  await expect(
    page.locator('[data-operation="state_update"]').last(),
  ).toContainText("已检查，剧情、记忆和目标无变化");
  expect(chats.at(-1).visual.assetCatalog[0].assetId).toBe(
    first.character.appearancePhotoAssetId,
  );
  await page.getByRole("button", { name: "角色与会话菜单" }).click();
  await page
    .getByRole("menuitem", { name: "编辑角色设定", exact: true })
    .click();
  await page.getByRole("button", { name: "移除照片", exact: true }).click();
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await send(page, "继续核对照片");
  await expect(page.locator('[data-operation="state_update"]')).toHaveCount(4);
  await expect(
    page.locator('[data-operation="state_update"]').last(),
  ).toContainText("已检查，剧情、记忆和目标无变化");
  expect(chats.at(-1).character.appearancePhotoAssetId).toBe(
    first.character.appearancePhotoAssetId,
  );
  await nav(page);
  await page
    .getByRole("button", { name: "新建对话", exact: true })
    .filter({ visible: true })
    .click();
  await send(page, "你好");
  await expect(
    page.locator('[data-slot="turn-token-usage"]').last(),
  ).toBeVisible();
  expect(chats.at(-1).character.appearancePhotoAssetId).toBeUndefined();
});
