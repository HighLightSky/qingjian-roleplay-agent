import { assertImageId } from "../images/ids";
import { object, string, integer, array } from "../state/validation";
import type { SceneImagePlan, SceneGeneration } from "./types";

function references(value: unknown, input: boolean) {
  array(value, 10000);
  const seen = new Set<string>();
  for (const ref of value) {
    object(ref);
    assertImageId(ref.assetId);
    if (seen.has(ref.assetId)) throw new Error("画面参考图重复。");
    seen.add(ref.assetId);
    string(ref.scope);
    if (ref.sourceSha256 !== null || input) {
      string(ref.sourceSha256, 64);
      if (!/^[a-f0-9]{64}$/.test(ref.sourceSha256))
        throw new Error("参考原件哈希无效。");
    }
    if (ref.sourceGenerationId !== null) string(ref.sourceGenerationId, 200);
    if (input && ref.sha256 !== null) {
      string(ref.sha256, 64);
      if (!/^[a-f0-9]{64}$/.test(ref.sha256))
        throw new Error("参考传输版本哈希无效。");
    }
  }
}

export function validateScenePlan(
  value: unknown,
): asserts value is SceneImagePlan {
  object(value);
  for (const key of ["id", "sessionId", "assistantMessageId"]) {
    string(value[key], 200);
    if (!value[key]) throw new Error("画面草稿缺少来源标识。");
  }
  for (const key of ["sourceSeq", "sourceCheckpointVersion", "profileVersion"])
    integer(value[key], 1);
  string(value.prompt);
  if (value.error !== null) string(value.error);
  references(value.referenceImages, false);
  if (value.draft !== undefined) {
    object(value.draft);
    string(value.draft.prompt);
    integer(value.draft.width, 1);
    integer(value.draft.height, 1);
    array(value.draft.referenceAssetIds, 10000);
    for (const id of value.draft.referenceAssetIds) {
      assertImageId(id);
      if (
        !(value.referenceImages as { assetId: string }[]).some(
          (ref) => ref.assetId === id,
        )
      )
        throw new Error("编辑草稿引用未知参考图。");
    }
  }
}

export function validateSceneGeneration(
  value: unknown,
): asserts value is SceneGeneration {
  object(value);
  for (const key of ["id", "sessionId", "planId", "assistantMessageId"])
    string(value[key], 200);
  for (const key of ["sourceSeq", "sourceCheckpointVersion"])
    integer(value[key], 1);
  integer(value.revision);
  if (
    ![
      "pending",
      "running",
      "cancelling",
      "succeeded",
      "failed",
      "cancelled",
      "unknown",
    ].includes(value.status as string) ||
    !["eligible", "rejected"].includes(value.referenceStatus as string)
  )
    throw new Error("生成记录状态无效。");
  object(value.submission);
  string(value.submission.prompt);
  if (value.submission.effectivePrompt !== null)
    string(value.submission.effectivePrompt);
  for (const field of ["width", "height"])
    if (value.submission[field] !== null) integer(value.submission[field], 1);
  references(value.submission.referenceImages, true);
  if (value.assetId !== undefined) assertImageId(value.assetId);
  if (value.status === "succeeded" && !value.assetId)
    throw new Error("成功生成记录缺少图像资产。");
}
