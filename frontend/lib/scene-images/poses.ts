import { database } from "../db";
import { capabilities } from "../images/repository";
import type { Commit } from "../images/types";
import type { PoseSelection } from "./types";
import { initialSceneDraft, emptyPoseSearch } from "./draft";
import { notifySceneImages } from "./coordinator";
import { array } from "../state/validation";
import { validatePoseSelection } from "./validation";

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
  let revision = 0;
  await commit(async () => {
    const plan = await db.get("sceneImagePlans", planId);
    if (!plan) throw new Error("姿势检索对应的画面草稿不存在。");
    const draft = initialSceneDraft(plan, caps);
    if (!draft.poseQuery.trim()) throw new Error("姿态检索描述不能为空。");
    query = draft.poseQuery;
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
    const response = await fetch("/api/scene-images/poses/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`${error.code}：${error.message}`);
    }
    // 在读取过程中限流，不能先无界加载完整候选再检查大小。
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > caps.imageGeneration.poseSearchMaxResponseBytes) {
          await reader.cancel();
          throw new Error("姿势检索响应超过体积限制。");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let result: { matches: unknown };
    try {
      result = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("姿势 JSON 格式错误。");
    }
    array(result.matches, caps.imageGeneration.poseSearchTopK);
    const ids = new Set<string>();
    for (const match of result.matches) {
      validatePoseSelection(match, caps.imageGeneration.poseMaxBytes);
      if (ids.has(match.poseId)) throw new Error("姿势检索返回了重复候选。");
      ids.add(match.poseId);
    }
    await commit(async () => {
      const plan = await db.get("sceneImagePlans", planId);
      if (
        !plan ||
        plan.draft?.poseQuery !== query ||
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
            matches: result.matches as PoseSelection[],
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
