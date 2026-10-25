import {
  getOriginal,
  fileBytes,
  inspectImage,
  capabilities,
  DEFAULT_LIMITS,
} from "./repository";
import { sha256 } from "./hash";
import type { ImageAsset, Capabilities } from "./types";
import type { SceneReference } from "../scene-images/types";

export type ModelInput = {
  assetId: string;
  sha256: string;
  sourceSha256: string;
  blob: Blob;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
};
const original = (asset: ImageAsset): ModelInput => ({
  assetId: asset.id,
  sha256: asset.sha256,
  sourceSha256: asset.sha256,
  blob: asset.originalBlob,
  mimeType: asset.mimeType,
  byteSize: asset.byteSize,
  width: asset.width,
  height: asset.height,
});

const derivatives = new Map<string, WeakRef<ModelInput>>();
async function encode(
  asset: ImageAsset,
  edge: number,
  quality: number,
  coarse: boolean,
): Promise<ModelInput> {
  const key = `${asset.sha256}:reference-v1:${edge}:${quality}:${coarse}`;
  const existing = derivatives.get(key)?.deref();
  if (existing) return existing;
  for (const [cachedKey, cached] of derivatives)
    if (!cached.deref()) derivatives.delete(cachedKey);
  const input = await prepareAuxiliaryReference(asset, edge, quality, coarse);
  derivatives.set(key, new WeakRef(input));
  return input;
}

export async function prepareAuxiliaryReference(
  asset: ImageAsset,
  edge: number,
  quality: number,
  coarse: boolean,
): Promise<ModelInput> {
  if (Math.max(asset.width, asset.height) <= edge) return original(asset);
  let blob: Blob;
  if (coarse && asset.thumbnailBlob && edge >= 256) blob = asset.thumbnailBlob;
  else {
    const image = await createImageBitmap(asset.originalBlob);
    try {
      const ratio = Math.min(1, edge / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(image.width * ratio));
      canvas.height = Math.max(1, Math.floor(image.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法准备图片画布。");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const mime = asset.mimeType === "image/png" ? "image/png" : "image/jpeg";
      blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("参考图压缩失败。"))),
          mime,
          quality,
        ),
      );
    } finally {
      image.close();
    }
  }
  const bytes = new Uint8Array(await fileBytes(blob));
  return {
    assetId: asset.id,
    sourceSha256: asset.sha256,
    sha256: sha256(bytes),
    blob,
    mimeType: blob.type,
    byteSize: blob.size,
    ...inspectImage(bytes, blob.type),
  };
}

export async function prepareGenerationInputs(
  references: SceneReference[],
  caps: Capabilities,
): Promise<ModelInput[]> {
  const limits = caps.imageGeneration;
  const inputs: ModelInput[] = [];
  const assets = await Promise.all(
    references.map((ref) => getOriginal(ref.assetId)),
  );
  let fixedPixels = 0;
  for (let i = 0; i < references.length; i++) {
    if (i === 0 || references[i].roles.includes("identity")) {
      const asset = assets[i];
      if (
        asset.byteSize > limits.maxImageBytes ||
        asset.width * asset.height > limits.maxPixels ||
        Math.max(asset.width, asset.height) > limits.maxEdge
      )
        throw new Error("底图或人物身份原图超出服务限制，请选择合规原图。");
      fixedPixels += asset.width * asset.height;
    }
  }
  if (fixedPixels > limits.maxTotalPixels)
    throw new Error("底图及身份原图总像素超限。");
  const auxiliaryCount = references.filter(
    (ref, index) => index !== 0 && !ref.roles.includes("identity"),
  ).length;
  const auxiliaryEdge = Math.min(
    limits.referenceMaxEdge,
    Math.floor(
      Math.sqrt(
        (limits.maxTotalPixels - fixedPixels) / Math.max(1, auxiliaryCount),
      ),
    ),
  );
  if (auxiliaryCount && auxiliaryEdge < 1)
    throw new Error("没有足够的辅助参考像素预算。");
  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    let input =
      i === 0 || ref.roles.includes("identity")
        ? original(assets[i])
        : await encode(
            assets[i],
            auxiliaryEdge,
            limits.referenceJpegQuality,
            ref.roles.every((role) => ["environment", "pose"].includes(role)),
          );
    while (
      input.byteSize > limits.maxImageBytes &&
      i !== 0 &&
      !ref.roles.includes("identity")
    ) {
      const edge = Math.floor(Math.max(input.width, input.height) * 0.7);
      if (edge < 1) throw new Error("辅助参考无法压缩到服务限制。");
      input = await encode(assets[i], edge, limits.referenceJpegQuality, false);
    }
    inputs.push(input);
  }
  if (
    inputs.reduce((sum, image) => sum + image.width * image.height, 0) >
      limits.maxTotalPixels ||
    inputs.reduce((sum, image) => sum + image.byteSize, 0) + 65536 >
      limits.maxRequestBytes
  )
    throw new Error("参考图片总体积或像素超过生图限制。");
  return inputs;
}

export async function prepareChatInput(asset: ImageAsset): Promise<ModelInput> {
  if (
    asset.byteSize <= DEFAULT_LIMITS.maxImageBytes &&
    asset.width * asset.height <= DEFAULT_LIMITS.maxPixels
  )
    return original(asset);
  const caps = await capabilities();
  let edge = caps.imageGeneration.referenceMaxEdge;
  for (;;) {
    const input = await encode(
      asset,
      edge,
      caps.imageGeneration.referenceJpegQuality,
      false,
    );
    if (
      input.byteSize <= caps.maxImageBytes &&
      input.width * input.height <= caps.maxPixels
    )
      return input;
    edge = Math.floor(edge * 0.7);
    if (edge < 1) throw new Error("生成图无法准备合规的正文查看版本。");
  }
}
