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
): Promise<ModelInput> {
  const key = `${asset.sha256}:reference-v1:${edge}:${quality}`;
  const existing = derivatives.get(key)?.deref();
  if (existing) return existing;
  for (const [cachedKey, cached] of derivatives)
    if (!cached.deref()) derivatives.delete(cachedKey);
  const input = await prepareAuxiliaryReference(asset, edge, quality);
  derivatives.set(key, new WeakRef(input));
  return input;
}

export async function prepareAuxiliaryReference(
  asset: ImageAsset,
  edge: number,
  quality: number,
): Promise<ModelInput> {
  if (Math.max(asset.width, asset.height) <= edge) return original(asset);
  let blob: Blob;
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
  width: number,
  height: number,
): Promise<ModelInput[]> {
  const limits = caps.imageGeneration;
  const inputs: ModelInput[] = [];
  const assets = await Promise.all(
    references.map((ref) => getOriginal(ref.assetId)),
  );
  if (references.length > limits.maxReferenceImages)
    throw new Error("生图参考图数量超限，黑色画布占用一个名额。");
  const blackPixels = width * height;
  if (
    blackPixels > limits.maxPixels ||
    Math.max(width, height) > limits.maxEdge
  )
    throw new Error("黑色画布尺寸或像素超过服务限制。");
  const edgeBudget = Math.min(
    limits.referenceMaxEdge,
    limits.maxEdge,
    Math.floor(Math.sqrt(limits.maxPixels)),
    Math.floor(
      Math.sqrt(
        (limits.maxTotalPixels - blackPixels) / Math.max(1, references.length),
      ),
    ),
  );
  if (references.length && edgeBudget < 1)
    throw new Error("没有足够的参考图像素预算。");
  for (let i = 0; i < references.length; i++) {
    let input = await encode(
      assets[i],
      edgeBudget,
      limits.referenceJpegQuality,
    );
    while (input.byteSize > limits.maxImageBytes) {
      const edge = Math.floor(Math.max(input.width, input.height) * 0.7);
      if (edge < 1)
        throw new Error(`参考图无法压缩到服务限制：${references[i].assetId}`);
      input = await encode(assets[i], edge, limits.referenceJpegQuality);
    }
    inputs.push(input);
  }
  if (
    inputs.reduce(
      (sum, image) => sum + image.width * image.height,
      blackPixels,
    ) > limits.maxTotalPixels ||
    inputs.reduce((sum, image) => sum + image.byteSize, 0) + 65536 >
      limits.maxRequestBytes
  )
    throw new Error("参考图片总体积或像素超过生图限制，请调整参考清单。");
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
