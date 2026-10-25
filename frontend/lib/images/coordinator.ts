import { prepareChatInput } from "./model-input";
import { database } from "../db";
import { plainText, type Message } from "../domain";
import type { ChatContext } from "../chat/context";
import { getOriginal } from "./repository";
import { imageIds, type CatalogAsset, type MissingAsset } from "./types";

export async function apiJson<T>(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const json = JSON.stringify(body);
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
): Promise<{ assetCatalog: CatalogAsset[]; missingAssets: MissingAsset[] }> {
  const db = await database();
  const [observations, usages, session, generations, plans] = await Promise.all(
    [
      db.getAllFromIndex("visualObservations", "session", sessionId),
      db.getAllFromIndex("imageUsages", "session", sessionId),
      db.get("sessions", sessionId),
      db.getAllFromIndex("sceneGenerations", "session", sessionId),
      db.getAllFromIndex("sceneImagePlans", "session", sessionId),
    ],
  );
  const catalog = new Map<string, CatalogAsset | MissingAsset>();
  if (!session) throw new Error("图片目录的会话不存在。");
  async function entry(assetId: string) {
    if (!catalog.has(assetId)) {
      const storedAsset = await db.get("assets", assetId);
      const asset = storedAsset
        ? await prepareChatInput(storedAsset)
        : undefined;
      const observation = observations.find((o) => o.assetId === assetId);
      catalog.set(assetId, {
        assetId,
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
        ...(asset
          ? {
              sha256: asset.sha256,
              sourceSha256: asset.sourceSha256,
              mimeType: asset.mimeType,
              byteSize: asset.byteSize,
              width: asset.width,
              height: asset.height,
              recentUses: usages
                .filter((u) => u.assetId === assetId)
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                .slice(-10)
                .map((u) => ({ messageId: u.messageId, purpose: u.purpose })),
            }
          : {}),
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
  const messageIds = new Set(messages.map((m) => m.id));
  for (const generation of generations.sort(
    (a, b) =>
      a.sourceSeq - b.sourceSeq || a.createdAt.localeCompare(b.createdAt),
  )) {
    if (
      generation.status !== "succeeded" ||
      generation.referenceStatus !== "eligible" ||
      !messageIds.has(generation.assistantMessageId)
    )
      continue;
    const plan = plans.find((p) => p.id === generation.planId);
    if (!plan || !generation.assetId)
      throw new Error("成功生成记录缺少计划或图片引用。");
    const message = messages.find(
      (m) => m.id === generation.assistantMessageId,
    )!;
    if (message.checkpointVersion !== generation.sourceCheckpointVersion)
      continue;
    (await entry(generation.assetId)).sources.push({
      type: "scene_generation",
      generationId: generation.id,
      planId: plan.id,
      messageId: generation.assistantMessageId,
      seq: generation.sourceSeq,
      summary:
        generation.submission.effectivePrompt ?? generation.submission.prompt,
      rejected: false,
    });
  }
  const assetCatalog: CatalogAsset[] = [];
  const missingAssets: MissingAsset[] = [];
  for (const asset of catalog.values()) {
    if ("sha256" in asset) assetCatalog.push(asset);
    else missingAssets.push(asset);
  }
  return { assetCatalog, missingAssets };
}
/** 全部候选原图先补齐，后台选图后无需再依赖浏览器。 */
export async function warmImageCache(
  context: ChatContext,
  signal: AbortSignal,
) {
  const ids = new Set([
    ...(context.visual?.assetCatalog ?? []).map((a) => a.assetId),
    ...imageIds(context.input.parts),
  ]);
  if (!ids.size) return [];
  const assets = await Promise.all(
    [...ids].map(async (assetId) => ({
      assetId,
      asset: await prepareChatInput(await getOriginal(assetId)),
    })),
  );
  const { missing } = await apiJson<{ missing: string[] }>(
    "/api/images/missing",
    { hashes: assets.map((a) => a.asset.sha256) },
    signal,
  );
  for (const hash of missing) {
    const asset = assets.find((a) => a.asset.sha256 === hash)!.asset;
    const response = await fetch(`/api/images/${hash}`, {
      method: "PUT",
      body: asset.blob,
      signal,
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message);
    }
  }
  return assets.map(({ assetId, asset }) => ({
    assetId,
    sha256: asset.sha256,
  }));
}
