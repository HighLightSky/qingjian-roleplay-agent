import type { Operation } from "../state/types";
import { database } from "../db";
import { now, plainText, errorText, type Message } from "../domain";
import type { ChatContext } from "../chat/context";
import { getOriginal } from "./repository";
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
      asset: await getOriginal(assetId),
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
      body: asset.originalBlob,
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
