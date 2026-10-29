import "fake-indexeddb/auto";
import { beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  database,
  TABLES,
  saveCharacter,
  createSession,
  beginTurn,
  allMessages,
} from "../lib/db";
import { now, DEFAULT_INTERACTION_SETTINGS } from "../lib/domain";
import { sha256 } from "../lib/images/hash";
import { buildCatalog, warmImageCache } from "../lib/images/coordinator";
import { chatContext, type ChatContext } from "../lib/chat/context";
import { localDataUsage } from "../lib/data-usage";
import {
  sendMessage,
  useAppStore,
  refreshActivity,
} from "../stores/use-app-store";
import { contextFixture } from "./context-fixture";
import { dispatchResponse } from "./dispatch-fixture";
import { saveCompletedStateTask, runStateTask } from "../lib/state/coordinator";
import { emptyStateResult } from "./state-fixture";
import { takeSnapshot, validateBackup } from "../lib/backup";
import { replaceFailedTurn } from "../lib/chat/edit";
import type { ImageAsset } from "../lib/images/types";

const originalFetch = globalThis.fetch;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP2kAAAAASUVORK5CYII=",
  "base64",
);
beforeEach(async () => {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  for (const table of TABLES) await tx.objectStore(table).clear();
  await tx
    .objectStore("settings")
    .put({ key: "imageAssetSequence", value: "3" });
  await tx.done;
  useAppStore.setState({
    ready: true,
    readOnly: false,
    busy: false,
    activeSessionId: null,
    missingImages: [],
    messages: [],
    operations: [],
    editDraft: null,
    error: "",
    interactionSettings: DEFAULT_INTERACTION_SETTINGS,
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function setup() {
  const db = await database();
  const character = await saveCharacter({
    name: "缺图测试",
    identity: "",
    description: "",
  });
  const session = await createSession(character.id);
  const images: ImageAsset[] = [];
  for (let i = 1; i <= 3; i++) {
    const bytes = Buffer.concat([png, Buffer.from([i])]);
    const image: ImageAsset = {
      id: `img${i}`,
      sha256: sha256(bytes),
      mimeType: "image/png",
      width: 1,
      height: 1,
      byteSize: bytes.length,
      creationOrigin: "uploaded",
      originalBlob: new Blob([bytes], { type: "image/png" }),
      displayName: `${i}.png`,
      createdAt: now(),
    };
    await db.put("assets", image);
    images.push(image);
  }
  const turn = await beginTurn(
    session.id,
    "",
    images.map((a) => ({ type: "image", assetId: a.id })),
  );
  await db.put("messages", {
    ...turn.assistant,
    status: "error",
    error: "之前上传失败",
  });
  const source = {
    type: "message" as const,
    messageId: turn.user.id,
    seq: 1,
    text: "",
    imageIndex: 2,
    uploadIndex: 2,
  };
  await db.put("visualObservations", {
    id: `${session.id}:img2`,
    assetId: "img2",
    sessionId: session.id,
    summary: "已保存的地图观察",
    visibleDetails: [],
    extractedText: [],
    uncertainDetails: ["小字未辨清"],
    sources: [source],
    version: 1,
    createdAt: now(),
    updatedAt: now(),
  });
  await db.delete("assets", "img2");
  useAppStore.setState({ characterId: character.id, sessionId: session.id });
  return { db, character, images, ...turn };
}

test("多图中间缺失保留原始位置、观察和编号，恢复原件后重新进入可用目录", async () => {
  const { db, session, images } = await setup();
  const messages = await allMessages(session.id);
  const result = await buildCatalog(session.id, messages);
  assert.deepEqual(
    result.assetCatalog.map((a) => a.assetId),
    ["img1", "img3"],
  );
  assert.deepEqual(
    result.assetCatalog
      .flatMap((a) => a.sources)
      .filter((s) => s.type === "message")
      .map((s) => [s.imageIndex, s.uploadIndex]),
    [
      [1, 1],
      [3, 3],
    ],
  );
  assert.equal(
    result.missingAssets[0].observation!.summary,
    "已保存的地图观察",
  );
  assert.equal("sha256" in result.missingAssets[0], false);
  await db.put("assets", images[1]);
  const restored = await buildCatalog(session.id, messages);
  assert.equal(restored.missingAssets.length, 0);
  assert.equal(restored.assetCatalog.length, 3);
});

test("缺图统计保留全部记录容量且跨来源去重，不修改数据库或读取原图", async () => {
  const { db, character, session } = await setup();
  const before = await localDataUsage();
  await db.put("characters", { ...character, appearancePhotoAssetId: "img2" });
  await db.put("sessions", {
    ...session,
    characterSnapshot: {
      ...session.characterSnapshot,
      appearancePhotoAssetId: "img2",
    },
  });
  await db.put("drafts", {
    sessionId: session.id,
    text: "草稿",
    parts: [{ type: "image", assetId: "img2" }],
    updatedAt: now(),
  });
  await db.put("settings", {
    key: "characterDraft:new",
    value: JSON.stringify({
      name: "草稿",
      identity: "",
      description: "",
      appearancePhotoAssetId: "img2",
    }),
  });
  const usage = await localDataUsage();
  assert.equal(usage.imageCount, 2);
  assert.equal(usage.missingAssets.length, 1);
  assert.equal(usage.missingAssets[0].sources.length, 3);
  assert.ok(usage.bytes > before.bytes);
  assert.equal(
    (await db.get("messages", (await allMessages(session.id))[0].id))!.parts!
      .length,
    3,
  );
});

test("缺失历史图片和角色照片允许继续发送，正常图片补传，摘要后的缺图仍有提示", async () => {
  const { db, character, session } = await setup();
  await db.put("characters", { ...character, appearancePhotoAssetId: "img2" });
  await db.put("sessions", {
    ...(await db.get("sessions", session.id))!,
    characterSnapshot: {
      ...session.characterSnapshot,
      appearancePhotoAssetId: "img2",
    },
    summary: { text: "曾上传 img1、img2、img3", throughSeq: 2, version: 1 },
  });
  let dispatched: any;
  const uploads: string[] = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    const fixture = contextFixture(path, init);
    if (fixture) return fixture;
    if (path === "/api/images/missing")
      return Response.json({ missing: JSON.parse(String(init!.body)).hashes });
    if (init?.method === "PUT") {
      uploads.push(path);
      return Response.json({});
    }
    if (path === "/api/chat") {
      dispatched = JSON.parse(String(init!.body));
      return dispatchResponse(dispatched);
    }
    if (path.endsWith("/ack")) return Response.json({});
    throw new Error(`未预期的请求：${path}`);
  };
  await sendMessage("继续聊天");
  assert.ok(dispatched);
  assert.equal(dispatched.context.history.length, 0);
  assert.deepEqual(
    dispatched.context.visual.missingAssets.map((a: any) => a.assetId),
    ["img2"],
  );
  assert.deepEqual(
    dispatched.images.map((a: any) => a.assetId),
    ["img1", "img3"],
  );
  assert.equal(uploads.length, 2);
  assert.equal((await allMessages(session.id)).at(-1)!.status, "complete");
  assert.deepEqual(useAppStore.getState().missingImages, ["img2"]);
  await db.put("assets", setupRestoredImage());
  await refreshActivity();
  assert.deepEqual(useAppStore.getState().missingImages, []);
});
function setupRestoredImage(): ImageAsset {
  const bytes = Buffer.concat([png, Buffer.from([2])]);
  return {
    id: "img2",
    sha256: sha256(bytes),
    mimeType: "image/png",
    width: 1,
    height: 1,
    byteSize: bytes.length,
    creationOrigin: "uploaded",
    originalBlob: new Blob([bytes], { type: "image/png" }),
    displayName: "2.png",
    createdAt: now(),
  };
}

test("缺失的新附件在事务提交前失败，普通发送和重发均保留草稿与消息", async () => {
  const { db, session, user } = await setup();
  await db.put("drafts", {
    sessionId: session.id,
    text: "未发送草稿",
    parts: [{ type: "image", assetId: "img2" }],
    updatedAt: now(),
  });
  const messages = await allMessages(session.id);
  const draft = await db.get("drafts", session.id);
  const parts = [{ type: "image" as const, assetId: "img2" }];
  await assert.rejects(
    beginTurn(session.id, "新图", parts),
    /本轮图片原件缺失：img2/,
  );
  await assert.rejects(
    replaceFailedTurn(session.id, user.id, "重发", parts),
    /本轮图片原件缺失：img2/,
  );
  assert.deepEqual(await allMessages(session.id), messages);
  assert.deepEqual(await db.get("drafts", session.id), draft);
});

test("上传失败保留本地原图，哈希损坏继续报错", async () => {
  const { db, character, session } = await setup();
  const context: ChatContext = chatContext(
    character,
    session,
    [],
    [],
    "新图",
    DEFAULT_INTERACTION_SETTINGS,
    [{ type: "image", assetId: "img1" }],
  );
  globalThis.fetch = async (_url, init) =>
    init?.method === "PUT"
      ? Response.json({ message: "上传失败" }, { status: 503 })
      : Response.json({ missing: [(await db.get("assets", "img1"))!.sha256] });
  await assert.rejects(
    warmImageCache(context, new AbortController().signal),
    /上传失败/,
  );
  const asset = (await db.get("assets", "img1"))!;
  await db.put("assets", { ...asset, originalBlob: new Blob(["损坏"]) });
  await assert.rejects(
    warmImageCache(context, new AbortController().signal),
    /本地原图已损坏/,
  );
});

test("手动整理重试重建缺图目录并去掉旧选图，不为缺图生成新观察", async () => {
  const { db, character, session } = await setup();
  const history = await allMessages(session.id);
  const turn = await beginTurn(session.id, "文字继续");
  const context: ChatContext = chatContext(
    character,
    session,
    [],
    history,
    "文字继续",
    DEFAULT_INTERACTION_SETTINGS,
  );
  context.visual = {
    sessionId: session.id,
    ...(await buildCatalog(session.id, history)),
    imagePayloads: [],
    plan: {
      status: "ready",
      operationId: "select",
      contextFingerprint: "old-fingerprint",
      message: "",
      candidateAssetIds: ["img1"],
      selectedHistoricalImages: [{ assetId: "img1", purpose: "核对旧图" }],
    },
  };
  const task = await saveCompletedStateTask(context, {
    ...turn.assistant,
    segments: [{ kind: "dialogue", text: "已回复" }],
    status: "complete",
    checkpointVersion: 1,
  });
  await db.delete("assets", "img1");
  let retried: any;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/images/missing")
      return Response.json({ missing: [] });
    assert.equal(String(url), "/api/state/update");
    retried = JSON.parse(String(init!.body));
    return Response.json(emptyStateResult(retried.request));
  };
  await runStateTask(
    task,
    new AbortController().signal,
    (work) => work(),
    async () => {},
  );
  assert.deepEqual(
    retried.request.context.visual.missingAssets.map((a: any) => a.assetId),
    ["img1", "img2"],
  );
  assert.deepEqual(
    retried.request.context.visual.plan.selectedHistoricalImages,
    [],
  );
  assert.deepEqual(retried.request.context.visual.plan.candidateAssetIds, []);
  assert.deepEqual(
    retried.images.map((a: any) => a.assetId),
    ["img3"],
  );
  assert.equal((await db.get("operations", task.id))!.status, "committed");
  assert.equal((await db.getAll("visualObservations")).length, 1);
});

test("缺失整理本轮原图只使该次重试失败，下一轮文本可继续", async () => {
  const { db, character, session, user } = await setup();
  const assistant = (await allMessages(session.id))[1];
  const context: ChatContext = chatContext(
    character,
    session,
    [],
    [],
    "",
    DEFAULT_INTERACTION_SETTINGS,
    user.parts,
  );
  context.visual = {
    sessionId: session.id,
    assetCatalog: [],
    missingAssets: [],
    plan: null,
    imagePayloads: [],
  };
  const task = await saveCompletedStateTask(context, {
    ...assistant,
    segments: [{ kind: "dialogue", text: "已有正文" }],
    status: "complete",
  });
  await assert.rejects(
    runStateTask(
      task,
      new AbortController().signal,
      (work) => work(),
      async () => {},
    ),
    /本地原图缺失：img2/,
  );
  assert.equal((await db.get("operations", task.id))!.status, "failed");
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    const fixture = contextFixture(path, init);
    if (fixture) return fixture;
    if (path === "/api/images/missing") return Response.json({ missing: [] });
    if (path === "/api/chat")
      return dispatchResponse(JSON.parse(String(init!.body)));
    if (path.endsWith("/ack")) return Response.json({});
    throw new Error(`未预期的请求：${path}`);
  };
  await sendMessage("继续");
  assert.equal((await allMessages(session.id)).at(-1)!.status, "complete");
});

test("完整备份拒绝缺失原件，已恢复原件的冻结缺图记录仍能通过引用校验", async () => {
  const { db, character, session, images } = await setup();
  const history = await allMessages(session.id);
  const turn = await beginTurn(session.id, "继续");
  const context: ChatContext = chatContext(
    character,
    session,
    [],
    history,
    "继续",
    DEFAULT_INTERACTION_SETTINGS,
  );
  context.visual = {
    sessionId: session.id,
    ...(await buildCatalog(session.id, history)),
    imagePayloads: [],
    plan: null,
  };
  await saveCompletedStateTask(context, {
    ...turn.assistant,
    segments: [{ kind: "dialogue", text: "已回复" }],
    status: "complete",
  });
  const incomplete = await takeSnapshot();
  assert.throws(() => validateBackup(incomplete), /图片引用缺失/);
  await db.put("assets", images[1]);
  const complete = await takeSnapshot();
  assert.equal(validateBackup(complete).formatVersion, 15);
});
