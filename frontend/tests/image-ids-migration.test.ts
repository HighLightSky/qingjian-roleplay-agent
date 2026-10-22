import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { openDB } from "idb";
import { database, TABLES } from "../lib/db";
import { takeSnapshot, validateBackup, restoreSnapshot } from "../lib/backup";
import { convertBackup } from "../scripts/migrate-backup";
import { migrateImageIds } from "../lib/images/migrate-v7";
import { IMAGE_SEQUENCE_KEY } from "../lib/images/ids";
import { runStateTask } from "../lib/state/coordinator";
import {
  legacyImageSnapshot,
  oldPhoto,
  oldUpload,
  timestamp,
} from "./image-id-migration-fixture";

const legacyBackup = () => ({
  format: "roleplay-agent-backup",
  formatVersion: 7,
  exportedAt: timestamp,
  data: legacyImageSnapshot(),
});

test("v6图片、照片、摘要及冻结结果一次性升级，写入失败回滚，升级后缓存结果仍可提交", async () => {
  const original = legacyImageSnapshot();
  const old = await openDB("roleplay-agent", 6, {
    upgrade(db) {
      for (const table of TABLES) {
        const store = db.createObjectStore(table, {
          keyPath:
            table === "settings"
              ? "key"
              : table === "drafts"
                ? "sessionId"
                : "id",
        });
        if (table === "assets")
          store.createIndex("sha256", "sha256", { unique: true });
        else if (table === "messages") {
          store.createIndex("sequence", ["sessionId", "seq"], { unique: true });
          store.createIndex("status", "status");
        } else if (
          table === "characters" ||
          table === "drafts" ||
          table === "settings"
        )
          continue;
        else
          store.createIndex(
            table === "sessions" || table === "memories"
              ? "character"
              : "session",
            table === "sessions" || table === "memories"
              ? "characterId"
              : "sessionId",
          );
      }
    },
  });
  for (const table of TABLES)
    for (const row of original[table]) {
      if (table === "assets") {
        const asset = row as (typeof original.assets)[number];
        const { base64, ...meta } = asset;
        await old.put(table, {
          ...meta,
          originalBlob: new Blob([Buffer.from(base64, "base64")], {
            type: asset.mimeType,
          }),
          thumbnailBlob: new Blob(["预览"]),
        });
      } else await old.put(table, row);
    }
  old.close();
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "visualObservations") throw new Error("图片迁移写入失败");
    return put.apply(this, args);
  };
  try {
    await assert.rejects(database(), /图片迁移写入失败/);
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  const rollback = await openDB("roleplay-agent", 6);
  assert.ok(await rollback.get("assets", oldPhoto));
  assert.equal(await rollback.get("assets", "img1"), undefined);
  assert.equal(await rollback.get("settings", IMAGE_SEQUENCE_KEY), undefined);
  assert.ok(await rollback.get("visualObservations", `session:${oldPhoto}`));
  rollback.close();

  const upgraded = await database();
  assert.equal(upgraded.version, 7);
  const expected = convertBackup(legacyBackup());
  const current = await takeSnapshot();
  for (const table of TABLES) {
    const key = (row: {
      id?: string;
      key?: string;
      sessionId?: string | null;
    }) => row.id ?? row.key ?? row.sessionId!;
    const sort = (
      rows: { id?: string; key?: string; sessionId?: string | null }[],
    ) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
    assert.deepEqual(
      sort(current.data[table]),
      sort(expected.data[table]),
      table,
    );
  }
  assert.equal(await upgraded.get("assets", oldPhoto), undefined);
  assert.equal(await upgraded.get("assets", oldUpload), undefined);
  assert.equal(
    await (await upgraded.get("assets", "img1"))!.thumbnailBlob!.text(),
    "预览",
  );
  const observation = (await upgraded.get(
    "visualObservations",
    "session:img1",
  ))!;
  assert.equal(observation.version, 3);
  assert.deepEqual(observation.extractedText, [oldPhoto]);
  assert.equal(
    current.data.messages.find((m) => m.id === "u1")!.text,
    original.messages[0].text,
  );
  assert.equal(
    current.data.characters[0].description,
    original.characters[0].description,
  );
  assert.match(current.data.sessions[0].summary.text, /图片img1：红斗篷；img2/);
  assert.equal(current.data.stateTasks[0].automaticAttempts, 1);
  assert.equal(current.data.compactionTasks[0].automaticAttempts, 1);
  const reopened = await openDB("roleplay-agent", 7);
  assert.equal((await reopened.get("settings", IMAGE_SEQUENCE_KEY)).value, "2");
  reopened.close();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("已计算结果不应再次调用模型");
  };
  try {
    await runStateTask(
      current.data.stateTasks[0],
      new AbortController().signal,
      (work) => work(),
      async () => {},
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    (await upgraded.get("operations", "state:a4"))!.status,
    "committed",
  );
  assert.equal(
    (await upgraded.get("visualObservations", "session:img1"))!.version,
    4,
  );
  assert.equal(
    (await upgraded.get("visualObservations", "session:img2"))!.version,
    1,
  );
  assert.equal(await upgraded.count("stateTasks"), 0);
});

