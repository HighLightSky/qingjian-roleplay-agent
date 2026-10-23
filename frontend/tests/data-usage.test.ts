import "fake-indexeddb/auto";
import { beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { database, TABLES, saveCharacter, createSession } from "../lib/db";
import { EMPTY_PROFILE, now, type Message } from "../lib/domain";
import {
  localDataUsage,
  localImageHashes,
  formatBytes,
} from "../lib/data-usage";
import { browserStorageStatus } from "../lib/browser-storage";
import { imageCacheRequest } from "../lib/image-cache";
import { chatContext } from "../lib/chat/context";
import { DEFAULT_INTERACTION_SETTINGS } from "../lib/domain";
import type { ImageAsset } from "../lib/images/types";

beforeEach(async () => {
  mock.restoreAll();
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  for (const table of TABLES) await tx.objectStore(table).clear();
  await tx.done;
});

function asset(index: number): ImageAsset {
  const text = `原图🌸${index}`;
  const originalBlob = new Blob([text]);
  return {
    id: `img${index}`,
    sha256: createHash("sha256").update(text).digest("hex"),
    mimeType: "image/png",
    width: 1,
    height: 1,
    displayName: `照片${index}.png`,
    byteSize: originalBlob.size,
    originalBlob,
    thumbnailBlob: new Blob([`缩略图${index}`]),
    createdAt: now(),
  };
}

test("按角色统计已保存记录，共享图片只计一次，原图与缩略图均计入容量", async () => {
  const db = await database();
  const a = await saveCharacter({ ...EMPTY_PROFILE, name: "李白🌸" });
  const b = await saveCharacter({ ...EMPTY_PROFILE, name: "杜甫" });
  const a1 = await createSession(a.id),
    a2 = await createSession(a.id),
    b1 = await createSession(b.id);
  await db.put("characters", { ...b, archived: true });
  const assets = Array.from({ length: 8 }, (_, i) => asset(i + 1));
  for (const image of assets) await db.put("assets", image);
  await db.put("characters", { ...a, appearancePhotoAssetId: "img1" });
  await db.put("sessions", {
    ...a1,
    characterSnapshot: {
      ...a1.characterSnapshot,
      appearancePhotoAssetId: "img2",
    },
  });
  const message = (
    sessionId: string,
    seq: number,
    images: string[],
    status: Message["status"],
  ): Message => ({
    id: `${sessionId}:${seq}`,
    sessionId,
    seq,
    role: "user",
    text: "中文与 emoji 🌸",
    parts: images.map((assetId) => ({ type: "image", assetId })),
    status,
    checkpointVersion: 1,
    createdAt: now(),
    updatedAt: now(),
  });
  await db.put("messages", message(a1.id, 1, ["img3", "img4"], "complete"));
  await db.put("messages", message(a2.id, 1, ["img3", "img4"], "error"));
  await db.put("messages", message(b1.id, 1, ["img4"], "cancelled"));
  await db.put("drafts", {
    sessionId: a2.id,
    text: "草稿",
    parts: [{ type: "image", assetId: "img5" }],
    updatedAt: now(),
  });
  await db.put("settings", {
    key: "characterDraft:new",
    value: JSON.stringify({ ...EMPTY_PROFILE, appearancePhotoAssetId: "img6" }),
  });
  const context = chatContext(
    a,
    a2,
    [],
    [],
    "任务图片",
    DEFAULT_INTERACTION_SETTINGS,
    [{ type: "image", assetId: "img7" }],
  );
  await db.put("stateTasks", {
    id: "task1",
    sessionId: a2.id,
    assistantMessageId: "reply1",
    throughSeq: 1,
    context,
    createdAt: now(),
    updatedAt: now(),
  });
  await db.put("compactionTasks", {
    id: "task2",
    sessionId: b1.id,
    assistantMessageId: "reply2",
    context: {
      ...chatContext(b, b1, [], [], "压缩", DEFAULT_INTERACTION_SETTINGS),
      character: { ...context.character, appearancePhotoAssetId: "img8" },
      input: { text: "压缩" },
    },
    automaticAttempts: 0,
    createdAt: now(),
    updatedAt: now(),
  });
  await db.put("imageUsages", {
    id: "use1",
    assetId: "img3",
    sessionId: a1.id,
    messageId: `${a1.id}:1`,
    purpose: "参考",
    createdAt: now(),
  });
  await db.put("visualObservations", {
    id: "observation1",
    assetId: "img3",
    sessionId: a1.id,
    summary: "照片",
    visibleDetails: [],
    extractedText: [],
    uncertainDetails: [],
    sources: [],
    version: 1,
    createdAt: now(),
    updatedAt: now(),
  });
  await db.put("memories", {
    id: "memory1",
    characterId: a.id,
    sessionId: null,
    value: {
      content: "喜欢诗歌🌸",
      scope: "character",
      kind: "preference",
      epistemicStatus: "established",
      status: "active",
    },
    version: 1,
    origin: "manual",
    sourceSessionId: a1.id,
    sourceMessageIds: [`${a1.id}:1`],
    createdAt: now(),
    updatedAt: now(),
  });
  await db.put("goals", {
    id: "goal1",
    sessionId: b1.id,
    value: {
      description: "寻找诗集",
      status: "active",
      currentFocus: "询问书店",
      progressSummary: "尚未找到",
    },
    version: 1,
    origin: "manual",
    sourceMessageIds: [],
    createdAt: now(),
    updatedAt: now(),
  });
  await db.put("operations", {
    id: "operation1",
    sessionId: a2.id,
    runId: "run1",
    anchorMessageId: `${a2.id}:1`,
    placement: "after",
    kind: "state_update",
    status: "failed",
    error: "检查失败",
    createdAt: now(),
    updatedAt: now(),
  });

  const unread = mock.method(Blob.prototype, "arrayBuffer", () => {
    throw new Error("统计不应读取图片二进制");
  });
  const usage = await localDataUsage();
  assert.equal(unread.mock.callCount(), 0);
  const first = usage.characters.find((c) => c.id === a.id)!;
  const second = usage.characters.find((c) => c.id === b.id)!;
  assert.deepEqual(
    [first.sessionCount, first.messageCount, first.imageCount],
    [2, 2, 6],
  );
  assert.deepEqual(
    [
      second.sessionCount,
      second.messageCount,
      second.imageCount,
      second.archived,
    ],
    [1, 1, 2, true],
  );
  assert.deepEqual(
    [usage.sessionCount, usage.messageCount, usage.imageCount],
    [3, 3, 8],
  );
  const imageBytes = ({
    originalBlob,
    thumbnailBlob,
    ...metadata
  }: ImageAsset) =>
    new Blob([JSON.stringify(metadata)]).size +
    originalBlob.size +
    thumbnailBlob!.size;
  assert.deepEqual(usage.sharedImages, {
    imageCount: 1,
    bytes: imageBytes(assets[3]),
  });
  const settings = await db.getAll("settings");
  assert.deepEqual(usage.publicData, {
    imageCount: 1,
    bytes:
      imageBytes(assets[5]) +
      settings.reduce(
        (sum, row) => sum + new Blob([JSON.stringify(row)]).size,
        0,
      ),
  });
  let expected = 0;
  for (const table of TABLES) {
    for (const row of await db.getAll(table))
      expected +=
        table === "assets"
          ? imageBytes(row as ImageAsset)
          : new Blob([JSON.stringify(row)]).size;
  }
  assert.equal(usage.bytes, expected);
  assert.equal(
    first.bytes +
      second.bytes +
      usage.sharedImages.bytes +
      usage.publicData.bytes,
    expected,
  );
  assert.deepEqual(
    (await localImageHashes()).sort(),
    assets.map((a) => a.sha256).sort(),
  );
});

test("空数据库显示真实零值，格式化容量使用二进制单位", async () => {
  const usage = await localDataUsage();
  assert.equal(usage.bytes, 0);
  assert.equal(usage.characters.length, 0);
  assert.equal(usage.imageCount, 0);
  assert.deepEqual([0, 1023, 1024, 1024 ** 2, 1024 ** 3].map(formatBytes), [
    "0 B",
    "1023 B",
    "1.00 KiB",
    "1.00 MiB",
    "1.00 GiB",
  ]);
});

test("缺图返回明细且统计不改动数据，角色和会话缺失继续报错", async () => {
  const db = await database();
  const character = await saveCharacter({ ...EMPTY_PROFILE, name: "李白" });
  const session = await createSession(character.id);
  await db.put("drafts", {
    sessionId: session.id,
    text: "",
    parts: [{ type: "image", assetId: "img99" }],
    updatedAt: now(),
  });
  const usage = await localDataUsage();
  assert.deepEqual(usage.missingAssets, [
    { assetId: "img99", sources: [`角色：李白 · 会话：${session.title}`] },
  ]);
  assert.equal(usage.imageCount, 0);
  assert.ok(usage.bytes > 0);
  assert.equal((await db.get("drafts", session.id))!.parts!.length, 1);
  await db.delete("drafts", session.id);
  await db.delete("characters", character.id);
  await assert.rejects(
    localDataUsage,
    new RegExp(`角色 ${character.id} 不存在`),
  );
  await db.delete("sessions", session.id);
  await db.put("drafts", {
    sessionId: "missing-session",
    text: "",
    updatedAt: now(),
  });
  await assert.rejects(localDataUsage, /会话 missing-session 不存在/);
});

test("图片目录与历史中仅由任务保留的图片也按所属角色统计", async () => {
  const db = await database();
  const character = await saveCharacter({ ...EMPTY_PROFILE, name: "李白" });
  const session = await createSession(character.id);
  const one = asset(1),
    two = asset(2);
  await db.put("assets", one);
  await db.put("assets", two);
  const context = chatContext(
    character,
    session,
    [],
    [],
    "任务",
    DEFAULT_INTERACTION_SETTINGS,
  );
  await db.put("stateTasks", {
    id: "task",
    sessionId: session.id,
    assistantMessageId: "reply",
    throughSeq: 1,
    context: {
      ...context,
      history: [
        {
          role: "user",
          id: "old",
          seq: 1,
          status: "complete",
          checkpointVersion: 1,
          text: "",
          parts: [{ type: "image", assetId: one.id }],
        },
      ],
      visual: {
        sessionId: session.id,
        plan: null,
        imagePayloads: [],
        assetCatalog: [
          {
            assetId: two.id,
            sha256: two.sha256,
            mimeType: two.mimeType,
            byteSize: two.byteSize,
            width: two.width,
            height: two.height,
            sources: [],
            observation: null,
            recentUses: [],
          },
        ],
      },
    },
    createdAt: now(),
    updatedAt: now(),
  });
  assert.equal((await localDataUsage()).characters[0].imageCount, 2);
});

test("浏览器存储查询不支持或失败时不伪造零用量", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    assert.match((await browserStorageStatus()).errors[0], /不支持/);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        storage: {
          estimate: async () => {
            throw new Error("查询被拒绝");
          },
        },
      },
    });
    const failed = await browserStorageStatus();
    assert.equal(failed.usage, undefined);
    assert.match(failed.errors[0], /查询被拒绝/);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        storage: {
          estimate: async () => ({ usage: 2048 }),
        },
      },
    });
    const partial = await browserStorageStatus();
    assert.equal(partial.usage, 2048);
    assert.deepEqual(partial.errors, []);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("缓存请求只发送本地图片哈希，查询失败与占用冲突都保留服务端错误", async () => {
  const db = await database();
  const image = asset(1);
  await db.put("assets", image);
  const fetch = mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit) => {
      assert.deepEqual(JSON.parse(String(init!.body)), {
        hashes: [image.sha256],
      });
      return Response.json(
        {
          code: "IMAGE_IN_USE",
          message: "图片正在被任务使用，请在任务完成后重试",
        },
        { status: 409 },
      );
    },
  );
  await assert.rejects(
    imageCacheRequest("clear", new AbortController().signal),
    /图片正在被任务使用/,
  );
  fetch.mock.mockImplementation(async () =>
    Response.json(
      { code: "SERVICE_UNAVAILABLE", message: "无法连接聊天服务" },
      { status: 502 },
    ),
  );
  await assert.rejects(
    imageCacheRequest("stats", new AbortController().signal),
    /无法连接聊天服务/,
  );
  fetch.mock.mockImplementation(async () =>
    Response.json({ error: "Not Found" }, { status: 404 }),
  );
  await assert.rejects(
    imageCacheRequest("stats", new AbortController().signal),
    /HTTP 404.*后端尚未提供图片缓存接口/,
  );
});
