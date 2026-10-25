// 仅测试使用：复现任务与订阅分离，不连接实际模型。
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
const tasks = new Map(),
  images = new Map();
const json = (response, data, status = 200) =>
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(data));
async function stateResult(data) {
  const result = {
    scenePlan: {
      id: `scene:${data.operationId}`,
      sessionId: data.context.state.sessionId,
      assistantMessageId: data.messages.at(-1).id,
      sourceSeq: data.throughSeq,
      sourceCheckpointVersion: data.assistantCheckpointVersion,
      profileVersion: data.context.character.profileVersion,
      referenceImages: [],
      prompt: "女孩坐在书桌旁的椅子上，双脚落地，低头阅读桌上的书。",
      error: null,
    },
    operationId: data.operationId,
    sessionVersion: data.context.state.sessionVersion,
    memoryVersion: data.context.state.memoryVersion,
    fromExclusiveSeq: data.fromExclusiveSeq,
    throughSeq: data.throughSeq,
    visualChanges: [],
    storyChanges: [],
    memoryChanges: [],
    goalChanges: [],
    visualObservations: (data.context.visual?.imagePayloads ?? []).map((p) => ({
      assetId: p.assetId,
      summary: "地图参考",
      visibleDetails: ["红色标记"],
      extractedText: [],
      uncertainDetails: ["细字未辨认"],
      sources: data.context.visual.assetCatalog.find(
        (a) => a.assetId === p.assetId,
      )?.sources ?? [
        {
          type: "message",
          messageId: data.messages.filter((m) => m.role === "user").at(-1).id,
          seq: data.messages.filter((m) => m.role === "user").at(-1).seq,
          text: data.context.input.text,
          imageIndex:
            data.context.input.parts
              .filter((p) => p.type === "image")
              .findIndex((part) => part.assetId === p.assetId) + 1,
          uploadIndex:
            Math.max(
              0,
              ...[
                ...data.context.visual.assetCatalog,
                ...(data.context.visual.missingAssets ?? []),
              ]
                .flatMap((a) => a.sources)
                .filter((s) => s.type === "message")
                .map((s) => s.uploadIndex),
            ) +
            data.context.input.parts
              .filter((p) => p.type === "image")
              .findIndex((part) => part.assetId === p.assetId) +
            1,
        },
      ],
      version:
        (data.context.visual.assetCatalog.find((a) => a.assetId === p.assetId)
          ?.observation?.version ?? 0) + 1,
    })),
  };
  if (true) {
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
  if (true && data.context.input.text.includes("人物状态测试")) {
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
  if (true && data.context.input.text.includes("目标进展测试")) {
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
  return result;
}
function writeEvent(response, name, value) {
  if (!response.destroyed)
    response.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
}
function emit(task, name, value) {
  task.snapshot.revision++;
  for (const response of task.subscribers)
    writeEvent(response, name, { revision: task.snapshot.revision, value });
}
function stage(task, name, status, error = null) {
  const value = {
    name,
    status,
    error,
    ...(name === "selection" ? { plan: task.snapshot.plan } : {}),
  };
  task.snapshot.stages[name] = value;
  emit(task, "stage", value);
}
function subscribe(task, request, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  response.flushHeaders();
  writeEvent(response, "snapshot", task.snapshot);
  if (task.snapshot.terminal) {
    response.end();
    return;
  }
  task.subscribers.add(response);
  response.on("close", () => task.subscribers.delete(response));
}
function finish(task) {
  task.snapshot.terminal = true;
  emit(task, "done", task.snapshot);
  for (const response of task.subscribers) response.end();
  task.subscribers.clear();
}
async function generate(task, request) {
  const body = request.context;
  stage(task, "selection", "running");
  task.snapshot.plan = {
    operationId: body.operationId,
    status: "ready",
    candidateAssetIds: [],
    message: "",
    contextFingerprint: "fixture",
    selectedHistoricalImages: body.input.text.includes("不需要图片")
      ? []
      : (body.visual?.assetCatalog ?? [])
          .slice(0, 1)
          .map((a) => ({ assetId: a.assetId, purpose: "核对地图细节" })),
  };
  stage(task, "selection", "committed");
  stage(task, "body", "running");
  const add = (kind, text) => {
    const delta = { kind, text };
    task.snapshot.segments.push(delta);
    emit(task, "delta", delta);
  };
  add("narration", "（她放下烛台，");
  await delay(200);
  if (task.snapshot.terminal) return;
  add("narration", "望向门口。）");
  add("dialogue", "“欢迎回来，");
  await delay(body.input.text.includes("慢慢回复") ? 2500 : 400);
  if (task.snapshot.terminal) return;
  add(
    "dialogue",
    `${body.state.memories.some((m) => m.value.status === "active" && m.value.content.includes("阿远")) ? "阿远" : "旅人"}。”`,
  );
  task.snapshot.body = {
    finishReason: "stop",
    usage: {
      status: "reported",
      inputTokens: 12300,
      outputTokens: 780,
      totalTokens: 13080,
    },
  };
  emit(task, "body_done", task.snapshot.body);
  stage(task, "body", "committed");
  stage(task, "state_update", "running");
  if (body.input.text.includes("这一轮检查失败")) {
    stage(task, "state_update", "failed", "整理服务暂不可用");
    finish(task);
    return;
  }
  const ids = new Set([
    ...(body.input.parts ?? [])
      .filter((p) => p.type === "image")
      .map((p) => p.assetId),
    ...task.snapshot.plan.selectedHistoricalImages.map((p) => p.assetId),
    ...(body.visual?.assetCatalog ?? [])
      .filter(
        (a) =>
          !a.observation && a.sources.some((s) => s.type === "character_photo"),
      )
      .map((a) => a.assetId),
  ]);
  const prepared = {
    ...body,
    visual: {
      ...body.visual,
      plan: task.snapshot.plan,
      imagePayloads: [...ids]
        .filter((assetId) => {
          const asset = body.visual?.assetCatalog.find(
            (a) => a.assetId === assetId,
          );
          return (
            !asset?.observation &&
            !asset?.sources.some((s) => s.type === "scene_generation")
          );
        })
        .map((assetId) => ({ assetId })),
    },
  };
  task.snapshot.state = await stateResult({
    operationId: `state:${request.assistant.id}`,
    context: prepared,
    fromExclusiveSeq: request.user.seq - 1,
    throughSeq: request.assistant.seq,
    assistantCheckpointVersion: request.assistant.completedCheckpointVersion,
    messages: [
      { ...request.user, role: "user", text: body.input.text },
      { ...request.assistant, role: "assistant", text: "她回应了。" },
    ],
  });
  if (task.snapshot.terminal) return;
  emit(task, "state_result", task.snapshot.state);
  stage(task, "state_update", "committed");
  finish(task);
}
createServer(async (request, response) => {
  if (request.url === "/health") {
    response.end("ok");
    return;
  }
  if (request.url.startsWith("/api/validate/")) {
    for await (const chunk of request) {
    }
    response.end();
    return;
  }
  if (request.url === "/api/images/missing") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    json(response, {
      missing: JSON.parse(raw).hashes.filter((h) => !images.has(h)),
    });
    return;
  }
  if (
    ["/api/images/cache/stats", "/api/images/cache/clear"].includes(request.url)
  ) {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const hashes = [...new Set(JSON.parse(raw).hashes)];
    const matched = hashes.filter((hash) => images.has(hash));
    const inUse = new Set(
      [...tasks.values()]
        .filter((task) => !task.snapshot.terminal)
        .flatMap((task) => task.images.map((image) => image.sha256)),
    );
    const pinned = matched.filter((hash) => inUse.has(hash));
    const bytes = matched.reduce(
      (sum, hash) => sum + images.get(hash).length,
      0,
    );
    if (request.url.endsWith("/stats")) {
      json(response, {
        imageCount: matched.length,
        bytes,
        inUseImageCount: pinned.length,
        inUseBytes: pinned.reduce(
          (sum, hash) => sum + images.get(hash).length,
          0,
        ),
      });
    } else if (pinned.length) {
      json(
        response,
        {
          code: "IMAGE_IN_USE",
          message: "图片正在被任务使用，请在任务完成后重试",
        },
        409,
      );
    } else {
      matched.forEach((hash) => images.delete(hash));
      json(response, {
        releasedImageCount: matched.length,
        releasedBytes: bytes,
      });
    }
    return;
  }
  if (request.url.startsWith("/api/images/") && request.method === "PUT") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    images.set(request.url.split("/").at(-1), Buffer.concat(chunks));
    response.end();
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
        imageGeneration: {
          enabled: true,
          defaultWidth: 256,
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
        },
        maxImages: 10,
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

  if (request.url === "/api/state/update") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const data = JSON.parse(raw).request;
    json(response, await stateResult(data));
    return;
  }
  const match = request.url.match(
    /^\/api\/chat\/([^/]+)\/(events|cancel|ack)$/,
  );
  if (match) {
    const task = tasks.get(decodeURIComponent(match[1]));
    if (match[2] === "ack") {
      tasks.delete(decodeURIComponent(match[1]));
      response.end();
      return;
    }
    if (!task) {
      json(response, { code: "RESULT_EXPIRED", message: "结果已过期" }, 404);
      return;
    }
    if (match[2] === "cancel") {
      if (!task.snapshot.terminal) {
        stage(task, "body", "cancelled", "已停止，保留已收到的内容。");
        task.snapshot.error = "已停止，保留已收到的内容。";
        finish(task);
      }
      response.end();
      return;
    }
    subscribe(task, request, response);
    return;
  }
  if (request.url !== "/api/chat" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  if (input.context.input.text.includes("接口失败")) {
    json(response, { code: "MODEL_ERROR", message: "测试模型暂不可用" }, 502);
    return;
  }
  let task = tasks.get(input.runId);
  if (!task) {
    task = {
      images: input.images,
      snapshot: {
        runId: input.runId,
        revision: 0,
        segments: [],
        stages: {},
        budget: null,
        plan: null,
        body: null,
        state: null,
        terminal: false,
        error: null,
      },
      subscribers: new Set(),
    };
    tasks.set(input.runId, task);
    subscribe(task, request, response);
    void generate(task, input);
  } else subscribe(task, request, response);
}).listen(Number(process.env.ROLEPLAY_E2E_BACKEND_PORT ?? 18080), "127.0.0.1");
