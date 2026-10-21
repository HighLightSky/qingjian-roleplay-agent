import { database } from "../db";
import { now, plainText, type Message } from "../domain";
import type { ChatContext } from "../chat/context";
import { capabilities, dataUrl, getOriginal } from "./repository";
import {
  imageIds,
  type CatalogAsset,
  type ImagePlan,
  type ImagePayload,
  type Observation,
  type VisualTask,
  type Commit,
} from "./types";

export async function apiJson<T>(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const json = JSON.stringify(body);
  if (new Blob([json]).size > 64 * 1024 * 1024)
    throw new Error("请求体不能超过 64 MiB。");
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: json,
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "图片处理请求失败。");
  return result;
}
export async function buildCatalog(
  sessionId: string,
  messages: Message[],
): Promise<CatalogAsset[]> {
  const db = await database();
  const [observations, usages] = await Promise.all([
    db.getAllFromIndex("visualObservations", "session", sessionId),
    db.getAllFromIndex("imageUsages", "session", sessionId),
  ]);
  const catalog = new Map<string, CatalogAsset>();
  let uploadIndex = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    let imageIndex = 0;
    for (const assetId of imageIds(message.parts)) {
      imageIndex++;
      uploadIndex++;
      if (!catalog.has(assetId)) {
        const asset = await db.get("assets", assetId);
        if (!asset) throw new Error("历史图片原件缺失，请恢复备份。");
        const observation = observations.find((o) => o.assetId === assetId);
        catalog.set(assetId, {
          assetId,
          sha256: asset.sha256,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          width: asset.width,
          height: asset.height,
          sources: [],
          observation: observation
            ? {
                assetId,
                summary: observation.summary,
                visibleDetails: observation.visibleDetails,
                extractedText: observation.extractedText,
                uncertainDetails: observation.uncertainDetails,
                sourceMessageIds: observation.sourceMessageIds,
                version: observation.version,
              }
            : null,
          recentUses: usages
            .filter((u) => u.assetId === assetId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .slice(-10)
            .map((u) => ({ messageId: u.messageId, purpose: u.purpose })),
        });
      }
      catalog.get(assetId)!.sources.push({
        messageId: message.id,
        seq: message.seq,
        text: plainText(message),
        imageIndex,
        uploadIndex,
      });
    }
  }
  return [...catalog.values()];
}
export async function loadPayloads(
  context: ChatContext,
  signal: AbortSignal,
): Promise<ImagePayload[]> {
  const ids = [
    ...new Set([
      ...imageIds(context.input.parts),
      ...(context.visual?.plan?.selectedHistoricalImages ?? []).map(
        (s) => s.assetId,
      ),
    ]),
  ];
  const caps = ids.length ? await capabilities(signal) : null;
  if (caps && (!caps.visionSupported || ids.length > caps.maxImages))
    throw new Error("模型不支持视觉或本次参考图片数量超限。");
  const payloads: ImagePayload[] = [];
  for (const assetId of ids) {
    signal.throwIfAborted();
    const asset = await getOriginal(assetId);
    if (
      caps &&
      (asset.byteSize > caps.maxImageBytes ||
        asset.width * asset.height > caps.maxPixels)
    )
      throw new Error("本地图片超过当前部署限制。");
    payloads.push({
      assetId,
      sha256: asset.sha256,
      dataUrl: await dataUrl(asset.originalBlob),
    });
  }
  signal.throwIfAborted();
  return payloads;
}
export async function prepareImageContext(
  context: ChatContext,
  sessionId: string,
  history: Message[],
  signal: AbortSignal,
): Promise<ChatContext> {
  const catalog = await buildCatalog(sessionId, history);
  if (!catalog.length && !imageIds(context.input.parts).length) return context;
  const prepared: ChatContext = {
    ...context,
    visual: { sessionId, assetCatalog: catalog, plan: null, imagePayloads: [] },
  };
  if (catalog.length) {
    const plan = await apiJson<ImagePlan>(
      "/api/context/inspect",
      prepared,
      signal,
    );
    if (plan.status !== "ready")
      throw new Error(
        plan.message || "无法确定本轮需要参考的图片，请明确说明。",
      );
    if (
      !Array.isArray(plan.selectedHistoricalImages) ||
      plan.selectedHistoricalImages.some(
        (s) => !catalog.some((a) => a.assetId === s.assetId),
      )
    )
      throw new Error("服务端返回了无效选图计划。");
    prepared.visual!.plan = plan;
  }
  prepared.visual!.imagePayloads = await loadPayloads(prepared, signal);
  if (new Blob([JSON.stringify(prepared)]).size > 64 * 1024 * 1024)
    throw new Error("请求体不能超过 64 MiB。");
  return prepared;
}
export async function saveCompletedVisualTask(
  context: ChatContext,
  user: Message,
  assistant: Message,
) {
  if (!context.visual?.imagePayloads.length) return null;
  const db = await database();
  const tx = db.transaction(
    ["messages", "visualTasks", "imageUsages"],
    "readwrite",
  );
  await tx.objectStore("messages").put(assistant);
  const stored = structuredClone(context);
  stored.visual!.imagePayloads = [];
  const task: VisualTask = {
    id: assistant.id,
    sessionId: assistant.sessionId,
    userMessageId: user.id,
    assistantMessageId: assistant.id,
    assistantText: plainText(assistant),
    context: stored,
    createdAt: now(),
    updatedAt: now(),
  };
  await tx.objectStore("visualTasks").put(task);
  for (const p of context.visual.imagePayloads) {
    const selected = context.visual.plan?.selectedHistoricalImages.find(
      (s) => s.assetId === p.assetId,
    );
    await tx.objectStore("imageUsages").put({
      id: `${assistant.id}:${p.assetId}`,
      assetId: p.assetId,
      sessionId: assistant.sessionId,
      messageId: assistant.id,
      purpose: selected?.purpose ?? "本轮用户图片",
      createdAt: now(),
    });
  }
  await tx.done;
  return task;
}
export async function runVisualTask(
  task: VisualTask,
  signal: AbortSignal,
  commit: Commit = (task) => task(),
) {
  const payloads = await loadPayloads(task.context, signal);
  const result = await apiJson<{ observations: Observation[] }>(
    "/api/visual/update",
    {
      context: {
        ...task.context,
        visual: { ...task.context.visual!, imagePayloads: payloads },
      },
      userMessageId: task.userMessageId,
      assistantMessageId: task.assistantMessageId,
      assistantText: task.assistantText,
    },
    signal,
  );
  signal.throwIfAborted();
  if (
    !Array.isArray(result.observations) ||
    result.observations.length !== payloads.length ||
    new Set(result.observations.map((o) => o.assetId)).size !==
      payloads.length ||
    result.observations.some(
      (o) => !payloads.some((p) => p.assetId === o.assetId),
    )
  )
    throw new Error("视觉观察来源不完整。");
  await commit(async () => {
    signal.throwIfAborted();
    const db = await database();
    const tx = db.transaction(
      ["visualTasks", "visualObservations", "sessions"],
      "readwrite",
    );
    if (
      !(await tx.objectStore("visualTasks").get(task.id)) ||
      !(await tx.objectStore("sessions").get(task.sessionId))
    ) {
      await tx.done;
      return;
    }
    for (const observation of result.observations) {
      const key = `${task.sessionId}:${observation.assetId}`;
      const previous = await tx.objectStore("visualObservations").get(key);
      const expected =
        task.context.visual?.assetCatalog.find(
          (a) => a.assetId === observation.assetId,
        )?.observation?.version ?? 0;
      if (
        (previous?.version ?? 0) !== expected ||
        observation.version !== expected + 1
      ) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new Error("视觉记录版本已变化，请重新整理。");
      }
      await tx.objectStore("visualObservations").put({
        ...observation,
        id: key,
        sessionId: task.sessionId,
        createdAt: previous?.createdAt ?? now(),
        updatedAt: now(),
      });
    }
    await tx.objectStore("visualTasks").delete(task.id);
    await tx.done;
  });
}
export async function resumePendingTasks(
  sessionId: string,
  signal: AbortSignal,
  commit?: Commit,
) {
  const tasks = await (
    await database()
  ).getAllFromIndex("visualTasks", "session", sessionId);
  for (const task of tasks.sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  ))
    await runVisualTask(task, signal, commit);
}
