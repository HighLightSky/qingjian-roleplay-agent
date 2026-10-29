import { emptyPoseSearch } from "../lib/scene-images/draft";
import "fake-indexeddb/auto";
import { beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  database,
  TABLES,
  saveCharacter,
  createSession,
  beginTurn,
  checkpoint,
  allMessages,
  deleteSession,
} from "../lib/db";
import { sha256 } from "../lib/images/hash";
import { IMAGE_SEQUENCE_KEY } from "../lib/images/ids";
import { now } from "../lib/domain";
import { buildCatalog } from "../lib/images/coordinator";
import { takeSnapshot, validateBackup, restoreSnapshot } from "../lib/backup";
import { prepareGenerationInputs } from "../lib/images/model-input";
import {
  startSceneGeneration,
  followSceneGeneration,
  rejectSceneGeneration,
  saveGeneratedImage,
} from "../lib/scene-images/coordinator";
import type {
  SceneImagePlan,
  SceneGeneration,
} from "../lib/scene-images/types";
import type { Capabilities } from "../lib/images/types";
import { contextCapabilities } from "./context-fixture";

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP2kAAAAASUVORK5CYII=",
    "base64",
  ),
);
const hash = sha256(png);
const caps: Capabilities = {
  ...contextCapabilities,
  imageGeneration: {
    enabled: true,
    poseMaxBytes: 1048576,
    poseSearchMaxRequestBytes: 65536,
    poseSearchMaxResponseBytes: 4194304,
    poseSearchTopK: 3,
    defaultWidth: 256,
    defaultHeight: 512,
    dimensionAlignment: 32,
    maxReferenceImages: 9,
    maxImageBytes: 16777216,
    maxPixels: 4194304,
    maxEdge: 8192,
    maxTotalPixels: 16777216,
    maxRequestBytes: 134217728,
    maxPromptCharacters: 16384,
    maxOutputBytes: 67108864,
    maxOutputPixels: 20000000,
    referenceMaxEdge: 1024,
    referenceJpegQuality: 0.85,
  },
};
const commit = <T>(work: () => Promise<T>) => work();
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  for (const table of TABLES) await tx.objectStore(table).clear();
  await tx.objectStore("settings").put({ key: IMAGE_SEQUENCE_KEY, value: "1" });
  await tx.done;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
async function fixture() {
  const db = await database();
  const blob = new Blob([png], { type: "image/png" });
  await db.put("assets", {
    id: "img1",
    creationOrigin: "uploaded",
    sha256: hash,
    mimeType: "image/png",
    byteSize: png.length,
    width: 1,
    height: 1,
    displayName: "身份.png",
    originalBlob: blob,
    createdAt: now(),
  });
  const character = await saveCharacter({
    name: "林溪",
    identity: "",
    description: "",
    appearancePhotoAssetId: "img1",
  });
  const session = await createSession(character.id);
  const turn = await beginTurn(session.id, "画一下当前场景");
  await checkpoint({
    ...turn.assistant,
    status: "complete",
    checkpointVersion: 1,
    segments: [{ kind: "narration", text: "她坐在窗边。" }],
  });
  const plan: SceneImagePlan = {
    id: "plan",
    sessionId: session.id,
    assistantMessageId: turn.assistant.id,
    sourceSeq: turn.assistant.seq,
    sourceCheckpointVersion: 1,
    profileVersion: session.profileVersion,
    referenceImages: [
      {
        assetId: "img1",
        scope: "仅身份",
        sourceSha256: hash,
        sourceGenerationId: null,
      },
    ],
    prompt: "[参考图说明]参照 <image1> 的人物。\n[画面摘要]白裙人物坐在窗边。",
    poseQuery: null,
    characterReferenceAssetId: null,
    error: null,
  };
  await db.put("sceneImagePlans", plan);
  const generation: SceneGeneration = {
    id: "generated",
    sessionId: session.id,
    planId: plan.id,
    assistantMessageId: plan.assistantMessageId,
    sourceCheckpointVersion: 1,
    sourceSeq: plan.sourceSeq,
    submission: {
      poseEnabled: false,
      poseQuery: null,
      characterReferenceAssetId: null,
      poseSelection: null,
      prompt: plan.prompt,
      effectivePrompt: plan.prompt,
      width: 256,
      height: 512,
      referenceImages: plan.referenceImages.map((ref) => ({
        ...ref,
        sourceSha256: hash,
        sha256: hash,
      })),
    },
    status: "running",
    referenceStatus: "eligible",
    revision: 1,
    createdAt: now(),
    updatedAt: now(),
  };
  return { db, session, turn, plan, generation, blob };
}

