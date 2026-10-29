import { database, atomic, TABLES, collectUnreferenced } from "../db";
import { id, now } from "../domain";
import type { Commit, ImageAsset } from "../images/types";
import { allocateImageId } from "../images/ids";
import { capabilities, validateImageBlob } from "../images/repository";
import { prepareGenerationInputs } from "../images/model-input";
import {
  isActiveGeneration,
  type SceneImagePlan,
  type SceneGeneration,
  type SceneTaskSnapshot,
  type SceneDraft,
} from "./types";
import { validateScenePlan } from "./validation";
import type { Capabilities } from "../images/types";
import { SSEParser } from "../chat/sse";
import {
  initialSceneDraft,
  orderedSceneReferences,
  poseGenerationError,
  selectedScenePose,
} from "./draft";

const following = new Map<string, Promise<void>>();
export function notifySceneImages() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("scene-images-changed"));
}
async function responseError(response: Response): Promise<Error> {
  const error = await response.json();
  return new Error(error.message || "剧情图请求失败。");
}
async function ack(runId: string, commit: Commit) {
  const response = await fetch(`/api/scene-images/${runId}/ack`, {
    method: "POST",
  });
  if (!response.ok) throw await responseError(response);
  const db = await database();
  await commit(async () => {
    const current = await db.get("sceneGenerations", runId);
    if (!current) throw new Error("生图确认对应的记录缺失。");
    await db.put("sceneGenerations", {
      ...current,
      acknowledged: true,
      ...(current.status === "succeeded" ? { error: undefined } : {}),
    });
  });
}

export { initialSceneDraft } from "./draft";

export async function saveSceneDraft(
  planId: string,
  draft: SceneDraft,
  commit: Commit,
) {
  const db = await database();
  await commit(async () => {
    const plan = await db.get("sceneImagePlans", planId);
    if (!plan) throw new Error("画面草稿不存在。");
    // 检索在后台完成时，文本编辑保存不能把同版本的新结果覆盖回旧状态。
    const current = plan.draft;
    if (
      current &&
      current.poseQuery === draft.poseQuery &&
      current.poseSearch.revision >= draft.poseSearch.revision
    )
      draft = {
        ...draft,
        poseSearch: {
          ...current.poseSearch,
          selectedPoseId:
            current.poseSearch.revision === draft.poseSearch.revision &&
            current.poseSearch.status === draft.poseSearch.status
              ? draft.poseSearch.selectedPoseId
              : current.poseSearch.selectedPoseId,
        },
      };
    const sameSelection =
      current &&
      current.poseQuery === draft.poseQuery &&
      current.poseSearch.revision === draft.poseSearch.revision &&
      current.poseSearch.selectedPoseId === draft.poseSearch.selectedPoseId;
    draft = { ...draft, poseEdit: sameSelection ? current.poseEdit : null };
    await db.put("sceneImagePlans", { ...plan, draft });
  });
}

export async function addSceneReferences(
  planId: string,
  assetIds: string[],
  commit: Commit,
) {
  const caps = await capabilities();
  await commit(async () => {
    const db = await database();
    const tx = db.transaction(["sceneImagePlans", "assets"], "readwrite");
    await atomic(tx, async () => {
      const plan = await tx.objectStore("sceneImagePlans").get(planId);
      if (!plan) throw new Error("画面草稿不存在。");
      const draft = initialSceneDraft(plan, caps);
      const selected = [...new Set([...draft.referenceAssetIds, ...assetIds])];
      if (selected.length > caps.imageGeneration.maxReferenceImages)
        throw new Error(
          `最多选择 ${caps.imageGeneration.maxReferenceImages} 张参考图。`,
        );
      const references = [...plan.referenceImages];
      for (const assetId of assetIds) {
        const asset = await tx.objectStore("assets").get(assetId);
        if (!asset) throw new Error(`参考图原件缺失：${assetId}`);
        if (!references.some((ref) => ref.assetId === assetId))
          references.push({
            assetId,
            scope: "用户添加的参考",
            sourceSha256: asset.sha256,
            sourceGenerationId: null,
          });
      }
      await tx.objectStore("sceneImagePlans").put({
        ...plan,
        referenceImages: references,
        draft: { ...draft, referenceAssetIds: selected },
      });
    });
  });
  notifySceneImages();
}

