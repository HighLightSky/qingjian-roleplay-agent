import type { Operation } from "../state/types";
import { database } from "../db";
import { now, plainText, errorText, type Message } from "../domain";
import type { ChatContext } from "../chat/context";
import { capabilities, dataUrl, getOriginal } from "./repository";
import {
  imageIds,
  requiredImageIds,
  type CatalogAsset,
  type ImagePlan,
  type ImagePayload,
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
  const [observations, usages, session] = await Promise.all([
    db.getAllFromIndex("visualObservations", "session", sessionId),
    db.getAllFromIndex("imageUsages", "session", sessionId),
    db.get("sessions", sessionId),
  ]);
  const catalog = new Map<string, CatalogAsset>();
  if (!session) throw new Error("图片目录的会话不存在。");
  async function entry(assetId: string) {
    if (!catalog.has(assetId)) {
      const asset = await db.get("assets", assetId);
      if (!asset) throw new Error("图片原件缺失，请恢复备份。");
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
              sources: observation.sources,
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
    return catalog.get(assetId)!;
  }
  const photoId = session.characterSnapshot.appearancePhotoAssetId;
  if (photoId)
    (await entry(photoId)).sources.push({
      type: "character_photo",
      characterId: session.characterId,
      profileVersion: session.profileVersion,
    });
  let uploadIndex = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    let imageIndex = 0;
    for (const assetId of imageIds(message.parts)) {
      imageIndex++;
      uploadIndex++;
      (await entry(assetId)).sources.push({
        type: "message",
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
      ...requiredImageIds(context),
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
  anchorMessageId: string,
  recordOperation: (operation: Operation) => Promise<void>,
): Promise<ChatContext> {
  const catalog = await buildCatalog(sessionId, history);
  if (!catalog.length && !imageIds(context.input.parts).length) return context;
  const prepared: ChatContext = {
    ...context,
    visual: { sessionId, assetCatalog: catalog, plan: null, imagePayloads: [] },
  };
  if (
    catalog.some(
      (a) => a.observation || a.sources.some((s) => s.type === "message"),
    )
  ) {
    let operation: Operation = {
      id: context.operationId,
      sessionId,
      anchorMessageId,
      runId: anchorMessageId,
      placement: "before",
      kind: "selection",
      status: "pending",
      createdAt: now(),
      updatedAt: now(),
    };
    await recordOperation(operation);
    try {
      operation = { ...operation, status: "running", updatedAt: now() };
      await recordOperation(operation);
      const plan = await apiJson<ImagePlan>(
        "/api/context/inspect",
        prepared,
        signal,
      );
      signal.throwIfAborted();
      if (
        plan.operationId !== context.operationId ||
        !Array.isArray(plan.selectedHistoricalImages) ||
        plan.selectedHistoricalImages.some(
          (s) => !catalog.some((a) => a.assetId === s.assetId),
        )
      )
        throw new Error("服务端返回了无效选图计划。");
      operation = {
        ...operation,
        result: { plan, catalog },
        status: "computed",
        updatedAt: now(),
      };
      await recordOperation(operation);
      if (plan.status !== "ready")
        throw new Error(plan.message || "无法确定本轮参考图片。");
      operation = { ...operation, status: "committed", updatedAt: now() };
      await recordOperation(operation);
      prepared.visual!.plan = plan;
    } catch (error) {
      await recordOperation({
        ...operation,
        status: signal.aborted ? "cancelled" : "failed",
        error: errorText(error),
        updatedAt: now(),
      });
      throw error;
    }
  }
  prepared.visual!.imagePayloads = await loadPayloads(prepared, signal);
  if (new Blob([JSON.stringify(prepared)]).size > 64 * 1024 * 1024)
    throw new Error("请求体不能超过 64 MiB。");
  return prepared;
}
