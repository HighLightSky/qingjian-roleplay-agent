import { IMAGE_SEQUENCE_KEY, imageSequence } from "../lib/images/ids";
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
import { inspectImage, getOriginal } from "../lib/images/repository";
import { buildCatalog } from "../lib/images/coordinator";
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
  await tx.objectStore("settings").put({ key: IMAGE_SEQUENCE_KEY, value: "0" });
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
async function asset(id = "img1"): Promise<ImageAsset> {
  const value: ImageAsset = {
    id,
    sha256: sha256(png),
    mimeType: "image/png",
    byteSize: png.length,
    width: 1,
    height: 1,
    displayName: "map.png",
    creationOrigin: "uploaded",
    originalBlob: new Blob([png], { type: "image/png" }),
    createdAt: now(),
  };
  await (await database()).put("assets", value);
  await (
    await database()
  ).put("settings", {
    key: IMAGE_SEQUENCE_KEY,
    value: String(imageSequence(id)),
  });
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
async function setupPhoto() {
  const { character } = await setup();
  await asset("img2");
  const updated = await saveCharacter(
    { ...character, appearancePhotoAssetId: "img2" },
    character,
  );
  const session = await createSession(updated.id);
  useAppStore.setState({ sessionId: session.id, characterId: updated.id });
  return { character: updated, session };
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

test("catalog retains archived images and never imports another session's references", async () => {
  const { character, session } = await setup();
  await asset();
  await beginTurn(session.id, "原图", [
    { type: "text", text: "原图" },
    { type: "image", assetId: "img1" },
  ]);
  for (let i = 0; i < 30; i++) await beginTurn(session.id, `第 ${i} 轮`);
  const other = await createSession(character.id);
  await beginTurn(other.id, "同一 Blob", [
    { type: "text", text: "同一 Blob" },
    { type: "image", assetId: "img1" },
  ]);
  const { assetCatalog: catalog } = await buildCatalog(
    session.id,
    await allMessages(session.id),
  );
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].sources.length, 1);
  assert.equal(catalog[0].sources[0].type, "message");
  assert.equal(
    catalog[0].sources[0].type === "message" && catalog[0].sources[0].seq,
    1,
  );
  await deleteSession(session.id);
  assert.ok(await (await database()).get("assets", "img1"));
  await deleteSession(other.id);
  assert.equal(await (await database()).get("assets", "img1"), undefined);
});

test("v8 backup restores original bytes and rejects damaged originals before replacing data", async () => {
  const { session } = await setup();
  const a = await asset();
  await beginTurn(session.id, "", [{ type: "image", assetId: a.id }]);
  const backup = await takeSnapshot();
  assert.equal(backup.formatVersion, 10);
  await restoreSnapshot(backup);
  assert.equal((await getOriginal(a.id)).sha256, a.sha256);
  const invalid = structuredClone(backup);
  invalid.data.assets[0].base64 = "AAAA";
  await assert.rejects(restoreSnapshot(invalid));
  assert.equal((await getOriginal(a.id)).sha256, a.sha256);
  for (const formatVersion of [1, 2, 3, 4, 5, 6, 7])
    assert.throws(() => validateBackup({ ...backup, formatVersion }), /版本/);
});

test("照片修改和移除只影响新会话，旧快照与角色草稿保护原件，备份校验所有照片引用", async () => {
  const { character, session } = await setupPhoto();
  const db = await database();
  const { saveCharacterDraft, discardCharacterDraft } =
    await import("../lib/db");
  const key = "characterDraft:copy";
  await saveCharacterDraft(key, { ...character, name: "副本草稿" });
  const { appearancePhotoAssetId, ...text } = character;
  const updated = await saveCharacter(text, character);
  const next = await createSession(character.id);
  assert.equal(updated.profileVersion, character.profileVersion + 1);
  assert.equal(next.characterSnapshot.appearancePhotoAssetId, undefined);
  assert.equal(
    (await buildCatalog(session.id, [])).assetCatalog[0].assetId,
    "img2",
  );
  const backup = await takeSnapshot();
  await restoreSnapshot(backup);
  const invalid = structuredClone(backup);
  invalid.data.sessions.find(
    (s) => s.id === session.id,
  )!.characterSnapshot.appearancePhotoAssetId = "img99";
  await assert.rejects(restoreSnapshot(invalid), /照片原件缺失/);
  assert.ok(await db.get("assets", "img2"));
  await deleteSession(session.id);
  assert.ok(await db.get("assets", "img2"));
  await discardCharacterDraft(key);
  assert.equal(await db.get("assets", "img2"), undefined);
});

