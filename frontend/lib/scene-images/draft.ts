import type { Capabilities } from "../images/types";
import type { SceneDraft, SceneImagePlan, PoseSearch } from "./types";

export function emptyPoseSearch(revision = 0): PoseSearch {
  return {
    status: "idle",
    query: null,
    revision,
    matches: [],
    selectedPoseId: null,
    error: null,
  };
}

export function initialSceneDraft(
  plan: SceneImagePlan,
  caps: Capabilities,
): SceneDraft {
  return (
    plan.draft ?? {
      prompt: plan.prompt,
      width: caps.imageGeneration.defaultWidth,
      height: caps.imageGeneration.defaultHeight,
      referenceAssetIds: plan.referenceImages.map((ref) => ref.assetId),
      poseEnabled: plan.poseQuery !== null,
      poseQuery: plan.poseQuery ?? "",
      characterReferenceAssetId: plan.characterReferenceAssetId,
      poseSearch: emptyPoseSearch(),
    }
  );
}

export function withPoseQuery(draft: SceneDraft, query: string): SceneDraft {
  return {
    ...draft,
    poseQuery: query,
    poseSearch: emptyPoseSearch(draft.poseSearch.revision + 1),
  };
}

export function orderedSceneReferences(
  plan: SceneImagePlan,
  draft: SceneDraft,
) {
  const references = plan.referenceImages.filter((ref) =>
    draft.referenceAssetIds.includes(ref.assetId),
  );
  if (!draft.poseEnabled) return references;
  return references.sort(
    (a, b) =>
      Number(b.assetId === draft.characterReferenceAssetId) -
      Number(a.assetId === draft.characterReferenceAssetId),
  );
}

export function poseGenerationError(draft: SceneDraft): string | null {
  if (!draft.poseEnabled) return null;
  if (!draft.poseQuery.trim()) return "请填写姿态检索描述。";
  if (
    !draft.characterReferenceAssetId ||
    !draft.referenceAssetIds.includes(draft.characterReferenceAssetId)
  )
    return "请选择人物参考图，作为 image2。";
  if (draft.poseSearch.status === "searching") return "正在检索姿势，请稍候。";
  if (
    draft.poseSearch.query !== draft.poseQuery ||
    draft.poseSearch.status !== "succeeded"
  )
    return "请使用当前姿态描述重新检索，并选择候选。";
  if (!draft.poseSearch.selectedPoseId) return "请选择一个姿势候选。";
  return null;
}
