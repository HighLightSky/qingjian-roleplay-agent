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
              clues: ["登记册"],
              milestones: [{ description: "检查登记册", status: "discovered" }],
              blockers: [],
            },
          });
      }
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
    event("done", { finishReason: "stop" });
  response.end();
}).listen(Number(process.env.ROLEPLAY_E2E_BACKEND_PORT ?? 18080), "127.0.0.1");
