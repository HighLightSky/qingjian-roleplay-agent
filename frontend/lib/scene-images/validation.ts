import { assertImageId } from "../images/ids";
import { object, string, integer, array } from "../state/validation";
import type { SceneImagePlan, SceneGeneration } from "./types";

export function validateScenePlan(
  value: unknown,
): asserts value is SceneImagePlan {
  object(value);
  for (const key of ["id", "sessionId", "assistantMessageId", "sceneId"]) {
    string(value[key], 200);
    if (!value[key]) throw new Error("画面计划缺少来源标识。");
  }
  for (const key of ["sourceSeq", "sourceCheckpointVersion", "profileVersion"])
    integer(value[key], 1);
  if (
    !["ready", "reuse", "unavailable", "invalid"].includes(
      value.status as string,
    ) ||
    !["new_scene", "continue_scene", "restage"].includes(
      value.continuity as string,
    )
  )
    throw new Error("画面计划状态无效。");
  string(value.previousPlanId, 200);
  string(value.prompt);
  string(value.summary);
  string(value.fingerprint, 64);
  if (!/^[a-f0-9]{64}$/.test(value.fingerprint))
    throw new Error("画面计划指纹无效。");
  object(value.target);
  for (const field of Object.values(value.target)) string(field);
  array(value.referenceImages, 10000);
  const seen = new Set<string>();
  for (const reference of value.referenceImages) {
    object(reference);
    assertImageId(reference.assetId);
    if (seen.has(reference.assetId)) throw new Error("画面参考图重复。");
    seen.add(reference.assetId);
    string(reference.scope);
    string(reference.sourceSha256, 64);
    if (!/^[a-f0-9]{64}$/.test(reference.sourceSha256))
      throw new Error("画面参考图哈希无效。");
    if (reference.sourceGenerationId !== null)
      string(reference.sourceGenerationId, 200);
    array(reference.roles, 7);
    if (
      !reference.roles.length ||
      reference.roles.some(
        (role) =>
          ![
            "base",
            "identity",
            "continuity",
            "outfit",
            "environment",
            "pose",
            "prop",
          ].includes(role as string),
      )
    )
      throw new Error("参考图用途无效。");
  }
}

export function validateSceneGeneration(
  value: unknown,
): asserts value is SceneGeneration {
  object(value);
  for (const key of [
    "id",
    "sessionId",
    "planId",
    "assistantMessageId",
    "sceneId",
  ])
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
  if (value.assetId !== undefined) assertImageId(value.assetId);
  if (value.status === "succeeded" && !value.assetId)
    throw new Error("成功生成记录缺少图像资产。");
}
