import { validatePoseScene } from "../pose-editor/scene";
import { assertImageId } from "../images/ids";
import { object, string, integer, array } from "../state/validation";
import type {
  SceneImagePlan,
  SceneGeneration,
  PoseSelection,
  PoseSearch,
} from "./types";

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
  if (value.poseQuery !== null) string(value.poseQuery);
  if (value.characterReferenceAssetId !== null)
    assertImageId(value.characterReferenceAssetId);
  if (value.error !== null) string(value.error);
  references(value.referenceImages, false);
  if (
    value.characterReferenceAssetId !== null &&
    !(value.referenceImages as { assetId: string }[]).some(
      (ref) => ref.assetId === value.characterReferenceAssetId,
    )
  )
    throw new Error("画面计划的人物参考不在参考清单中。");
  if (value.draft !== undefined) {
    object(value.draft);
    string(value.draft.prompt);
    if (typeof value.draft.poseEnabled !== "boolean")
      throw new Error("姿势参考开关无效。");
    string(value.draft.poseQuery);
    if (value.draft.characterReferenceAssetId !== null)
      assertImageId(value.draft.characterReferenceAssetId);
    validatePoseSearch(value.draft.poseSearch);
    if (value.draft.poseEdit !== null) {
      const edit = value.draft.poseEdit;
      object(edit);
      string(edit.sourcePoseId);
      string(edit.runtimeRevision);
      integer(edit.searchRevision, 0);
      if (
        edit.sourcePoseId !== value.draft.poseSearch.selectedPoseId ||
        edit.searchRevision !== value.draft.poseSearch.revision
      )
        throw new Error("编辑姿态对应的候选或检索版本已变化。");
      validatePoseScene(edit.scene);
    }
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
    if (
      value.draft.characterReferenceAssetId !== null &&
      !(value.draft.referenceAssetIds as string[]).includes(
        value.draft.characterReferenceAssetId as string,
      )
    )
      throw new Error("草稿的人物参考必须是已选参考图。");
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
  if (typeof value.submission.poseEnabled !== "boolean")
    throw new Error("提交快照缺少姿势参考开关。");
  if (value.submission.poseQuery !== null) string(value.submission.poseQuery);
  if (value.submission.characterReferenceAssetId !== null)
    assertImageId(value.submission.characterReferenceAssetId);
  if (value.submission.poseEnabled) {
    if (
      !value.submission.poseQuery ||
      !value.submission.characterReferenceAssetId
    )
      throw new Error("姿势提交快照缺少描述或人物参考。");
    validatePoseSelection(value.submission.poseSelection);
  } else if (value.submission.poseSelection !== null)
    throw new Error("普通生图快照不能携带姿势候选。");
  if (value.assetId !== undefined) assertImageId(value.assetId);
  if (value.status === "succeeded" && !value.assetId)
    throw new Error("成功生成记录缺少图像资产。");
}

export function validatePoseSelection(
  value: unknown,
  maxBytes?: number,
): asserts value is PoseSelection {
  object(value);
  string(value.poseId);
  if (
    !value.poseId ||
    typeof value.score !== "number" ||
    !Number.isFinite(value.score)
  )
    throw new Error("姿势候选标识或相似度无效。");
  object(value.description);
  for (const key of ["zh", "en"]) {
    string(value.description[key]);
    if (!(value.description[key] as string).trim())
      throw new Error("姿势候选缺少中英文描述。");
  }
  object(value.pose);
  if (!Object.keys(value.pose).length)
    throw new Error("姿势候选缺少完整 pose 对象。");
  if (
    maxBytes !== undefined &&
    new Blob([JSON.stringify(value.pose)]).size > maxBytes
  )
    throw new Error("姿势对象超过体积限制。");
}

function validatePoseSearch(value: unknown): asserts value is PoseSearch {
  object(value);
  if (
    !["idle", "searching", "succeeded", "failed"].includes(
      value.status as string,
    )
  )
    throw new Error("姿势检索状态无效。");
  if (value.query !== null) string(value.query);
  integer(value.revision, 0);
  array(value.matches, 10000);
  const ids = new Set<string>();
  for (const match of value.matches) {
    validatePoseSelection(match);
    if (ids.has(match.poseId)) throw new Error("姿势候选重复。");
    ids.add(match.poseId);
  }
  if (value.selectedPoseId !== null) {
    string(value.selectedPoseId);
    if (!ids.has(value.selectedPoseId))
      throw new Error("选中的姿势候选不存在。");
  }
  if (value.error !== null) string(value.error);
}