test("照片准备复用图片校验与去重，草稿引用原子交接，取消不留下无引用资产", async () => {
  const { prepareCharacterPhoto } = await import("../lib/images/repository");
  const { saveCharacterDraft, discardCharacterDraft } =
    await import("../lib/db");
  const db = await database();
  const restore = mockFetch();
  const key = "characterDraft:new";
  const commit = <T>(task: () => Promise<T>) => task();
  try {
    await saveCharacterDraft(key, { ...EMPTY_PROFILE, name: "照片角色" });
    const file = new File([png], "photo.png", { type: "image/png" });
    const prepared = await prepareCharacterPhoto(
      file,
      key,
      commit,
      new AbortController().signal,
    );
    assert.equal(await db.count("assets"), 1);
    await saveCharacterDraft("characterDraft:copy", prepared);
    const repeated = await prepareCharacterPhoto(
      file,
      key,
      commit,
      new AbortController().signal,
    );
    assert.equal(
      repeated.appearancePhotoAssetId,
      prepared.appearancePhotoAssetId,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      prepareCharacterPhoto(file, key, commit, controller.signal),
      { name: "AbortError" },
    );
    await assert.rejects(
      prepareCharacterPhoto(
        new File(["bad"], "bad.png", { type: "image/png" }),
        key,
        commit,
        new AbortController().signal,
      ),
      /有效/,
    );
    const character = await saveCharacter(prepared, undefined, key);
    assert.equal(await db.get("settings", key), undefined);
    await discardCharacterDraft("characterDraft:copy");
    assert.ok(await db.get("assets", character.appearancePhotoAssetId!));
  } finally {
    restore();
  }
});

test("替换照片的保存失败原子回滚，成功后新旧会话分别持有原件", async () => {
  const { character, session } = await setupPhoto();
  const { prepareCharacterPhoto } = await import("../lib/images/repository");
  const { saveCharacterDraft } = await import("../lib/db");
  const key = `characterDraft:${character.id}`;
  await saveCharacterDraft(key, character);
  const restore = mockFetch();
  try {
    const replacement = new File(
      [
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==",
          "base64",
        ),
      ],
      "replacement.png",
      { type: "image/png" },
    );
    const profile = await prepareCharacterPhoto(
      replacement,
      key,
      (task) => task(),
      new AbortController().signal,
    );
    assert.notEqual(profile.appearancePhotoAssetId, "img2");
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (
      ...args: Parameters<typeof remove>
    ) {
      if (this.name === "settings" && args[0] === key)
        throw new Error("草稿交接失败");
      return remove.apply(this, args);
    };
    try {
      await assert.rejects(
        saveCharacter(profile, character, key),
        /草稿交接失败/,
      );
    } finally {
      IDBObjectStore.prototype.delete = remove;
    }
    const db = await database();
    assert.equal(
      (await db.get("characters", character.id))!.appearancePhotoAssetId,
      "img2",
    );
    assert.ok(await db.get("settings", key));
    assert.equal(await db.count("assets"), 2);
    const updated = await saveCharacter(profile, character, key);
    const next = await createSession(character.id);
    assert.equal(
      next.characterSnapshot.appearancePhotoAssetId,
      updated.appearancePhotoAssetId,
    );
    assert.equal(
      (await buildCatalog(session.id, [])).assetCatalog[0].assetId,
      "img2",
    );
    await restoreSnapshot(await takeSnapshot());
    await deleteSession(session.id);
    assert.equal(await db.get("assets", "img2"), undefined);
    assert.ok(await db.get("assets", updated.appearancePhotoAssetId!));
  } finally {
    restore();
  }
});
