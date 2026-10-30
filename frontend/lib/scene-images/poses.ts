import { database } from "../db";
import { capabilities } from "../images/repository";
import type { Commit } from "../images/types";
import type { PoseLibrary } from "./types";
import { initialSceneDraft, emptyPoseSearch } from "./draft";
import { notifySceneImages } from "./coordinator";
import { requestPoseSearch } from "./pose-search";

const searching = new Map<string, Promise<void>>();

export function searchScenePoses(
  planId: string,
  commit: Commit,
): Promise<void> {
  const pending = search(planId, commit).finally(() => {
    if (searching.get(planId) === pending) searching.delete(planId);
  });
  searching.set(planId, pending);
  return pending;
}

async function search(planId: string, commit: Commit) {
  const db = await database();
  const caps = await capabilities();
  let query = "";
  let library: PoseLibrary = "default";
  let revision = 0;
  await commit(async () => {
    const plan = await db.get("sceneImagePlans", planId);
    if (!plan) throw new Error("姿势检索对应的画面草稿不存在。");
    const draft = initialSceneDraft(plan, caps);
    if (!draft.poseQuery.trim()) throw new Error("姿态检索描述不能为空。");
    query = draft.poseQuery;
    library = draft.poseLibrary;
    revision = draft.poseSearch.revision + 1;
    await db.put("sceneImagePlans", {
      ...plan,
      draft: {
        ...draft,
        poseEdit: null,
        poseSearch: {
          ...emptyPoseSearch(revision),
          query,
          status: "searching",
        },
      },
    });
  });
  notifySceneImages();
  try {
    const matches = await requestPoseSearch(
      query,
      library,
      caps.imageGeneration,
    );
    await commit(async () => {
      const plan = await db.get("sceneImagePlans", planId);
      if (
        !plan ||
        plan.draft?.poseQuery !== query ||
        plan.draft.poseLibrary !== library ||
        plan.draft.poseSearch.revision !== revision
      )
        return;
      await db.put("sceneImagePlans", {
        ...plan,
        draft: {
          ...plan.draft,
          poseSearch: {
            status: "succeeded",
            query,
            revision,
            matches,
            selectedPoseId: null,
            error: null,
          },
        },
      });
    });
  } catch (error) {
    await commit(async () => {
      const plan = await db.get("sceneImagePlans", planId);
      if (
        !plan ||
        plan.draft?.poseQuery !== query ||
        plan.draft.poseLibrary !== library ||
        plan.draft.poseSearch.revision !== revision
      )
        return;
      await db.put("sceneImagePlans", {
        ...plan,
        draft: {
          ...plan.draft,
          poseSearch: {
            ...emptyPoseSearch(revision),
            query,
            status: "failed",
            error: (error as Error).message,
          },
        },
      });
    });
  }
  notifySceneImages();
}

export async function resumeScenePoseSearches(commit: Commit) {
  const db = await database();
  const plans = (await db.getAll("sceneImagePlans")).filter(
    (plan) => plan.draft?.poseEnabled ?? plan.poseQuery !== null,
  );
  if (!plans.length) return;
  const caps = await capabilities();
  if (!caps.imageGeneration.enabled) return;
  // 串行检索，避免刷新恢复多个草稿时占满远端仅两个检索名额。
  for (const row of plans) {
    const plan = await db.get("sceneImagePlans", row.id);
    if (!plan || searching.has(plan.id)) continue;
    const draft = initialSceneDraft(plan, caps);
    if (
      draft.poseEnabled &&
      draft.poseQuery.trim() &&
      ((!plan.draft && plan.poseQuery !== null) ||
        draft.poseSearch.status === "searching")
    )
      await searchScenePoses(plan.id, commit);
  }
}
