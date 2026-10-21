// Test-only HTTP fixture with the existing Spring Boot SSE contract.
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

createServer(async (request, response) => {
  if (request.url === "/health") {
    response.end("ok");
    return;
  }
  if (request.url === "/api/capabilities") {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        contextWindowTokens: 193024,
        outputReserveTokens: 8192,
        safetyTokens: 1024,
        compactionTriggerRatio: 0.7,
        compactionTargetRatio: 0.5,
        retainedTurns: 10,
        compactionMaxBatches: 8,
        visionSupported: true,
        mimeTypes: ["image/png", "image/jpeg"],
        maxImages: 4,
        maxImageBytes: 10485760,
        maxPixels: 20000000,
        maxRequestBytes: 67108864,
      }),
    );
    return;
  }
  if (
    request.url === "/api/context/budget" ||
    request.url === "/api/context/compact"
  ) {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const data = JSON.parse(raw);
    const context = data.context;
    const inputTokens = 500 + Math.ceil(JSON.stringify(context).length / 3);
    const starts = context.history
      .map((m, i) => (m.role === "user" ? i : -1))
      .filter((i) => i >= 0);
    const end =
      starts.length > 10
        ? context.history[starts[starts.length - 10] - 1].seq
        : context.summary.throughSeq;
    const budget = {
      inputTokens,
      contextWindowTokens: 193024,
      usageRatio: inputTokens / 193024,
      outputReserveTokens: 8192,
      safetyTokens: 1024,
      accuracy: "exact",
      needsCompaction: inputTokens >= 193024 * 0.7,
      fits: inputTokens + 8192 + 1024 <= 193024,
      requestFingerprint: String(inputTokens),
      compactThroughSeq: end,
    };
    let result = budget;
    if (request.url === "/api/context/compact") {
      result = {
        operationId: data.operationId,
        sessionId: context.state.sessionId,
        baseSessionVersion: context.state.sessionVersion,
        baseMemoryVersion: context.state.memoryVersion,
        baseSummaryVersion: context.summary.version,
        fromExclusiveSeq: context.summary.throughSeq,
        throughSeq: end,
        summary: {
          text: "旅人曾经探访废塔，约定保留地图线索。",
          throughSeq: end,
          version: context.summary.version + 1,
        },
        beforeTokens: inputTokens,
        afterTokens: 1000,
        sourceMessageIds: context.history
          .filter((m) => m.seq <= end)
          .map((m) => m.id),
        sourceFingerprint: "fixture-context",
      };
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(result));
    return;
  }
  if (
    request.url === "/api/context/inspect" ||
    request.url === "/api/state/update"
  ) {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const data = JSON.parse(raw);
    const result =
      request.url === "/api/context/inspect"
        ? {
            operationId: data.operationId,
            status: "ready",
            selectedHistoricalImages: data.input.text.includes("不需要图片")
              ? []
              : data.visual.assetCatalog.slice(0, 1).map((a) => ({
                  assetId: a.assetId,
                  purpose: "核对地图细节",
                })),
            candidateAssetIds: [],
            message: "",
            contextFingerprint: "test-fixture",
          }
        : {
            operationId: data.operationId,
            sessionVersion: data.context.state.sessionVersion,
            memoryVersion: data.context.state.memoryVersion,
            fromExclusiveSeq: data.fromExclusiveSeq,
            throughSeq: data.throughSeq,
            storyChanges: [],
            memoryChanges: [],
            goalChanges: [],
            visualObservations: (data.context.visual?.imagePayloads ?? []).map(
              (p) => ({
                assetId: p.assetId,
                summary: "地图参考",
                visibleDetails: ["红色标记"],
                extractedText: [],
                uncertainDetails: ["细字未辨认"],
                sourceMessageIds: data.messages
                  .filter((m) => m.role === "user")
                  .slice(-1)
                  .map((m) => m.id),
                version:
                  (data.context.visual.assetCatalog.find(
                    (a) => a.assetId === p.assetId,
                  )?.observation?.version ?? 0) + 1,
              }),
            ),
          };
    if (request.url === "/api/state/update") {
      if (data.context.input.text.includes("慢慢整理")) await delay(1800);
      if (data.context.input.text.includes("自动整理测试")) {
        const sourceMessageIds = [data.messages.at(-1).id];
        const base = {
          action: "create",
          expectedVersion: 0,
          before: null,
          reason: "本轮明确说明",
          sourceMessageIds,
        };
        if (data.context.state.story.location !== "旅馆")
          result.storyChanges.push({
            ...base,
            action: "update",
            id: "location",
            expectedVersion: data.context.state.sessionVersion,
            before: data.context.state.story.location,
            value: "旅馆",
          });
        if (!data.context.state.memories.length)
          result.memoryChanges.push({
            ...base,
            id: `memory:${data.operationId}`,
            value: {
              content: "用户希望被称为阿远",
              scope: "session",
              kind: "preference",
              epistemicStatus: "established",
              status: "active",
            },
          });
        if (!data.context.state.goals.length)
          result.goalChanges.push({
            ...base,
            id: `goal:${data.operationId}`,
            value: {
              description: "寻找失踪的哥哥",
              status: "active",
              currentFocus: "询问掌柜",
              progressSummary:
                "为了寻找哥哥来到旅馆，得知登记册可能留下了相关信息。",
            },
          });
      }
    }
    if (
      request.url === "/api/state/update" &&
      data.context.input.text.includes("人物状态测试")
    ) {
      for (const [id, value] of Object.entries({
        characterState: "灰色外套，神情平静，手腕受伤。",
        userState: "白色校服，自述紧张，暂无受伤信息。",
        items: ["旅馆柜台上的登记册，夹有哥哥留下的纸条"],
      }))
        result.storyChanges.push({
          action: "update",
          id,
          value,
          expectedVersion: data.context.state.sessionVersion,
          before: data.context.state.story[id],
          reason: "本轮明确呈现双方状态与环境物品",
          sourceMessageIds: data.messages.map((message) => message.id),
        });
    }
    if (
      request.url === "/api/state/update" &&
      data.context.input.text.includes("目标进展测试")
    ) {
      const previous = data.context.state.goals[0];
      result.goalChanges.push({
        action: "update",
        id: previous.id,
        expectedVersion: previous.version,
        before: previous.value,
        value: {
          ...previous.value,
          currentFocus: "核实码头消息",
          progressSummary:
            previous.value.progressSummary +
            "掌柜确认哥哥昨天离店，留下前往码头的信息。",
        },
        reason: "新对话补充了哥哥的去向",
        sourceMessageIds: data.messages.map((message) => message.id),
      });
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(result));
    return;
  }
  if (request.url !== "/api/chat" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  if (body.input.text.includes("接口失败")) {
    response.writeHead(502, { "content-type": "application/json" }).end(
      JSON.stringify({
        code: "MODEL_UNAVAILABLE",
        message: "测试模型暂不可用",
      }),
    );
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  const event = (name, data) =>
    response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  event("delta", { kind: "narration", text: "（她放下烛台，" });
  await delay(200);
  event("delta", { kind: "narration", text: "望向门口。）" });
  event("delta", { kind: "dialogue", text: "“欢迎回来，" });
  await delay(body.input.text.includes("慢慢回复") ? 10_000 : 400);
  if (response.destroyed) return;
  event("delta", {
    kind: "dialogue",
    text: `${body.state.memories.some((memory) => memory.value.status === "active" && memory.value.content.includes("阿远")) ? "阿远" : "旅人"}。”`,
  });
  if (!body.input.text.includes("没有结束"))
    event("done", {
      finishReason: "stop",
      usage: {
        status: "reported",
        inputTokens: 12300,
        outputTokens: 780,
        totalTokens: 13080,
      },
    });
  response.end();
}).listen(Number(process.env.ROLEPLAY_E2E_BACKEND_PORT ?? 18080), "127.0.0.1");
