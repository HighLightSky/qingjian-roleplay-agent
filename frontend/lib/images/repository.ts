import type { Commit } from "./types";
import { database, TABLES, collectUnreferenced, atomic } from "../db";
import { now, parseCharacterProfile } from "../domain";
import { sha256 } from "./hash";
import { allocateImageId, type ImageWriteTransaction } from "./ids";
import { imageIds, type Capabilities, type ImageAsset } from "./types";

export const DEFAULT_LIMITS = {
  maxImages: 4,
  maxImageBytes: 10 * 1024 * 1024,
  maxPixels: 20_000_000,
  maxRequestBytes: 64 * 1024 * 1024,
};
export async function capabilities(
  signal?: AbortSignal,
): Promise<Capabilities> {
  const response = await fetch("/api/capabilities", {
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error("无法读取模型图片能力，请确认后端已启动。");
  return response.json();
}
export function fileBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("无法读取原图"));
    reader.readAsArrayBuffer(blob);
  });
}
export async function dataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await fileBytes(blob));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${blob.type};base64,${btoa(binary)}`;
}
// 分配像素前检查尺寸，浏览器随后执行实际解码。
export function inspectImage(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    mime === "image/png" &&
    bytes.length >= 33 &&
    v.getUint32(0) === 0x89504e47 &&
    v.getUint32(4) === 0x0d0a1a0a &&
    v.getUint32(12) === 0x49484452
  ) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = v.getUint32(offset);
      if (length > bytes.length - offset - 12)
        throw new Error("PNG 图片已损坏。");
      if (v.getUint32(offset + 4) === 0x6163544c)
        throw new Error("暂不支持动态 PNG。");
      offset += length + 12;
    }
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (mime === "image/jpeg" && bytes.length > 4 && v.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = v.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8)
        return {
          width: v.getUint16(offset + 5),
          height: v.getUint16(offset + 3),
        };
      offset += length;
    }
  }
  throw new Error("请选择有效的静态 JPEG 或 PNG 图片。");
}
export async function validateImageBlob(blob: Blob, limits = DEFAULT_LIMITS) {
  if (!blob.size || blob.size > limits.maxImageBytes)
    throw new Error("单张图片不能超过允许大小。");
  const bytes = new Uint8Array(await fileBytes(blob));
  const dimensions = inspectImage(bytes, blob.type);
  if (
    !dimensions.width ||
    !dimensions.height ||
    dimensions.width * dimensions.height > limits.maxPixels
  )
    throw new Error("图片像素超过允许范围。");
  let thumbnailBlob: Blob | undefined;
  if (typeof createImageBitmap === "function") {
    const image = await createImageBitmap(blob).catch((cause: unknown) => {
      throw new Error("图片无法解码，请选择有效的静态 JPEG 或 PNG。", {
        cause,
      });
    });
    try {
      if (!(
        (image.width === dimensions.width &&
          image.height === dimensions.height) ||
        (image.width === dimensions.height && image.height === dimensions.width)
      ))
        throw new Error("图片尺寸无效。");
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 256 / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas
        .getContext("2d")!
        .drawImage(image, 0, 0, canvas.width, canvas.height);
      thumbnailBlob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("缩略图生成失败"))),
          "image/png",
        ),
      );
    } finally {
      image.close();
    }
  }
  return { ...dimensions, sha256: sha256(bytes), thumbnailBlob };
}
async function inspectFile(file: File) {
  const caps = await capabilities();
  if (!caps.visionSupported) throw new Error("当前模型尚未启用视觉能力。");
  if (!caps.mimeTypes.includes(file.type))
    throw new Error("请选择静态 JPEG 或 PNG 图片。");
  const info = await validateImageBlob(file, caps);
  return { caps, info };
}
async function getOrCreateImageAsset(
  tx: ImageWriteTransaction,
  file: File,
  info: Awaited<ReturnType<typeof validateImageBlob>>,
): Promise<ImageAsset> {
  const assets = tx.objectStore("assets");
  const existing = await assets.index("sha256").get(info.sha256);
  if (existing) return existing;
  const asset: ImageAsset = {
    id: await allocateImageId(tx),
    ...info,
    mimeType: file.type,
    byteSize: file.size,
    displayName: file.name,
    originalBlob: file,
    createdAt: now(),
  };
  await assets.add(asset);
  return asset;
}
export async function prepareImage(
  file: File,
  sessionId: string,
  commit: Commit = (task) => task(),
): Promise<ImageAsset> {
  const { caps, info } = await inspectFile(file);
  return commit(async () => {
    const db = await database();
    const tx = db.transaction(
      ["assets", "settings", "drafts", "sessions"],
      "readwrite",
    );
    return atomic(tx, async () => {
      if (!(await tx.objectStore("sessions").get(sessionId)))
        throw new Error("会话不存在。");
      const draft = (await tx.objectStore("drafts").get(sessionId)) ?? {
        sessionId,
        text: "",
        updatedAt: now(),
      };
      if (imageIds(draft.parts).length >= caps.maxImages)
        throw new Error(`每条消息最多 ${caps.maxImages} 张图片。`);
      const asset = await getOrCreateImageAsset(tx, file, info);
      if (imageIds(draft.parts).includes(asset.id))
        throw new Error("该图片已经在草稿中。");
      await tx.objectStore("drafts").put({
        ...draft,
        parts: [...(draft.parts ?? []), { type: "image", assetId: asset.id }],
        updatedAt: now(),
      });
      return asset;
    });
  });
}
/** 原件与草稿引用在同一事务保存，准备完成后没有无引用窗口。 */
export async function prepareCharacterPhoto(
  file: File,
  draftKey: string,
  commit: Commit,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { info } = await inspectFile(file);
  signal.throwIfAborted();
  return commit(async () => {
    signal.throwIfAborted();
    const db = await database();
    const tx = db.transaction(TABLES, "readwrite");
    return atomic(tx, async () => {
      const draft = await tx.objectStore("settings").get(draftKey);
      if (!draft) throw new Error("角色草稿已关闭或移除，请重新打开编辑。");
      const profile = parseCharacterProfile(JSON.parse(draft.value), true);
      const asset = await getOrCreateImageAsset(tx, file, info);
      const updated = { ...profile, appearancePhotoAssetId: asset.id };
      signal.throwIfAborted();
      await tx
        .objectStore("settings")
        .put({ key: draftKey, value: JSON.stringify(updated) });
      await collectUnreferenced(tx);
      return updated;
    });
  });
}
export async function removeDraftImage(sessionId: string, assetId: string) {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  const draft = await tx.objectStore("drafts").get(sessionId);
  if (draft)
    await tx.objectStore("drafts").put({
      ...draft,
      parts: draft.parts?.filter(
        (p) => p.type !== "image" || p.assetId !== assetId,
      ),
      updatedAt: now(),
    });
  await collectUnreferenced(tx);
  await tx.done;
}
export async function getOriginal(assetId: string): Promise<ImageAsset> {
  const asset = await (await database()).get("assets", assetId);
  if (!asset) throw new Error("本地原图缺失，请重新选择图片或恢复备份。");
  if (
    sha256(new Uint8Array(await fileBytes(asset.originalBlob))) !== asset.sha256
  )
    throw new Error("本地原图已损坏，请恢复备份。");
  return asset;
}