test("点击生成只提交一次；结果先原子入库再 ACK；哈希去重保留首次上传出处", async () => {
  const { db, plan, session, blob } = await fixture();
  let starts = 0,
    acknowledgements = 0;
  const calls: string[] = [];
  globalThis.fetch = async (path, init) => {
    calls.push(String(path));
    if (path === "/api/capabilities") return Response.json(caps);
    if (path === "/api/images/missing") return Response.json({ missing: [] });
    if (path === "/api/scene-images") {
      starts++;
      const request = JSON.parse(String(init!.body));
      assert.equal(request.referenceImages[0].sha256, hash);
      assert.equal(request.width, 256);
      assert.equal(request.height, 512);
      return Response.json({ runId: request.runId });
    }
    if (String(path).endsWith("/events")) {
      const runId = String(path).split("/")[3];
      return new Response(
        `event: snapshot\ndata: ${JSON.stringify({ runId, revision: 2, status: "succeeded", error: null, errorCode: null, terminal: true, submission: { prompt: plan.prompt, effectivePrompt: plan.prompt, width: 256, height: 512, referenceImages: [] } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (String(path).endsWith("/result")) return new Response(blob);
    if (String(path).endsWith("/ack")) {
      assert.equal(
        (await db.getAll("sceneGenerations"))[0].status,
        "succeeded",
      );
      assert.equal((await db.getAll("sceneGenerations"))[0].assetId, "img1");
      acknowledgements++;
      return new Response(null, { status: 200 });
    }
    throw new Error(`意外请求：${path}`);
  };
  await startSceneGeneration(plan.id, commit);
  const generation = (await db.getAll("sceneGenerations"))[0];
  await followSceneGeneration(generation.id, commit);
  assert.equal(starts, 1);
  assert.equal(acknowledgements, 1);
  assert.equal((await db.get("assets", "img1"))!.creationOrigin, "uploaded");
  assert.equal((await db.get("sessions", session.id))!.stateVersion, 0);
  const catalog = await buildCatalog(session.id, await allMessages(session.id));
  const source = catalog.assetCatalog[0].sources.find(
    (s) => s.type === "scene_generation",
  );
  assert.equal(source?.summary, plan.prompt);
  assert.equal(catalog.assetCatalog[0].observation, null);
  assert.equal(
    calls.some((path) => path.includes("/state/") || path.includes("/chat")),
    false,
  );
  await rejectSceneGeneration(generation.id, commit);
  assert.equal(
    (
      await buildCatalog(session.id, await allMessages(session.id))
    ).assetCatalog[0].sources.some((s) => s.type === "scene_generation"),
    false,
  );
});

test("未取回任务恢复仅查询；404 标记未知，不自动发生成请求", async () => {
  const { db, generation } = await fixture();
  await db.put("sceneGenerations", generation);
  const calls: string[] = [];
  globalThis.fetch = async (path) => {
    calls.push(String(path));
    return Response.json({ message: "任务不存在" }, { status: 404 });
  };
  await followSceneGeneration(generation.id, commit);
  assert.deepEqual(calls, [`/api/scene-images/${generation.id}/events`]);
  assert.equal(
    (await db.get("sceneGenerations", generation.id))!.status,
    "unknown",
  );
});

test("在途生成禁止删会话和导入；原件锚点不被缩略图替换", async () => {
  const { db, generation, plan, blob } = await fixture();
  await db.put("sceneGenerations", generation);
  await assert.rejects(deleteSession(generation.sessionId), /仍在生图/);
  await assert.rejects(restoreSnapshot(await takeSnapshot()), /存在活跃生图/);
  const inputs = await prepareGenerationInputs(
    plan.referenceImages,
    caps,
    256,
    512,
  );
  assert.deepEqual(
    new Uint8Array(await inputs[0].blob.arrayBuffer()),
    new Uint8Array(await blob.arrayBuffer()),
  );
  assert.equal(inputs[0].sha256, inputs[0].sourceSha256);
});

test("v9 备份一次性转换为 v11；新图关系可完整恢复且不恢复远端任务句柄", async () => {
  const { db, generation, blob, plan } = await fixture();
  const current = await takeSnapshot();
  const legacy = structuredClone(current) as unknown as Record<string, any>;
  legacy.formatVersion = 9;
  delete legacy.data.sceneImagePlans;
  delete legacy.data.sceneGenerations;
  for (const asset of legacy.data.assets) delete asset.creationOrigin;
  for (const session of legacy.data.sessions) {
    delete session.visualState;
    delete session.visualSources;
  }
  const converted = validateBackup(legacy);
  assert.equal(converted.formatVersion, 14);
  assert.equal(converted.data.assets[0].creationOrigin, "uploaded");
  assert.equal(converted.data.sessions[0].stateVersion, 0);
  await db.put("sceneGenerations", generation);
  globalThis.fetch = async () => Response.json(caps);
  await saveGeneratedImage(generation, plan, blob, commit);
  const backup = await takeSnapshot();
  await restoreSnapshot(backup);
  const restored = (await db.getAll("sceneGenerations"))[0];
  assert.equal(restored.status, "succeeded");
  assert.equal(restored.assetId, "img1");
  assert.equal((await db.getAll("sceneImagePlans"))[0].prompt, plan.prompt);
});

test("本地保存失败不 ACK；ACK 丢失重试不下载或生成，也不覆盖较新状态", async () => {
  const { db, generation, session, turn, blob } = await fixture();
  await db.put("sceneGenerations", generation);
  await db.put("sessions", {
    ...session,
    stateVersion: 42,
    visualState: { ...session.visualState, outfit: "下一轮的红裙" },
  });
  let downloads = 0,
    acknowledgements = 0,
    failSave = true;
  globalThis.fetch = async (path) => {
    if (path === "/api/capabilities") return Response.json(caps);
    if (String(path).endsWith("/events"))
      return new Response(
        `event: snapshot\ndata: ${JSON.stringify({ runId: generation.id, revision: 2, status: "succeeded", error: null, terminal: true, submission: generation.submission })}\n\n`,
      );
    if (String(path).endsWith("/result")) {
      downloads++;
      return new Response(blob);
    }
    if (String(path).endsWith("/ack")) {
      acknowledgements++;
      assert.equal(
        (await db.get("sceneGenerations", generation.id))!.status,
        "succeeded",
      );
      if (acknowledgements === 1) throw new TypeError("ACK 响应丢失");
      return new Response(null);
    }
    throw new Error(`不应重新生成：${path}`);
  };
  const failingCommit = async <T>(work: () => Promise<T>): Promise<T> => {
    if (failSave) {
      failSave = false;
      throw new Error("磁盘已满");
    }
    return work();
  };
  await assert.rejects(
    followSceneGeneration(generation.id, failingCommit),
    /磁盘已满/,
  );
  assert.equal(acknowledgements, 0);
  assert.equal(
    (await db.get("sceneGenerations", generation.id))!.assetId,
    undefined,
  );
  await assert.rejects(
    followSceneGeneration(generation.id, commit),
    /ACK 响应丢失/,
  );
  assert.equal(
    (await db.get("sceneGenerations", generation.id))!.assetId,
    "img1",
  );
  await followSceneGeneration(generation.id, commit);
  assert.equal(downloads, 1);
  assert.equal(acknowledgements, 2);
  assert.equal((await db.getAll("assets")).length, 1);
  assert.equal(
    (await db.get("sceneGenerations", generation.id))!.acknowledged,
    true,
  );
  assert.equal(
    (await db.get("sceneGenerations", generation.id))!.error,
    undefined,
  );
  assert.equal((await db.get("sessions", session.id))!.stateVersion, 42);
  assert.equal(
    (await db.get("sessions", session.id))!.visualState.outfit,
    "下一轮的红裙",
  );
  assert.equal(
    (await db.get("messages", turn.assistant.id))!.checkpointVersion,
    1,
  );
});

test("编辑草稿持久化；每次提交冻结实际提示词和对齐尺寸，放弃后可继续重生成", async () => {
  const { db, plan, session, blob } = await fixture();
  const { saveSceneDraft } = await import("../lib/scene-images/coordinator");
  const requests: any[] = [];
  let release!: () => void;
  let waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (path, init) => {
    if (path === "/api/capabilities") return Response.json(caps);
    if (path === "/api/images/missing") return Response.json({ missing: [] });
    if (path === "/api/scene-images") {
      requests.push(JSON.parse(String(init!.body)));
      return Response.json({ runId: requests.at(-1).runId });
    }
    if (String(path).endsWith("/events")) {
      const request = requests.find((r) => String(path).includes(r.runId));
      await waiting;
      return new Response(
        `event: snapshot\ndata: ${JSON.stringify({
          runId: request.runId,
          revision: 2,
          status: "succeeded",
          terminal: true,
          error: null,
          submission: {
            ...request,
            effectivePrompt: `实际提交：${request.prompt}`,
          },
        })}\n\n`,
      );
    }
    if (String(path).endsWith("/result")) return new Response(blob);
    if (String(path).endsWith("/ack")) return new Response(null);
    throw new Error(`意外请求：${path}`);
  };
  const draft = {
    prompt: "用户修改：红裙，瀑布旁的李白；参考 img1。",
    width: 250,
    height: 513,
    referenceAssetIds: ["img1"],
    poseEnabled: false,
    poseQuery: "",
    characterReferenceAssetId: null,
    poseSearch: emptyPoseSearch(),
  };
  await saveSceneDraft(plan.id, draft, commit);
  assert.deepEqual((await db.get("sceneImagePlans", plan.id))!.draft, draft);
  await startSceneGeneration(plan.id, commit);
  assert.equal(requests[0].width, 256);
  assert.equal(requests[0].height, 544);
  await saveSceneDraft(plan.id, { ...draft, prompt: "下一次改成蓝裙" }, commit);
  release();
  await followSceneGeneration(requests[0].runId, commit);
  const first = (await db.get("sceneGenerations", requests[0].runId))!;
  assert.equal(first.submission.prompt, draft.prompt);
  assert.equal(first.submission.effectivePrompt, `实际提交：${draft.prompt}`);
  const catalog = await buildCatalog(session.id, await allMessages(session.id));
  assert.equal(
    catalog.assetCatalog[0].sources.find((s) => s.type === "scene_generation")
      ?.summary,
    first.submission.effectivePrompt,
  );
  await rejectSceneGeneration(first.id, commit);
  assert.ok(await db.get("assets", first.assetId!));
  waiting = Promise.resolve();
  await startSceneGeneration(plan.id, commit);
  await followSceneGeneration(requests[1].runId, commit);
  assert.notEqual(requests[1].runId, first.id);
  assert.equal(requests[1].prompt, "下一次改成蓝裙");
  assert.equal(
    (await db.get("sceneGenerations", first.id))!.referenceStatus,
    "rejected",
  );
  assert.equal(
    (await db.get("sceneGenerations", requests[1].runId))!.referenceStatus,
    "eligible",
  );
  assert.equal((await db.get("sceneImagePlans", plan.id))!.prompt, plan.prompt);
});

test("建议解析失败不封锁手动草稿；无身份参考可仅提交文字和尺寸", async () => {
  const { db, plan } = await fixture();
  await db.put("sceneImagePlans", {
    ...plan,
    referenceImages: [],
    error: "参考建议解析失败",
    draft: {
      prompt: "李白站在瀑布旁。",
      width: 256,
      height: 512,
      referenceAssetIds: [],
      poseEnabled: false,
      poseQuery: "",
      characterReferenceAssetId: null,
      poseSearch: emptyPoseSearch(),
    },
  });
  let request: any;
  globalThis.fetch = async (path, init) => {
    if (path === "/api/capabilities") return Response.json(caps);
    if (path === "/api/images/missing") return Response.json({ missing: [] });
    if (path === "/api/scene-images") {
      request = JSON.parse(String(init!.body));
      return Response.json({ runId: request.runId });
    }
    if (String(path).endsWith("/events"))
      return Response.json({ message: "测试任务结束" }, { status: 404 });
    throw new Error(`意外请求：${path}`);
  };
  await startSceneGeneration(plan.id, commit);
  await followSceneGeneration(request.runId, commit);
  assert.deepEqual(request.referenceImages, []);
  assert.equal(request.prompt, "李白站在瀑布旁。");
  assert.equal(request.plan, undefined);
});

test("放弃的参考明确拦截；移除该参考后能够再次提交", async () => {
  const { db, plan, generation } = await fixture();
  await db.put("sceneGenerations", {
    ...generation,
    status: "succeeded",
    assetId: "img1",
    referenceStatus: "rejected",
  });
  await db.put("sceneImagePlans", {
    ...plan,
    referenceImages: [
      { ...plan.referenceImages[0], sourceGenerationId: generation.id },
    ],
  });
  globalThis.fetch = async () => Response.json(caps);
  await assert.rejects(startSceneGeneration(plan.id, commit), /参考图已放弃/);
  assert.equal((await db.getAll("sceneGenerations")).length, 1);
});

test("v10 备份保留真实提示词与原件尺寸，移除旧前幕和目标字段", async () => {
  const { db, plan, generation, blob } = await fixture();
  await db.put("sceneGenerations", generation);
  globalThis.fetch = async () => Response.json(caps);
  await saveGeneratedImage(generation, plan, blob, commit);
  const backup = (await takeSnapshot()) as unknown as Record<string, any>;
  backup.formatVersion = 10;
  const oldPlan = backup.data.sceneImagePlans[0];
  Object.assign(oldPlan, {
    sceneId: "scene",
    previousPlanId: "",
    continuity: "new_scene",
    target: { outfit: "白裙" },
    summary: "旧摘要",
    fingerprint: "a".repeat(64),
    status: "ready",
  });
  oldPlan.referenceImages[0].roles = ["base", "identity"];
  const oldGeneration = backup.data.sceneGenerations[0];
  delete oldGeneration.submission;
  oldGeneration.sceneId = "scene";
  const converted = validateBackup(backup);
  assert.equal(converted.formatVersion, 14);
  const result = converted.data.sceneGenerations[0];
  assert.equal(result.submission.effectivePrompt, plan.prompt);
  assert.equal(result.submission.width, 1);
  assert.equal(result.submission.height, 1);
  assert.equal(result.submission.referenceImages[0].sha256, null);
  assert.equal("sceneId" in result, false);
  assert.equal("target" in converted.data.sceneImagePlans[0], false);
  assert.equal(
    "roles" in converted.data.sceneImagePlans[0].referenceImages[0],
    false,
  );
});

test("手动取消参考后原样提交提示词，不校验或改写旧图片编号", async () => {
  const { db, plan } = await fixture();
  await db.put("sceneImagePlans", {
    ...plan,
    draft: {
      prompt: "与<image2>相同的女孩坐在椅子上阅读。",
      width: 256,
      height: 512,
      referenceAssetIds: [],
      poseEnabled: false,
      poseQuery: "",
      characterReferenceAssetId: null,
      poseSearch: emptyPoseSearch(),
    },
  });
  let request: any;
  globalThis.fetch = async (path, init) => {
    if (path === "/api/capabilities") return Response.json(caps);
    if (path === "/api/images/missing") return Response.json({ missing: [] });
    if (path === "/api/scene-images") {
      request = JSON.parse(String(init!.body));
      return Response.json({ runId: request.runId });
    }
    if (String(path).endsWith("/events"))
      return Response.json({ message: "测试任务结束" }, { status: 404 });
    throw new Error(`意外请求：${path}`);
  };
  await startSceneGeneration(plan.id, commit);
  await followSceneGeneration(request.runId, commit);
  assert.equal(request.prompt, "与<image2>相同的女孩坐在椅子上阅读。");
  assert.deepEqual(request.referenceImages, []);
});

test("v11 备份转为 v12 后移除所有参考 roles 并保留真实文本和用户编辑", async () => {
  const { db, plan, generation } = await fixture();
  await db.put("sceneGenerations", { ...generation, status: "failed" });
  const backup = await takeSnapshot();
  const legacy: any = structuredClone(backup);
  legacy.formatVersion = 11;
  legacy.data.sceneImagePlans[0].referenceImages[0].roles = ["identity"];
  legacy.data.sceneImagePlans[0].draft = {
    prompt: "原样的<image2>文本",
    width: 256,
    height: 512,
    referenceAssetIds: [],
    poseEnabled: false,
    poseQuery: "",
    characterReferenceAssetId: null,
    poseSearch: emptyPoseSearch(),
  };
  legacy.data.sceneGenerations[0].submission.referenceImages[0].roles = [
    "identity",
  ];
  const migrated = validateBackup(legacy);
  assert.equal(migrated.formatVersion, 14);
  assert.equal(
    "roles" in migrated.data.sceneImagePlans[0].referenceImages[0],
    false,
  );
  assert.equal(
    "roles" in migrated.data.sceneGenerations[0].submission.referenceImages[0],
    false,
  );
  assert.equal(
    migrated.data.sceneImagePlans[0].draft!.prompt,
    "原样的<image2>文本",
  );
  assert.equal(
    migrated.data.sceneGenerations[0].submission.effectivePrompt,
    plan.prompt,
  );
});

test("放弃独有生成图立即回收原图，保留记录与引用且备份和存储统计可读", async () => {
  const { db, generation, plan } = await fixture();
  const uniqueBlob = new Blob(
    [
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==",
        "base64",
      ),
    ],
    { type: "image/png" },
  );
  await db.put("sceneGenerations", generation);
  globalThis.fetch = async () => Response.json(caps);
  await saveGeneratedImage(generation, plan, uniqueBlob, commit);
  const saved = (await db.get("sceneGenerations", generation.id))!;
  assert.notEqual(saved.assetId, "img1");
  const nextPlan = {
    ...plan,
    id: "next-plan",
    referenceImages: [
      {
        assetId: saved.assetId!,
        scope: "上一张画面",
        sourceSha256: (await db.get("assets", saved.assetId!))!.sha256,
        sourceGenerationId: saved.id,
      },
    ],
  };
  await db.put("sceneImagePlans", nextPlan);
  await db.put("sceneGenerations", {
    ...generation,
    id: "later-failed",
    planId: nextPlan.id,
    status: "failed",
    acknowledged: true,
    submission: {
      ...generation.submission,
      referenceImages: nextPlan.referenceImages.map((ref) => ({
        ...ref,
        sourceSha256: ref.sourceSha256!,
        sha256: ref.sourceSha256!,
      })),
    },
  });
  await rejectSceneGeneration(saved.id, commit);
  assert.equal(await db.get("assets", saved.assetId!), undefined);
  assert.ok(await db.get("assets", "img1"));
  assert.equal(
    (await db.get("sceneGenerations", saved.id))!.referenceStatus,
    "rejected",
  );
  const { localDataUsage } = await import("../lib/data-usage");
  assert.deepEqual((await localDataUsage()).missingAssets, []);
  const backup = await takeSnapshot();
  validateBackup(backup);
  await restoreSnapshot(backup);
  assert.equal(await db.get("assets", saved.assetId!), undefined);
  assert.equal(
    (await db.get("sceneImagePlans", nextPlan.id))!.referenceImages[0].assetId,
    saved.assetId,
  );
});

test("从资源库添加剧情参考会保存选择和原件哈希，不改写提示词", async () => {
  const { db, plan } = await fixture();
  const { addSceneReferences, saveSceneDraft } =
    await import("../lib/scene-images/coordinator");
  await db.put("assets", {
    ...(await db.get("assets", "img1"))!,
    id: "img2",
    sha256: "b".repeat(64),
    displayName: "服装.png",
  });
  await saveSceneDraft(
    plan.id,
    {
      prompt: "用户自写的<image3>提示词",
      width: 320,
      height: 640,
      referenceAssetIds: [],
      poseEnabled: false,
      poseQuery: "",
      characterReferenceAssetId: null,
      poseSearch: emptyPoseSearch(),
    },
    commit,
  );
  globalThis.fetch = async () => Response.json(caps);
  await addSceneReferences(plan.id, ["img2", "img1"], commit);
  const updated = (await db.get("sceneImagePlans", plan.id))!;
  assert.deepEqual(updated.draft!.referenceAssetIds, ["img2", "img1"]);
  assert.equal(updated.draft!.prompt, "用户自写的<image3>提示词");
  assert.equal(updated.referenceImages[1].sourceSha256, "b".repeat(64));
  assert.equal(updated.referenceImages[1].sourceGenerationId, null);
  await assert.rejects(
    addSceneReferences(plan.id, ["img999"], commit),
    /原件缺失/,
  );
  assert.deepEqual(
    (await db.get("sceneImagePlans", plan.id))!.draft,
    updated.draft,
  );
});

test("资源库显式保存独立于会话回收并随备份恢复，放弃后立即删除独占原件", async () => {
  const { db } = await fixture();
  const { saveLibraryImage, discardLibraryImage } =
    await import("../lib/images/library");
  const { collectUnreferenced } = await import("../lib/db");
  globalThis.fetch = async () => Response.json(caps);
  const file = new File(
    [
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==",
        "base64",
      ),
    ],
    "手动生成.png",
    { type: "image/png" },
  );
  const asset = await saveLibraryImage(file, "generated", commit);
  const { localDataUsage } = await import("../lib/data-usage");
  const usage = await localDataUsage();
  assert.equal(usage.publicData.imageCount, 1);
  assert.deepEqual(usage.missingAssets, []);
  const tx = db.transaction(TABLES, "readwrite");
  await collectUnreferenced(tx);
  await tx.done;
  assert.ok(await db.get("assets", asset.id));
  const backup = await takeSnapshot();
  await restoreSnapshot(backup);
  assert.ok(await db.get("assets", asset.id));
  assert.equal(
    (await db.get("settings", `libraryAsset:${asset.id}`))!.value,
    asset.id,
  );
  await discardLibraryImage(asset.id, commit);
  assert.equal(await db.get("assets", asset.id), undefined);
  assert.ok(await db.get("assets", "img1"));
  validateBackup(await takeSnapshot());
});

test("直接生图发送原始文件和提示词，临时结果不入库，取回成功后 ACK", async () => {
  const { db } = await fixture();
  const { generateDirectImage } =
    await import("../lib/images/direct-generation");
  const files = [
    new File([png], "目标.png", { type: "image/png" }),
    new File([png], "参考.png", { type: "image/png" }),
  ];
  const prompt = "把<image2>的服装用于<image1>。";
  let acknowledgements = 0;
  let submitted: any;
  globalThis.fetch = async (path, init) => {
    if (String(path).includes("/inputs/")) {
      assert.equal(init!.method, "PUT");
      assert.deepEqual(
        new Uint8Array(await (init!.body as Blob).arrayBuffer()),
        png,
      );
      return new Response(null);
    }
    if (path === "/api/scene-images/direct") {
      submitted = JSON.parse(String(init!.body));
      assert.equal(submitted.prompt, prompt);
      assert.deepEqual(
        submitted.referenceImages.map((ref: any) => ref.assetId),
        ["img1", "img2"],
      );
      return Response.json({
        runId: "direct",
        status: "succeeded",
        terminal: true,
        revision: 2,
        submission: {
          prompt,
          effectivePrompt: prompt,
          width: null,
          height: null,
          referenceImages: submitted.referenceImages,
        },
      });
    }
    if (String(path).endsWith("/result"))
      return new Response(new Blob([png], { type: "image/png" }));
    if (String(path).endsWith("/ack")) {
      acknowledgements++;
      return new Response(null);
    }
    throw new Error(`意外请求：${path}`);
  };
  const result = await generateDirectImage(
    prompt,
    files,
    "direct",
    new AbortController().signal,
    () => {},
  );
  assert.equal(result.type, "image/png");
  assert.equal(acknowledgements, 1);
  assert.equal((await db.getAll("assets")).length, 1);
  assert.equal((await db.getAll("sceneGenerations")).length, 0);
});

function poseCandidate(id: string) {
  return {
    poseId: id,
    score: 0.12,
    description: {
      zh: `双手撑地的${id}姿势`,
      en: `Pose ${id} with hands supporting the body`,
    },
    pose: {
      schema_version: 3,
      active_character_id: "hero",
      activeTab: "pose1",
      characters: [
        { id: "hero", poses: { pose1: { bones: { leftArm: [1, 2, 3] } } } },
      ],
      camera: { position: [2, 3, 4], zoom: 1.5 },
      old_prompt: "保留但不使用",
    },
  };
}

test("新草稿自动检索但不默认选择；恢复保留候选、失败不自动重试", async () => {
  const { resumeScenePoseSearches, searchScenePoses } =
    await import("../lib/scene-images/poses");
  const { saveSceneDraft } = await import("../lib/scene-images/coordinator");
  const { db, plan } = await fixture();
  await db.put("sceneImagePlans", {
    ...plan,
    poseQuery: "坐在地上，双手撑在身后",
    characterReferenceAssetId: "img1",
  });
  let searches = 0;
  let fail = false;
  globalThis.fetch = async (path) => {
    if (path === "/api/capabilities") return Response.json(caps);
    assert.equal(path, "/api/scene-images/poses/search");
    searches++;
    return fail
      ? Response.json(
          {
            code: "POSE_SEARCH_BUSY",
            message: "检索繁忙，服务请求 ID：search1",
          },
          { status: 429 },
        )
      : Response.json({
          matches: [poseCandidate("sit"), poseCandidate("stand")],
        });
  };
  await resumeScenePoseSearches(commit);
  let draft = (await db.get("sceneImagePlans", plan.id))!.draft!;
  assert.equal(draft.poseEnabled, true);
  assert.equal(draft.characterReferenceAssetId, "img1");
  assert.equal(draft.poseSearch.status, "succeeded");
  assert.equal(draft.poseSearch.selectedPoseId, null);
  assert.deepEqual(draft.poseSearch.matches[0].pose, poseCandidate("sit").pose);
  await resumeScenePoseSearches(commit);
  assert.equal(searches, 1);
  await saveSceneDraft(
    plan.id,
    { ...draft, poseSearch: { ...draft.poseSearch, selectedPoseId: "stand" } },
    commit,
  );
  draft = (await db.get("sceneImagePlans", plan.id))!.draft!;
  assert.equal(draft.poseSearch.selectedPoseId, "stand");
  await saveSceneDraft(plan.id, { ...draft, poseEnabled: false }, commit);
  await resumeScenePoseSearches(commit);
  assert.equal(
    (await db.get("sceneImagePlans", plan.id))!.draft!.poseSearch
      .selectedPoseId,
    "stand",
  );
  fail = true;
  await saveSceneDraft(plan.id, { ...draft, poseEnabled: true }, commit);
  await searchScenePoses(plan.id, commit);
  await resumeScenePoseSearches(commit);
  draft = (await db.get("sceneImagePlans", plan.id))!.draft!;
  assert.equal(draft.poseSearch.status, "failed");
  assert.match(draft.poseSearch.error!, /POSE_SEARCH_BUSY.*search1/);
  assert.equal(draft.poseSearch.selectedPoseId, null);
  assert.equal(searches, 2);
});

test("修改描述使旧候选失效，迟到检索不得覆盖新结果或用户提示词", async () => {
  const { searchScenePoses } = await import("../lib/scene-images/poses");
  const { saveSceneDraft } = await import("../lib/scene-images/coordinator");
  const { initialSceneDraft, withPoseQuery, poseGenerationError } =
    await import("../lib/scene-images/draft");
  const { db, plan } = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (path, init) => {
    if (path === "/api/capabilities") return Response.json(caps);
    assert.equal(path, "/api/scene-images/poses/search");
    const { query } = JSON.parse(String(init!.body));
    if (query === "旧动作") {
      entered();
      await waiting;
    }
    return Response.json({ matches: [poseCandidate(query)] });
  };
  await saveSceneDraft(
    plan.id,
    {
      ...initialSceneDraft(plan, caps),
      poseEnabled: true,
      poseQuery: "旧动作",
      characterReferenceAssetId: "img1",
    },
    commit,
  );
  const old = searchScenePoses(plan.id, commit);
  await firstEntered;
  let draft = (await db.get("sceneImagePlans", plan.id))!.draft!;
  await saveSceneDraft(plan.id, withPoseQuery(draft, "新动作"), commit);
  draft = (await db.get("sceneImagePlans", plan.id))!.draft!;
  assert.equal(draft.poseSearch.matches.length, 0);
  assert.match(poseGenerationError(draft)!, /重新检索/);
  await searchScenePoses(plan.id, commit);
  // 文本编辑拿着较早的 searching 状态保存，也不能清掉已经收到的新候选。
  await saveSceneDraft(plan.id, { ...draft, prompt: "用户新提示词" }, commit);
  release();
  await old;
  draft = (await db.get("sceneImagePlans", plan.id))!.draft!;
  assert.equal(draft.prompt, "用户新提示词");
  assert.equal(draft.poseSearch.matches[0].poseId, "新动作");
  assert.equal(draft.poseSearch.query, "新动作");
});

test("恢复中断检索；无候选和响应超限均阻止姿势生成", async () => {
  const { resumeScenePoseSearches, searchScenePoses } =
    await import("../lib/scene-images/poses");
  const { initialSceneDraft } = await import("../lib/scene-images/draft");
  const { db, plan } = await fixture();
  const draft = {
    ...initialSceneDraft(plan, caps),
    poseEnabled: true,
    poseQuery: "跳跃",
    characterReferenceAssetId: "img1",
    poseSearch: {
      ...emptyPoseSearch(),
      status: "searching" as const,
      query: "跳跃",
    },
  };
  await db.put("sceneImagePlans", { ...plan, draft });
  let large = false;
  globalThis.fetch = async (path) => {
    if (path === "/api/capabilities") return Response.json(caps);
    if (large)
      return new Response(
        " ".repeat(caps.imageGeneration.poseSearchMaxResponseBytes + 1),
      );
    return Response.json({ matches: [] });
  };
  await resumeScenePoseSearches(commit);
  assert.equal(
    (await db.get("sceneImagePlans", plan.id))!.draft!.poseSearch.status,
    "succeeded",
  );
  await assert.rejects(
    startSceneGeneration(plan.id, commit),
    /请选择一个姿势候选/,
  );
  large = true;
  await searchScenePoses(plan.id, commit);
  assert.match(
    (await db.get("sceneImagePlans", plan.id))!.draft!.poseSearch.error!,
    /体积限制/,
  );
});

test("选择非首项候选并更换人物图后，编号、完整 pose 与提交快照一致", async () => {
  const { saveSceneDraft } = await import("../lib/scene-images/coordinator");
  const { initialSceneDraft, orderedSceneReferences } =
    await import("../lib/scene-images/draft");
  const { db, plan } = await fixture();
  const secondBytes = new Uint8Array([...png, 0]);
  const secondHash = sha256(secondBytes);
  const identity = {
    ...plan.referenceImages[0],
    assetId: "img2",
    sourceSha256: secondHash,
  };
  const source = (await db.get("assets", "img1"))!;
  await db.put("assets", {
    ...source,
    id: "img2",
    sha256: secondHash,
    byteSize: secondBytes.length,
    originalBlob: new Blob([secondBytes], { type: "image/png" }),
  });
  await db.put("settings", { key: IMAGE_SEQUENCE_KEY, value: "2" });
  const modern = {
    ...plan,
    poseQuery: "拳击",
    characterReferenceAssetId: "img1",
    referenceImages: [...plan.referenceImages, identity],
  };
  await db.put("sceneImagePlans", modern);
  const draft = {
    ...initialSceneDraft(modern, caps),
    characterReferenceAssetId: "img2",
    poseSearch: {
      status: "succeeded" as const,
      query: "拳击",
      revision: 1,
      matches: [poseCandidate("first"), poseCandidate("boxing")],
      selectedPoseId: "boxing",
      error: null,
    },
  };
  await saveSceneDraft(plan.id, draft, commit);
  assert.deepEqual(
    orderedSceneReferences(modern, draft).map((ref) => ref.assetId),
    ["img2", "img1"],
  );
  let submitted: any;
  globalThis.fetch = async (path, init) => {
    if (path === "/api/capabilities") return Response.json(caps);
    if (path === "/api/images/missing") return Response.json({ missing: [] });
    if (path === "/api/scene-images") {
      submitted = JSON.parse(String(init!.body));
      return Response.json({ runId: submitted.runId });
    }
    if (String(path).endsWith("/events"))
      return new Response(
        `event: snapshot\ndata: ${JSON.stringify({
          runId: submitted.runId,
          revision: 2,
          status: "failed",
          terminal: true,
          error: "测试结束",
          submission: { ...submitted, effectivePrompt: submitted.prompt },
        })}\n\n`,
      );
    if (String(path).endsWith("/ack")) return new Response(null);
    throw new Error(`意外请求：${path}`);
  };
  await startSceneGeneration(plan.id, commit);
  await followSceneGeneration(submitted.runId, commit);
  assert.deepEqual(
    submitted.referenceImages.map((ref: any) => ref.assetId),
    ["img2", "img1"],
  );
  assert.equal(submitted.characterReferenceAssetId, "img2");
  assert.equal(submitted.poseSelection.poseId, "boxing");
  assert.deepEqual(submitted.poseSelection.pose, poseCandidate("boxing").pose);
  await saveSceneDraft(
    plan.id,
    { ...draft, poseSearch: { ...draft.poseSearch, selectedPoseId: "first" } },
    commit,
  );
  const frozen = (await db.get("sceneGenerations", submitted.runId))!
    .submission;
  assert.equal(frozen.poseSelection!.poseId, "boxing");
  assert.deepEqual(frozen.poseSelection!.pose, poseCandidate("boxing").pose);
  const backup = validateBackup(await takeSnapshot());
  assert.equal(
    backup.data.sceneGenerations[0].submission.poseSelection!.poseId,
    "boxing",
  );
  await restoreSnapshot(backup);
  assert.deepEqual(
    (await db.get("sceneGenerations", submitted.runId))!.submission
      .poseSelection!.pose,
    poseCandidate("boxing").pose,
  );
});

test("v13 备份迁移保留历史动作文本及嵌套草稿，明确关闭姿势参考", async () => {
  const { db, plan, generation } = await fixture();
  await db.put("sceneGenerations", {
    ...generation,
    status: "failed",
    acknowledged: true,
  });
  const backup = structuredClone(await takeSnapshot()) as any;
  backup.formatVersion = 13;
  const oldPlan = backup.data.sceneImagePlans[0];
  delete oldPlan.poseQuery;
  delete oldPlan.characterReferenceAssetId;
  oldPlan.draft = {
    prompt: "历史动作仍在此处",
    width: 256,
    height: 512,
    referenceAssetIds: ["img1"],
  };
  for (const key of [
    "poseQuery",
    "poseEnabled",
    "poseSelection",
    "characterReferenceAssetId",
  ])
    delete backup.data.sceneGenerations[0].submission[key];
  const migrated = validateBackup(backup);
  assert.equal(migrated.formatVersion, 14);
  assert.equal(migrated.data.sceneImagePlans[0].poseQuery, null);
  assert.equal(migrated.data.sceneImagePlans[0].draft!.poseEnabled, false);
  assert.equal(
    migrated.data.sceneImagePlans[0].draft!.prompt,
    "历史动作仍在此处",
  );
  assert.equal(
    migrated.data.sceneGenerations[0].submission.poseSelection,
    null,
  );
  assert.equal(
    migrated.data.sceneGenerations[0].submission.prompt,
    generation.submission.prompt,
  );
});
