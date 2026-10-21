import { contextFixture } from "./context-fixture";
import { emptyStateResult } from "./state-fixture";
import "fake-indexeddb/auto";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  database,
  TABLES,
  saveCharacter,
  createSession,
  beginTurn,
  allMessages,
  deleteSession,
} from "../lib/db";
import {
  EMPTY_PROFILE,
  DEFAULT_INTERACTION_SETTINGS,
  now,
} from "../lib/domain";
import { sha256 } from "../lib/images/hash";
import {
  inspectImage,
  getOriginal,
  DEFAULT_LIMITS,
} from "../lib/images/repository";
import { buildCatalog, prepareImageContext } from "../lib/images/coordinator";
import { chatContext } from "../lib/chat/context";
import { takeSnapshot, restoreSnapshot, validateBackup } from "../lib/backup";
import {
  sendMessage,
  retryLastMessage,
  cancelGeneration,
  useAppStore,
  scheduleDraft,
  flushDrafts,
} from "../stores/use-app-store";
import type { ImageAsset } from "../lib/images/types";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP2kAAAAASUVORK5CYII=",
  "base64",
);
let calls: { path: string; body: any }[] = [];
let failVisual = false,
  failChat = false;
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
beforeEach(async () => {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  for (const table of TABLES) await tx.objectStore(table).clear();
  await tx.done;
  useAppStore.setState({
    ready: true,
    readOnly: false,
    busy: false,
    activeSessionId: null,
    messages: [],
    error: "",
    interactionSettings: { ...DEFAULT_INTERACTION_SETTINGS },
  });
  calls = [];
  failVisual = false;
  failChat = false;
});
async function setup() {
  const character = await saveCharacter({
    ...EMPTY_PROFILE,
    name: "林溪",
    description: "老板",
  });
  const session = await createSession(character.id);
  useAppStore.setState({ sessionId: session.id, characterId: character.id });
  return { character, session };
}
async function asset(id = "image"): Promise<ImageAsset> {
  const value: ImageAsset = {
    id,
    sha256: sha256(png),
    mimeType: "image/png",
    byteSize: png.length,
    width: 1,
    height: 1,
    displayName: "map.png",
    originalBlob: new Blob([png], { type: "image/png" }),
    createdAt: now(),
  };
  await (await database()).put("assets", value);
  return value;
}
function mockFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input),
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    const fixture = contextFixture(path, init);
    if (fixture) return fixture;
    calls.push({ path, body });
    if (path === "/api/capabilities")
      return json({
        ...DEFAULT_LIMITS,
        visionSupported: true,
        mimeTypes: ["image/png", "image/jpeg"],
      });
    if (path === "/api/context/inspect")
      return json({
        status: "ready",
        operationId: body.operationId,
        selectedHistoricalImages:
          body.input.text === "不需要图片"
            ? []
            : body.visual.assetCatalog.map((a: any) => ({
                assetId: a.assetId,
                purpose: "核对细字",
              })),
        candidateAssetIds: [],
        message: "",
        contextFingerprint: "fixture",
      });
    if (path === "/api/state/update") {
      if (failVisual)
        return new Response(JSON.stringify({ message: "整理失败" }), {
          status: 502,
        });
      return json(emptyStateResult(body));
    }

    if (failChat)
      return new Response(JSON.stringify({ message: "模型失败" }), {
        status: 502,
      });
    return new Response(
      'event: delta\ndata: {"kind":"narration","text":"她检查地图。"}\n\nevent: done\ndata: {"finishReason":"stop","usage":{"status":"reported","inputTokens":100,"outputTokens":20,"totalTokens":120}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  return () => {
    globalThis.fetch = original;
  };
}
test("SHA-256 matches independent vectors including multi-block binary inputs", () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from("abc"),
    Buffer.alloc(65537, 0xab),
    png,
  ])
    assert.equal(
      sha256(bytes),
      createHash("sha256").update(bytes).digest("hex"),
    );
  assert.deepEqual(inspectImage(png, "image/png"), { width: 1, height: 1 });
});
test("first image is direct input; every subsequent text turn selects, including zero selection", async () => {
  const { session } = await setup();
  const a = await asset();
  const restore = mockFetch();
  try {
    await sendMessage("", [{ type: "image", assetId: a.id }]);
    assert.equal(
      calls.filter((c) => c.path === "/api/context/inspect").length,
      0,
    );
    assert.equal(
      calls.find((c) => c.path === "/api/chat")?.body.visual.imagePayloads
        .length,
      1,
    );
    assert.equal(
      (await (await database()).get("sessions", session.id))?.title,
      "图片对话",
    );
    await sendMessage("看看那个符号的小字");
    assert.equal(
      calls.filter((c) => c.path === "/api/context/inspect").length,
      1,
    );
    const inspect = calls.find((c) => c.path === "/api/context/inspect")!;
    assert.equal(inspect.body.visual.imagePayloads.length, 0);
    assert.equal(inspect.body.visual.assetCatalog[0].observation.version, 1);
    assert.equal(
      calls.filter((c) => c.path === "/api/chat").at(-1)!.body.visual
        .imagePayloads[0].assetId,
      a.id,
    );
    await sendMessage("不需要图片");
    assert.equal(
      calls.filter((c) => c.path === "/api/context/inspect").length,
      2,
    );
    assert.equal(
      calls.filter((c) => c.path === "/api/chat").at(-1)!.body.visual
        .imagePayloads.length,
      0,
    );
  } finally {
    restore();
  }
});
test("catalog retains archived images and never imports another session's references", async () => {
  const { character, session } = await setup();
  await asset();
  await beginTurn(session.id, "原图", [
    { type: "text", text: "原图" },
    { type: "image", assetId: "image" },
  ]);
  for (let i = 0; i < 30; i++) await beginTurn(session.id, `第 ${i} 轮`);
  const other = await createSession(character.id);
  await beginTurn(other.id, "同一 Blob", [
    { type: "text", text: "同一 Blob" },
    { type: "image", assetId: "image" },
  ]);
  const catalog = await buildCatalog(session.id, await allMessages(session.id));
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].sources.length, 1);
  assert.equal(catalog[0].sources[0].seq, 1);
  await deleteSession(session.id);
  assert.ok(await (await database()).get("assets", "image"));
  await deleteSession(other.id);
  assert.equal(await (await database()).get("assets", "image"), undefined);
});
test("visual failures preserve completed text and durable task; next turn recovers before selection", async () => {
  const { session } = await setup();
  await asset();
  const restore = mockFetch();
  try {
    failVisual = true;
    await sendMessage("", [{ type: "image", assetId: "image" }]);
    const db = await database();
    assert.equal((await allMessages(session.id)).at(-1)?.status, "complete");
    assert.equal(await db.count("stateTasks"), 1);
    assert.equal(await db.count("visualObservations"), 0);
    assert.deepEqual(
      (await db.getAll("stateTasks"))[0].context.visual?.imagePayloads,
      [],
    );
    const backup = await takeSnapshot();
    const invalid = structuredClone(backup);
    invalid.data.stateTasks[0].context.character.identity = "字".repeat(2001);
    await assert.rejects(restoreSnapshot(invalid), /角色身份/);
    assert.equal(await db.count("stateTasks"), 1);
    await restoreSnapshot(backup);
    assert.equal(await db.count("stateTasks"), 1);
    failVisual = false;
    calls = [];
    await sendMessage("不需要图片");
    assert.ok(
      calls.findIndex((c) => c.path === "/api/state/update") <
        calls.findIndex((c) => c.path === "/api/context/inspect"),
    );
    assert.equal(await db.count("stateTasks"), 0);
    assert.equal(await db.count("visualObservations"), 1);
  } finally {
    restore();
  }
});
test("retry reuses the saved user message instead of appending a second image input", async () => {
  const { session } = await setup();
  await asset();
  const restore = mockFetch();
  try {
    failChat = true;
    await sendMessage("", [{ type: "image", assetId: "image" }]);
    const user = (await allMessages(session.id))[0];
    failChat = false;
    await retryLastMessage();
    const messages = await allMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].id, user.id);
    assert.equal(messages[1].status, "complete");
    assert.equal(
      calls.filter((c) => c.path === "/api/context/inspect").length,
      0,
    );
  } finally {
    restore();
  }
});
test("v5 backup restores original bytes and rejects damaged originals before replacing data", async () => {
  const { session } = await setup();
  const a = await asset();
  await beginTurn(session.id, "", [{ type: "image", assetId: a.id }]);
  const backup = await takeSnapshot();
  assert.equal(backup.formatVersion, 6);
  await restoreSnapshot(backup);
  assert.equal((await getOriginal(a.id)).sha256, a.sha256);
  const invalid = structuredClone(backup);
  invalid.data.assets[0].base64 = "AAAA";
  await assert.rejects(restoreSnapshot(invalid));
  assert.equal((await getOriginal(a.id)).sha256, a.sha256);
  for (const formatVersion of [1, 2, 3, 4, 5])
    assert.throws(() => validateBackup({ ...backup, formatVersion }), /版本/);
});
test("ambiguous selection and cancellation preserve submitted input and never generate a reply", async () => {
  const { character, session } = await setup();
  await asset();
  await beginTurn(session.id, "地图", [
    { type: "text", text: "地图" },
    { type: "image", assetId: "image" },
  ]);
  const base = chatContext(
    character,
    session,
    [],
    [],
    "哪张图",
    DEFAULT_INTERACTION_SETTINGS,
  );
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      json({
        operationId: base.operationId,
        status: "ambiguous",
        selectedHistoricalImages: [],
        candidateAssetIds: ["image"],
        message: "你指哪张？",
      });
    await assert.rejects(
      prepareImageContext(
        base,
        session.id,
        await allMessages(session.id),
        new AbortController().signal,
        "test-anchor",
        async () => {},
      ),
      /你指哪张/,
    );
    const count = await (await database()).count("messages");
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    globalThis.fetch = async (_input, init) => {
      started();
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        ),
      );
    };
    const send = sendMessage("等一下").catch((error) => error);
    await pending;
    await cancelGeneration();
    await send;
    assert.equal(await (await database()).count("messages"), count + 2);
    assert.equal((await allMessages(session.id)).at(-1)?.status, "cancelled");
  } finally {
    globalThis.fetch = original;
  }
});

test("background visual calls do not block local draft writes", async () => {
  const { session } = await setup();
  await asset();
  const restore = mockFetch();
  const mocked = globalThis.fetch;
  let started!: () => void, release!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/state/update") {
      started();
      await gate;
    }
    return mocked(input, init);
  };
  const run = sendMessage("", [{ type: "image", assetId: "image" }]);
  try {
    await pending;
    scheduleDraft(session.id, "下一轮草稿");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        flushDrafts(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Draft save blocked by visual call")),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(
      (await (await database()).get("drafts", session.id))?.text,
      "下一轮草稿",
    );
  } finally {
    release();
    await run;
    restore();
  }
});
