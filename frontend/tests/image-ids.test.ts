import "fake-indexeddb/auto";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  database,
  TABLES,
  saveCharacter,
  saveCharacterDraft,
  createSession,
  deleteSession,
} from "../lib/db";
import { IMAGE_SEQUENCE_KEY } from "../lib/images/ids";
import {
  prepareImage,
  prepareCharacterPhoto,
  removeDraftImage,
  DEFAULT_LIMITS,
} from "../lib/images/repository";
import { takeSnapshot, restoreSnapshot, validateBackup } from "../lib/backup";
import { clearData } from "../stores/use-app-store";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP2kAAAAASUVORK5CYII=",
  "base64",
);
const file = (variant = 0) =>
  new File([png, new Uint8Array([variant])], "地图.png", { type: "image/png" });
const commit = <T>(work: () => Promise<T>) => work();

beforeEach(async () => {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  for (const table of TABLES) await tx.objectStore(table).clear();
  await tx.objectStore("settings").put({ key: IMAGE_SEQUENCE_KEY, value: "0" });
  await tx.done;
});

async function setup() {
  const profile = { name: "林溪", identity: "旧友", description: "" };
  const character = await saveCharacter(profile);
  const session = await createSession(character.id);
  await saveCharacterDraft("characterDraft:new", profile);
  return { character, session };
}

async function withVision(work: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ...DEFAULT_LIMITS,
        visionSupported: true,
        mimeTypes: ["image/png", "image/jpeg"],
      }),
    );
  try {
    await work();
  } finally {
    globalThis.fetch = original;
  }
}

test("角色照片与所有会话共用持久编号，同文件复用，删除不回收，清空才归零", async () => {
  await withVision(async () => {
    const { character, session } = await setup();
    const photo = await prepareCharacterPhoto(
      file(),
      "characterDraft:new",
      commit,
      new AbortController().signal,
    );
    assert.equal(photo.appearancePhotoAssetId, "img1");
    const shared = await prepareImage(file(), session.id);
    assert.equal(shared.id, "img1");
    await assert.rejects(prepareImage(file(), session.id), /已经在草稿/);
    const second = await createSession(character.id);
    assert.equal((await prepareImage(file(1), second.id)).id, "img2");
    await deleteSession(second.id);
    await removeDraftImage(session.id, shared.id);
    assert.equal((await prepareImage(file(2), session.id)).id, "img3");
    const db = await database();
    assert.equal((await db.get("settings", IMAGE_SEQUENCE_KEY))!.value, "3");
    assert.equal(await db.get("assets", "img2"), undefined);
    await clearData();
    const fresh = await setup();
    assert.equal((await prepareImage(file(3), fresh.session.id)).id, "img1");
  });
});

test("并发附件与角色照片在事务内分配不重复编号，同图并发只创建一个资产", async () => {
  await withVision(async () => {
    const { session } = await setup();
    const results = await Promise.all([
      prepareImage(file(1), session.id),
      prepareImage(file(2), session.id),
      prepareCharacterPhoto(
        file(3),
        "characterDraft:new",
        commit,
        new AbortController().signal,
      ),
    ]);
    assert.deepEqual(
      new Set(
        results.map((r) => ("id" in r ? r.id : r.appearancePhotoAssetId)),
      ),
      new Set(["img1", "img2", "img3"]),
    );
    const duplicates = await Promise.allSettled([
      prepareImage(file(4), session.id),
      prepareImage(file(4), session.id),
    ]);
    assert.equal(duplicates.filter((r) => r.status === "fulfilled").length, 1);
    const db = await database();
    assert.equal(await db.count("assets"), 4);
    assert.equal((await db.get("settings", IMAGE_SEQUENCE_KEY))!.value, "4");
  });
});

test("草稿写入失败同时回滚计数器与原图，重试继续使用未提交的编号", async () => {
  await withVision(async () => {
    const { session } = await setup();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === "drafts") throw new Error("草稿写入失败");
      return put.apply(this, args);
    };
    try {
      await assert.rejects(prepareImage(file(), session.id), /草稿写入失败/);
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const db = await database();
    assert.equal(await db.count("assets"), 0);
    assert.equal((await db.get("settings", IMAGE_SEQUENCE_KEY))!.value, "0");
    assert.equal((await db.get("drafts", session.id))!.parts, undefined);
    assert.equal((await prepareImage(file(), session.id)).id, "img1");
  });
});

test("缺失、损坏及耗尽的计数器明确失败，不扫描资产补值", async () => {
  await withVision(async () => {
    const { session } = await setup();
    const db = await database();
    await db.delete("settings", IMAGE_SEQUENCE_KEY);
    await assert.rejects(prepareImage(file(), session.id), /计数器缺失或损坏/);
    for (const value of [
      "-1",
      "01",
      "1\n",
      "broken",
      "9007199254740992",
      String(Number.MAX_SAFE_INTEGER),
    ]) {
      await db.put("settings", { key: IMAGE_SEQUENCE_KEY, value });
      await assert.rejects(prepareImage(file(), session.id), /计数器|安全整数/);
      assert.equal(
        (await db.get("settings", IMAGE_SEQUENCE_KEY))!.value,
        value,
      );
    }
    assert.equal(await db.count("assets"), 0);
  });
});

test("v8备份校验编号与计数器，恢复旧快照不降低本地已分配编号", async () => {
  await withVision(async () => {
    const { session } = await setup();
    await prepareImage(file(), session.id);
    const backup = await takeSnapshot();
    const db = await database();
    await prepareImage(file(1), session.id);
    await restoreSnapshot(backup);
    assert.equal(await db.count("assets"), 1);
    assert.equal((await prepareImage(file(2), session.id)).id, "img3");
    for (const value of ["-1", "0", "01", "9007199254740992"]) {
      const invalid = structuredClone(backup);
      invalid.data.settings.find((s) => s.key === IMAGE_SEQUENCE_KEY)!.value =
        value;
      assert.throws(() => validateBackup(invalid), /计数器|安全整数/);
    }
    const invalid = structuredClone(backup);
    invalid.data.assets[0].id = "old-uuid";
    assert.throws(() => validateBackup(invalid), /图片编号无效/);
    const higher = structuredClone(backup);
    higher.data.settings.find((s) => s.key === IMAGE_SEQUENCE_KEY)!.value =
      "20";
    await restoreSnapshot(higher);
    assert.equal((await prepareImage(file(3), session.id)).id, "img21");
  });
});
