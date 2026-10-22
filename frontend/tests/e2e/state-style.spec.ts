import { test, expect } from "@playwright/test";
import type { DispatchSnapshot } from "../../lib/chat/dispatch";
import { dispatchResponse } from "../dispatch-fixture";

test("剧情记忆目标主题样式、长内容与事实类别交互", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "创建第一个角色" }).click();
  await page.getByPlaceholder("你想如何称呼这个角色？").fill("李白");
  await page.getByRole("button", { name: "保存角色", exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();

  const longMemory =
    "我们约定沿江寻找残碑的来历，先向码头的船夫核实线索，再去旧堤寻找原址。".repeat(
      5,
    );
  await page.route("**/api/chat", async (route) => {
    const request = route.request().postDataJSON();
    const response = await dispatchResponse(request).text();
    const snapshot: DispatchSnapshot = JSON.parse(
      response.split("data: ")[1].trim(),
    );
    const result = snapshot.state!;
    const base = {
      action: "create" as const,
      expectedVersion: 0,
      before: null,
      reason: "本轮明确说明",
      sourceMessageIds: [request.user.id],
    };
    result.storyChanges = [
      {
        ...base,
        action: "update",
        id: "location",
        expectedVersion: request.context.state.sessionVersion,
        before: request.context.state.story.location,
        value: "左岸小码头，岸边土路旁",
      },
      {
        ...base,
        action: "update",
        id: "presentCharacters",
        expectedVersion: request.context.state.sessionVersion,
        before: request.context.state.story.presentCharacters,
        value: ["李白", "我", "挑桶女子", "在码头修船的老船夫"],
      },
      {
        ...base,
        action: "update",
        id: "items",
        expectedVersion: request.context.state.sessionVersion,
        before: request.context.state.story.items,
        value: [
          "粗陶酒壶，李白持有",
          "路边残碑，断成两截，碑底有木桩与沟槽",
          "一封没有空格的长编号" + "abcdef".repeat(20),
        ],
      },
    ];
    result.memoryChanges = (
      ["established", "claim", "hypothesis"] as const
    ).map((epistemicStatus, index) => ({
      ...base,
      id: `memory-style-${index}`,
      value: {
        content:
          index === 0
            ? longMemory
            : index === 1
              ? "船夫说残碑原先立在旧堤。"
              : "残碑可能记录过一次修堤的经过。",
        scope: "session",
        kind: index === 0 ? "agreement" : "fact",
        epistemicStatus,
        status: "active",
      },
    }));
    result.goalChanges = (
      [
        "active",
        "blocked",
        "completed",
        "paused",
        "candidate",
        "abandoned",
      ] as const
    ).map((status, index) => ({
      ...base,
      id: `goal-style-${index}`,
      value: {
        description: [
          "查清残碑的来历",
          "寻找失踪的碑文拓本",
          "辨认碑底的木桩",
          "拜访旧堤的守堤人",
          "沿江寻找相似石碑",
          "重走已经坍塌的旧路",
        ][index],
        status,
        currentFocus: "向船夫核实旧堤位置与迁碑经过",
        progressSummary:
          "已经辨认出残碑上的修堤字样，挑桶女子提供了原址线索，接下来需要核对船夫的见闻。",
      },
    }));
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
    });
  });
  await page
    .getByRole("textbox", { name: "消息内容" })
    .fill("我们到了码头，一起调查残碑的来历。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const updated = page.getByRole("button", {
    name: "已更新：剧情 3 项，记忆 3 项，目标 6 项",
    exact: true,
  });
  await expect(updated).toBeVisible();
  await updated.click();
  await expect(page.getByRole("region", { name: "记忆变更" })).toContainText(
    longMemory,
  );
  await expect(
    page.locator('[data-slot="change-before"]').first(),
  ).not.toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("updated-light.png"),
    animations: "disabled",
  });
  await updated.click();
  await page.getByRole("button", { name: "打开剧情与记忆" }).click();
  const panel = page.getByRole("tabpanel");
  await expect(
    panel.locator(
      '[data-story-field="presentCharacters"] [data-slot="memory-chips"]',
    ),
  ).toContainText("挑桶女子");
  await expect(panel.locator('[data-story-field="items"] li')).toHaveCount(3);
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(panel).toContainText(longMemory);
  for (const [label, explanation] of [
    ["已确认", "故事中已确立的事实。"],
    ["陈述", "来自某人的陈述，不代表内容已经证实。"],
    ["推测", "尚未证实的推测，需要后续依据。"],
  ]) {
    const marker = panel.getByRole("button", {
      name: `事实类别：${label}`,
      exact: true,
    });
    if (testInfo.project.name === "mobile") await marker.tap();
    else await marker.focus();
    await expect(
      page.getByRole("tooltip", { name: explanation, exact: true }),
    ).toBeVisible();
    await expect(marker).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
  }

  for (const mode of ["light", "dark"]) {
    for (const color of [
      "teal",
      "magenta",
      "pink",
      "violet",
      "blue",
      "orange",
    ]) {
      await page.evaluate(
        ({ mode, color }) => {
          document.documentElement.classList.toggle("dark", mode === "dark");
          document.documentElement.dataset.themeColor = color;
        },
        { mode, color },
      );
      for (const tab of ["剧情", "记忆", "目标"]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        await expect(
          page.getByRole("tab", { name: tab, exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(
          await panel.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        if (
          (color === "blue" && mode === "light") ||
          (color === "violet" && mode === "dark")
        ) {
          await page.screenshot({
            path: testInfo.outputPath(`${mode}-${tab}.png`),
            animations: "disabled",
          });
        }
      }
    }
  }
  for (const status of [
    "active",
    "blocked",
    "completed",
    "paused",
    "candidate",
    "abandoned",
  ]) {
    await expect(
      panel.locator(`[data-goal-status="${status}"] svg`),
    ).toHaveCount(1);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (testInfo.project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 844 });
    for (const tab of ["剧情", "记忆", "目标"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      expect(
        await panel.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    }
    await page.screenshot({
      path: testInfo.outputPath("mobile-320.png"),
      animations: "disabled",
    });
  }
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(
    panel.locator('[data-slot="memory-chips"] > div > span').first(),
  ).toHaveCSS("animation-name", "none");
  await panel.getByRole("button", { name: "删除", exact: true }).last().click();
  await expect(
    panel.getByText("残碑可能记录过一次修堤的经过。", { exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