export async function startSceneGeneration(planId: string, commit: Commit) {
  const db = await database();
  const plan = await db.get("sceneImagePlans", planId);
  if (!plan) throw new Error("画面草稿不存在。");
  validateScenePlan(plan);
  const [session, source, generations, caps] = await Promise.all([
    db.get("sessions", plan.sessionId),
    db.get("messages", plan.assistantMessageId),
    db.getAll("sceneGenerations"),
    capabilities(),
  ]);
  if (
    !session ||
    source?.status !== "complete" ||
    source.checkpointVersion !== plan.sourceCheckpointVersion
  )
    throw new Error("画面来源回复已变化，请使用当前回复的生图草稿。");
  if (!caps.imageGeneration.enabled)
    throw new Error("服务端尚未配置生图 Token。");
  if (generations.some((g) => isActiveGeneration(g.status)))
    throw new Error("已有图片正在生成或取消。");
  const draft = initialSceneDraft(plan, caps);
  if (!draft.prompt.trim()) throw new Error("生图提示词不能为空。");
  const align = caps.imageGeneration.dimensionAlignment;
  const width = Math.ceil(draft.width / align) * align;
  const height = Math.ceil(draft.height / align) * align;
  const poseError = poseGenerationError(draft);
  if (poseError) throw new Error(poseError);
  const references = orderedSceneReferences(plan, draft);
  const poseSubmission = structuredClone({
    poseEnabled: draft.poseEnabled,
    poseQuery: draft.poseQuery || null,
    characterReferenceAssetId: draft.characterReferenceAssetId,
    poseSelection: draft.poseEnabled ? selectedScenePose(draft) : null,
  });
  if (references.length > caps.imageGeneration.maxReferenceImages)
    throw new Error(
      "生图参考图数量超限，请移除部分参考，黑色画布占用一个名额。",
    );
  for (const ref of references) {
    if (!ref.sourceSha256)
      throw new Error(`参考原件不可用，请移除后生成：${ref.assetId}`);
    const related = generations.find((g) => g.id === ref.sourceGenerationId);
    if (
      ref.sourceGenerationId &&
      (!related || related.referenceStatus === "rejected")
    )
      throw new Error(`参考图已放弃或不可用，请移除：${ref.assetId}`);
  }
  const previous = generations.filter((g) => g.planId === plan.id).at(-1);
  const generation: SceneGeneration = {
    id: id(),
    sessionId: plan.sessionId,
    planId: plan.id,
    assistantMessageId: plan.assistantMessageId,
    sourceCheckpointVersion: plan.sourceCheckpointVersion,
    sourceSeq: plan.sourceSeq,
    status: "pending",
    referenceStatus: "eligible",
    revision: 0,
    submission: {
      ...poseSubmission,
      prompt: draft.prompt,
      effectivePrompt: null,
      width,
      height,
      referenceImages: [],
    },
    createdAt: now(),
    updatedAt: now(),
    ...(previous ? { supersedesGenerationId: previous.id } : {}),
  };
  await commit(() => db.add("sceneGenerations", generation));
  notifySceneImages();
  let submitted = false;
  try {
    const inputs = await prepareGenerationInputs(
      references,
      caps,
      width,
      height,
    );
    const frozen = inputs.map((input, index) => {
      const ref = references[index];
      if (input.sourceSha256 !== ref.sourceSha256)
        throw new Error(`参考原件与草稿不一致，请重新选择：${ref.assetId}`);
      return { ...ref, sourceSha256: input.sourceSha256, sha256: input.sha256 };
    });
    generation.submission.referenceImages = frozen;
    await commit(() => db.put("sceneGenerations", generation));
    const missingResponse = await fetch("/api/images/missing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashes: inputs.map((input) => input.sha256) }),
    });
    if (!missingResponse.ok) throw await responseError(missingResponse);
    const { missing } = (await missingResponse.json()) as { missing: string[] };
    for (const hash of missing) {
      const input = inputs.find((input) => input.sha256 === hash)!;
      const response = await fetch(`/api/scene-images/inputs/${hash}`, {
        method: "PUT",
        body: input.blob,
      });
      if (!response.ok) throw await responseError(response);
    }
    submitted = true;
    const response = await fetch("/api/scene-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: generation.id,
        source: {
          planId: plan.id,
          sessionId: plan.sessionId,
          assistantMessageId: plan.assistantMessageId,
          sourceSeq: plan.sourceSeq,
          sourceCheckpointVersion: plan.sourceCheckpointVersion,
        },
        ...poseSubmission,
        prompt: generation.submission.prompt,
        width,
        height,
        referenceImages: frozen,
      }),
    });
    if (!response.ok) {
      submitted = false;
      throw await responseError(response);
    }
    // 订阅快照携带最终提交参数；POST 响应丢失也能恢复同一个任务。
    void followSceneGeneration(generation.id, commit).catch(() =>
      notifySceneImages(),
    );
  } catch (error) {
    if (submitted) {
      void followSceneGeneration(generation.id, commit).catch(() =>
        notifySceneImages(),
      );
    } else {
      await commit(() =>
        db.put("sceneGenerations", {
          ...generation,
          status: "failed",
          error: (error as Error).message,
          updatedAt: now(),
        }),
      );
      notifySceneImages();
    }
    throw error;
  }
}

