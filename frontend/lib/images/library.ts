import { atomic, database, TABLES, collectUnreferenced } from "../db";
import { now } from "../domain";
import { allocateImageId } from "./ids";
import { capabilities, validateImageBlob } from "./repository";
import { LIBRARY_ASSET_PREFIX, type Commit, type ImageAsset } from "./types";

export async function saveLibraryImage(
  file: File,
  origin: ImageAsset["creationOrigin"],
  commit: Commit,
): Promise<ImageAsset> {
  const caps = await capabilities();
  const limits = caps.imageGeneration;
  const info = await validateImageBlob(file, {
    maxImageBytes:
      origin === "generated" ? limits.maxOutputBytes : caps.maxImageBytes,
    maxPixels: origin === "generated" ? limits.maxOutputPixels : caps.maxPixels,
    maxRequestBytes: limits.maxRequestBytes,
  });
  return commit(async () => {
    const db = await database();
    const tx = db.transaction(["assets", "settings"], "readwrite");
    return atomic(tx, async () => {
      let asset = await tx
        .objectStore("assets")
        .index("sha256")
        .get(info.sha256);
      if (!asset) {
        asset = {
          id: await allocateImageId(tx),
          creationOrigin: origin,
          ...info,
          mimeType: file.type,
          byteSize: file.size,
          displayName: file.name,
          originalBlob: file,
          createdAt: now(),
        };
        await tx.objectStore("assets").add(asset);
      }
      // 显式保存的资源独立于会话存活，不被草稿清理回收。
      await tx.objectStore("settings").put({
        key: `${LIBRARY_ASSET_PREFIX}${asset.id}`,
        value: asset.id,
      });
      return asset;
    });
  });
}

export async function discardLibraryImage(assetId: string, commit: Commit) {
  await commit(async () => {
    const db = await database();
    const tx = db.transaction(TABLES, "readwrite");
    await atomic(tx, async () => {
      await tx
        .objectStore("settings")
        .delete(`${LIBRARY_ASSET_PREFIX}${assetId}`);
      await collectUnreferenced(tx);
    });
  });
}
