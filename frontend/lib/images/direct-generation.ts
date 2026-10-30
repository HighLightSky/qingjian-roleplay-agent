import { fileBytes, inspectImage } from "./repository";
import { prepareGenerationAssets, type ModelInput } from "./model-input";
import type { Capabilities } from "./types";
import { sha256 } from "./hash";
import type { SceneTaskSnapshot, PoseSelection } from "../scene-images/types";

async function checked(response: Response) {
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }
  return response;
}

export type DirectReference = {
  assetId: string;
  file: File;
  libraryAssetId?: string;
};
export type DirectImageInput = {
  prompt: string;
  references: DirectReference[];
  pose: {
    width: number;
    height: number;
    query: string;
    characterReferenceAssetId: string;
    selection: PoseSelection;
  } | null;
};

export function orderedDirectReferences<T extends { assetId: string }>(
  references: T[],
  characterId: string | null,
): T[] {
  return characterId === null
    ? [...references]
    : [...references].sort(
        (a, b) =>
          Number(b.assetId === characterId) - Number(a.assetId === characterId),
      );
}

export async function generateDirectImage(
  request: DirectImageInput,
  caps: Capabilities,
  runId: string,
  signal: AbortSignal,
  onStatus: (snapshot: SceneTaskSnapshot) => void,
): Promise<Blob> {
  // 在首个异步操作前冻结参数，后续页面编辑不能修改已提交任务。
  const pose = structuredClone(request.pose);
  const prompt = request.prompt;
  const ordered = orderedDirectReferences(
    request.references.map((ref) => ({ ...ref })),
    pose?.characterReferenceAssetId ?? null,
  );
  const assets = await Promise.all(
    ordered.map(async (ref) => {
      const bytes = new Uint8Array(await fileBytes(ref.file));
      return {
        id: ref.assetId,
        originalBlob: ref.file,
        sha256: sha256(bytes),
        mimeType: ref.file.type,
        byteSize: ref.file.size,
        ...inspectImage(bytes, ref.file.type),
      };
    }),
  );
  let inputs: ModelInput[];
  if (pose) {
    const unit = caps.imageGeneration.dimensionAlignment;
    pose.width = Math.ceil(pose.width / unit) * unit;
    pose.height = Math.ceil(pose.height / unit) * unit;
    inputs = await prepareGenerationAssets(
      assets,
      caps,
      pose.width,
      pose.height,
    );
  } else {
    inputs = assets.map((asset) => ({
      assetId: asset.id,
      blob: asset.originalBlob,
      sha256: asset.sha256,
      sourceSha256: asset.sha256,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      width: asset.width,
      height: asset.height,
    }));
  }
  const references = [];
  for (const [index, input] of inputs.entries()) {
    await checked(
      await fetch(`/api/scene-images/inputs/${input.sha256}`, {
        method: "PUT",
        body: input.blob,
        signal,
      }),
    );
    references.push({
      assetId: input.assetId,
      scope: index === 0 ? (pose ? "人物身份与外观" : "编辑目标") : "参考",
      sha256: input.sha256,
      sourceSha256: input.sourceSha256,
      sourceGenerationId: null,
    });
  }
  const response = await checked(
    await fetch("/api/scene-images/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        prompt,
        referenceImages: references,
        poseEnabled: pose !== null,
        width: pose?.width ?? null,
        height: pose?.height ?? null,
        poseQuery: pose?.query ?? null,
        characterReferenceAssetId: pose?.characterReferenceAssetId ?? null,
        poseSelection: pose?.selection ?? null,
      }),
      signal,
    }),
  );
  let snapshot: SceneTaskSnapshot = await response.json();
  for (;;) {
    onStatus(snapshot);
    if (snapshot.terminal) break;
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", aborted);
        resolve();
      }, 1000);
      signal.addEventListener("abort", aborted, { once: true });
    });
    snapshot = await (
      await checked(await fetch(`/api/scene-images/${runId}`, { signal }))
    ).json();
  }
  if (snapshot.status !== "succeeded") {
    await checked(
      await fetch(`/api/scene-images/${runId}/ack`, { method: "POST", signal }),
    );
    throw new Error(
      snapshot.error ??
        (snapshot.status === "cancelled" ? "已取消生成。" : "图片生成失败。"),
    );
  }
  const blob = await (
    await checked(await fetch(`/api/scene-images/${runId}/result`, { signal }))
  ).blob();
  if (blob.type !== "image/png") throw new Error("生成结果不是 PNG。");
  await checked(
    await fetch(`/api/scene-images/${runId}/ack`, { method: "POST", signal }),
  );
  return blob;
}
