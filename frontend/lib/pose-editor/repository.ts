import { database } from "../db";
import type { Commit } from "../images/types";
import type { JsonObject } from "../scene-images/types";
import { capabilities } from "../images/repository";
import { validatePoseScene } from "./scene";
import { POSE_RUNTIME_REVISION } from "./version";
import { notifySceneImages } from "../scene-images/coordinator";

export type EditBinding = { sourcePoseId: string; searchRevision: number };

export async function applyPoseEdit(
  planId: string,
  binding: EditBinding,
  scene: JsonObject,
  commit: Commit,
) {
  validatePoseScene(scene);
  const caps = await capabilities();
  if (
    new Blob([JSON.stringify(scene)]).size > caps.imageGeneration.poseMaxBytes
  )
    throw new Error("编辑后的姿势超过生图体积限制。");
  const frozen = structuredClone(scene);
  await commit(async () => {
    const db = await database();
    const plan = await db.get("sceneImagePlans", planId);
    if (!plan?.draft) throw new Error("姿势编辑对应的草稿不存在。");
    const draft = plan.draft;
    if (
      draft.poseSearch.selectedPoseId !== binding.sourcePoseId ||
      draft.poseSearch.revision !== binding.searchRevision
    )
      throw new Error("姿势候选或检索版本已变化，请重新打开编辑器。");
    await db.put("sceneImagePlans", {
      ...plan,
      draft: {
        ...draft,
        poseEdit: {
          ...binding,
          runtimeRevision: POSE_RUNTIME_REVISION,
          scene: frozen,
        },
      },
    });
  });
  notifySceneImages();
}

export async function resetPoseEdit(planId: string, commit: Commit) {
  await commit(async () => {
    const db = await database();
    const plan = await db.get("sceneImagePlans", planId);
    if (!plan?.draft) throw new Error("姿势编辑对应的草稿不存在。");
    await db.put("sceneImagePlans", {
      ...plan,
      draft: { ...plan.draft, poseEdit: null },
    });
  });
  notifySceneImages();
}