export async function stopSceneGeneration(runId: string) {
  const response = await fetch(`/api/scene-images/${runId}/cancel`, {
    method: "POST",
  });
  if (!response.ok) throw await responseError(response);
}

export async function saveGeneratedImage(
  generation: SceneGeneration,
  plan: SceneImagePlan,
  blob: Blob,
  commit: Commit,
) {
  const caps = await capabilities();
  if (blob.type.split(";")[0] !== "image/png")
    throw new Error("生成结果不是 PNG。");
  const info = await validateImageBlob(blob, {
    maxImageBytes: caps.imageGeneration.maxOutputBytes,
    maxPixels: caps.imageGeneration.maxOutputPixels,
    maxRequestBytes: caps.maxRequestBytes,
  });
  await commit(async () => {
    const db = await database();
    const tx = db.transaction(
      ["assets", "settings", "sceneGenerations", "sessions"],
      "readwrite",
    );
    await atomic(tx, async () => {
      const current = await tx
        .objectStore("sceneGenerations")
        .get(generation.id);
      if (
        !current ||
        !(await tx.objectStore("sessions").get(generation.sessionId))
      )
        throw new Error("生成结果对应的会话或记录已删除。");
      if (current.assetId) return;
      let asset = await tx
        .objectStore("assets")
        .index("sha256")
        .get(info.sha256);
      if (!asset) {
        asset = {
          id: await allocateImageId(tx),
          creationOrigin: "generated",
          ...info,
          originalBlob: blob,
          mimeType: "image/png",
          byteSize: blob.size,
          displayName: `剧情图-${plan.sourceSeq}.png`,
          createdAt: now(),
        } satisfies ImageAsset;
        await tx.objectStore("assets").add(asset);
      }
      await tx.objectStore("sceneGenerations").put({
        ...current,
        status: "succeeded",
        assetId: asset.id,
        error: undefined,
        updatedAt: now(),
      });
    });
  });
  notifySceneImages();
}

