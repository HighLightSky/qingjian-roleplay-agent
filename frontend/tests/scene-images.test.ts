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
  assert.equal(converted.formatVersion, 12);
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
  assert.equal(converted.formatVersion, 12);
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
  };
  legacy.data.sceneGenerations[0].submission.referenceImages[0].roles = [
    "identity",
  ];
  const migrated = validateBackup(legacy);
  assert.equal(migrated.formatVersion, 12);
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
