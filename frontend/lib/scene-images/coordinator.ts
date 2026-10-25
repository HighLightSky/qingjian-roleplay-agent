import { database, atomic } from "../db";
import { now } from "../domain";
import type { Commit, ImageAsset } from "../images/types";
import { allocateImageId } from "../images/ids";
import { capabilities, validateImageBlob } from "../images/repository";
import { prepareGenerationInputs } from "../images/model-input";
import {
  isActiveGeneration,
  type SceneImagePlan,
  type SceneGeneration,
  type SceneTaskSnapshot,
} from "./types";
import { validateScenePlan } from "./validation";
import { SSEParser } from "../chat/sse";

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

export async function startSceneGeneration(planId: string, commit: Commit) {
  const db = await database();
  const plan = await db.get("sceneImagePlans", planId);
  if (!plan) throw new Error("画面计划不存在。");
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
    source.checkpointVersion !== plan.sourceCheckpointVersion ||
    session.profileVersion !== plan.profileVersion ||
    plan.status !== "ready"
  )
    throw new Error("画面来源已变化或计划不可执行。");
  if (!caps.imageGeneration.enabled)
    throw new Error("服务端尚未配置生图 Token。");
  if (generations.some((g) => isActiveGeneration(g.status)))
    throw new Error("已有图片正在生成或取消。");
  if (plan.referenceImages.length > caps.maxImages)
    throw new Error("生图参考图片数量超限。");
  for (const ref of plan.referenceImages) {
    const related = generations.find((g) => g.id === ref.sourceGenerationId);
    if (
      ref.sourceGenerationId &&
      (!related || related.referenceStatus === "rejected")
    )
      throw new Error("参考图已被标记有误，请先重新规划。");
  }
  const previous = generations.filter((g) => g.planId === plan.id).at(-1);
  const generation: SceneGeneration = {
    id: crypto.randomUUID(),
    sessionId: plan.sessionId,
    planId: plan.id,
    assistantMessageId: plan.assistantMessageId,
    sourceCheckpointVersion: plan.sourceCheckpointVersion,
    sourceSeq: plan.sourceSeq,
    sceneId: plan.sceneId,
    status: "pending",
    referenceStatus: "eligible",
    revision: 0,
    createdAt: now(),
    updatedAt: now(),
    ...(previous ? { supersedesGenerationId: previous.id } : {}),
  };
  await commit(() => db.add("sceneGenerations", generation));
  notifySceneImages();
  let submitted = false;
  try {
    const inputs = await prepareGenerationInputs(plan.referenceImages, caps);
    if (
      inputs.some(
        (input, index) =>
          input.sourceSha256 !== plan.referenceImages[index].sourceSha256,
      )
    )
      throw new Error("参考原件与冻结计划不一致。");
    const missingResponse = await fetch("/api/images/missing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashes: inputs.map((i) => i.sha256) }),
    });
    if (!missingResponse.ok) throw await responseError(missingResponse);
    const { missing } = (await missingResponse.json()) as { missing: string[] };
    for (const hash of missing) {
      const input = inputs.find((i) => i.sha256 === hash)!;
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
        plan,
        character: {
          ...session.characterSnapshot,
          profileVersion: session.profileVersion,
        },
        images: inputs.map(({ assetId, sha256, sourceSha256 }) => ({
          assetId,
          sha256,
          sourceSha256,
        })),
      }),
    });
    if (!response.ok) {
      submitted = false;
      throw await responseError(response);
    }
    void followSceneGeneration(generation.id, commit).catch(() =>
      notifySceneImages(),
    );
  } catch (error) {
    if (submitted) {
      // POST 可能已经被接受，只查询原任务，不重发生成。
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
          const current = await db.get("sceneGenerations", runId);
          if (!current) throw new Error("生图记录已删除。");
          if (current.assetId || snapshot.revision < current.revision) return;
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
  const generation = await db.get("sceneGenerations", runId);
  if (!generation || generation.status !== "succeeded")
    throw new Error("只能排除已生成图片。");
  await commit(() =>
    db.put("sceneGenerations", {
      ...generation,
      referenceStatus: "rejected",
      rejectionReason: "用户标记图片有误",
      updatedAt: now(),
    }),
  );
  notifySceneImages();
}