export function followSceneGeneration(
  runId: string,
  commit: Commit,
): Promise<void> {
  const existing = following.get(runId);
  if (existing) return existing;
  const current = follow(runId, commit)
    .catch(async (error) => {
      const db = await database();
      await commit(async () => {
        const generation = await db.get("sceneGenerations", runId);
        if (!generation) throw new Error("生图恢复记录缺失。");
        await db.put("sceneGenerations", {
          ...generation,
          error: `取回结果失败，可重试：${(error as Error).message}`,
        });
      });
      notifySceneImages();
      throw error;
    })
    .finally(() => following.delete(runId));
  following.set(runId, current);
  return current;
}
async function follow(runId: string, commit: Commit) {
  const db = await database();
  for (;;) {
    const generation = await db.get("sceneGenerations", runId);
    if (!generation) throw new Error("生图任务记录缺失。");
    if (
      generation.status === "succeeded" ||
      ["cancelled", "failed", "unknown"].includes(generation.status)
    ) {
      if (!generation.acknowledged) await ack(runId, commit);
      return;
    }
    let response: Response;
    try {
      response = await fetch(`/api/scene-images/${runId}/events`, {
        headers: { Accept: "text/event-stream" },
      });
    } catch {
      await reconnect();
      continue;
    }
    if (response.status === 404) {
      await commit(() =>
        db.put("sceneGenerations", {
          ...generation,
          status: "unknown",
          error: "后台任务不存在或结果过期，请手动重新生成。",
          updatedAt: now(),
        }),
      );
      notifySceneImages();
      return;
    }
    if (!response.ok) throw await responseError(response);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let applying = Promise.resolve();
    let terminal = false;
    let applyError: unknown;
    const parser = new SSEParser((event) => {
      if (event.name !== "snapshot") return;
      const snapshot = JSON.parse(event.data) as SceneTaskSnapshot;
      applying = applying
        .then(async () => {
          if (applyError) return;
          let current = await db.get("sceneGenerations", runId);
          if (!current) throw new Error("生图记录已删除。");
          if (current.assetId || snapshot.revision < current.revision) return;
          current = { ...current, submission: snapshot.submission };
          await commit(() => db.put("sceneGenerations", current!));
          if (snapshot.status === "succeeded") {
            const result = await fetch(`/api/scene-images/${runId}/result`);
            if (!result.ok) throw await responseError(result);
            const plan = await db.get("sceneImagePlans", current.planId);
            if (!plan) throw new Error("生成结果缺少冻结画面计划。");
            await saveGeneratedImage(
              current,
              plan,
              await result.blob(),
              commit,
            );
            await ack(runId, commit);
          } else {
            await commit(() =>
              db.put("sceneGenerations", {
                ...current,
                status: snapshot.status,
                revision: snapshot.revision,
                error: snapshot.error ?? undefined,
                updatedAt: now(),
              }),
            );
            if (snapshot.terminal) await ack(runId, commit);
          }
          terminal = snapshot.terminal;
          notifySceneImages();
        })
        .catch((error) => {
          applyError = error;
        });
    });
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          parser.feed(decoder.decode());
          break;
        }
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
    } catch {
      /* 只重订阅原任务。 */
    } finally {
      reader.releaseLock();
    }
    await applying;
    if (applyError) throw applyError;
    if (terminal) return;
    await reconnect();
  }
}
function reconnect() {
  return new Promise((resolve) => setTimeout(resolve, 1000));
}

export async function resumeSceneGenerations(commit: Commit) {
  const db = await database();
  const generations = await db.getAll("sceneGenerations");
  for (const generation of generations.filter((g) => !g.acknowledged))
    void followSceneGeneration(generation.id, commit).catch(() =>
      notifySceneImages(),
    );
}
export async function rejectSceneGeneration(runId: string, commit: Commit) {
  const db = await database();
  await commit(async () => {
    const tx = db.transaction(TABLES, "readwrite");
    await atomic(tx, async () => {
      const generation = await tx.objectStore("sceneGenerations").get(runId);
      if (!generation || generation.status !== "succeeded")
        throw new Error("只能放弃已生成图片。");
      await tx.objectStore("sceneGenerations").put({
        ...generation,
        referenceStatus: "rejected",
        rejectionReason: "用户放弃这张图片",
        updatedAt: now(),
      });
      await collectUnreferenced(tx);
    });
  });
  notifySceneImages();
}
