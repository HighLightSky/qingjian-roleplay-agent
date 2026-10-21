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
    request.url === "/api/visual/update"
  ) {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const data = JSON.parse(raw);
    const result =
      request.url === "/api/context/inspect"
        ? {
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
            observations: data.context.visual.imagePayloads.map((p) => ({
              assetId: p.assetId,
              summary: "地图参考",
              visibleDetails: ["红色标记"],
              extractedText: [],
              uncertainDetails: ["细字未辨认"],
              sourceMessageIds: [data.userMessageId],
              version:
                (data.context.visual.assetCatalog.find(
                  (a) => a.assetId === p.assetId,
                )?.observation?.version ?? 0) + 1,
            })),
          };
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
    text: `${body.memories.some((memory) => memory.includes("阿远")) ? "阿远" : "旅人"}。”`,
  });
  if (!body.input.text.includes("没有结束"))
    event("done", { finishReason: "stop" });
  response.end();
}).listen(18080, "127.0.0.1");