test("旧备份转换确定性编号，更新候选、载荷与摘要中的完整引用，缺图报告具体位置", () => {
  const original = legacyBackup();
  const converted = convertBackup(original);
  assert.equal(converted.formatVersion, 8);
  assert.equal(original.data.assets[0].id, oldUpload);
  assert.equal(converted.data.assets[0].id, "img2");
  assert.deepEqual(
    converted.data.assets.map((a) => a.base64),
    original.data.assets.map((a) => a.base64),
  );
  assert.equal(
    converted.data.stateTasks[0].context.visual!.plan!.contextFingerprint,
    "historical-plan-fingerprint",
  );
  const copy = legacyImageSnapshot();
  const visual = copy.stateTasks[0].context.visual!;
  visual.plan!.candidateAssetIds = [oldPhoto, oldUpload];
  visual.imagePayloads.push({
    assetId: oldUpload,
    sha256: "hash",
    dataUrl: "字节原样保存",
  });
  copy.sessions[0].summary.text = `图（${oldPhoto}），${oldUpload}。x${oldPhoto}y ${oldPhoto}-suffix`;
  const updated = migrateImageIds(copy);
  assert.deepEqual(
    updated.stateTasks[0].context.visual!.plan!.candidateAssetIds,
    ["img1", "img2"],
  );
  assert.equal(
    updated.stateTasks[0].context.visual!.imagePayloads[0].assetId,
    "img2",
  );
  assert.equal(
    updated.sessions[0].summary.text,
    `图（img1），img2。x${oldPhoto}y ${oldPhoto}-suffix`,
  );
  copy.stateTasks[0].context.input.parts!.push({
    type: "image",
    assetId: "missing-original",
  });
  assert.throws(
    () => migrateImageIds(copy),
    /stateTasks\/state:a4.context.input.parts.*missing-original/,
  );
  const broken = legacyImageSnapshot();
  broken.imageUsages[0].id = "错误的复合主键";
  assert.throws(() => migrateImageIds(broken), /imageUsages.*复合主键/);
  assert.throws(() => validateBackup(original), /版本/);
});

test("独立命令转换v7备份并恢复v8，不覆盖输入或已有输出文件", async () => {
  const folder = await mkdtemp(join(tmpdir(), "roleplay-image-backup-"));
  try {
    const input = join(folder, "v7.json"),
      output = join(folder, "v8.json");
    const original = JSON.stringify(legacyBackup());
    await writeFile(input, original);
    const run = () =>
      promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "scripts/migrate-backup.ts",
        input,
        output,
      ]);
    await run();
    const backup = validateBackup(JSON.parse(await readFile(output, "utf8")));
    await restoreSnapshot(backup);
    assert.equal(
      (await (await database()).get("characters", "character"))!
        .appearancePhotoAssetId,
      "img1",
    );
    assert.equal(await readFile(input, "utf8"), original);
    await assert.rejects(run(), /EEXIST/);
  } finally {
    await rm(folder, { recursive: true });
  }
});
