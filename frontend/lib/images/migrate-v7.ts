import type { IDBPTransaction } from "idb";
import type { RoleplayDB, TABLES } from "../db";
import type { Snapshot } from "../backup";
import type { ChatContext } from "../chat/context";
import type { HistorySummary, CompactionResult } from "../context/types";
import type { CharacterProfile } from "../domain";
import type { SelectionResult, StateResult } from "../state/types";
import type {
  CatalogAsset,
  ContentPart,
  ImagePlan,
  Observation,
} from "./types";
import { IMAGE_SEQUENCE_KEY } from "./ids";

type MigrationData = Omit<Snapshot, "assets"> & {
  assets: { id: string; createdAt: string }[];
};

/** 仅更新明确的图片引用与摘要，不改写用户原文、图片事实或其他对象的 ID。 */
export function migrateImageIds<T extends MigrationData>(input: T): T {
  const data = structuredClone(input);
  const ordered = [...data.assets].sort((a, b) => {
    const time = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const ids = new Map<string, string>();
  for (const [index, asset] of ordered.entries()) {
    if (
      typeof asset.id !== "string" ||
      !asset.id ||
      ids.has(asset.id) ||
      !Number.isFinite(Date.parse(asset.createdAt))
    )
      throw new Error(
        `图片迁移失败：assets/${asset.id} 的编号重复、缺失或创建时间无效。`,
      );
    ids.set(asset.id, `img${index + 1}`);
  }
  const references = ids.size
    ? new RegExp(
        `(?<![A-Za-z0-9_-])(?:${[...ids.keys()].map(RegExp.escape).join("|")})(?![A-Za-z0-9_-])`,
        "g",
      )
    : null;
  function imageId(value: string, location: string): string {
    const updated = ids.get(value);
    if (!updated)
      throw new Error(`图片迁移失败：${location} 引用了缺失的原图 ${value}。`);
    return updated;
  }
  function profile(value: CharacterProfile, location: string) {
    if (value.appearancePhotoAssetId !== undefined)
      value.appearancePhotoAssetId = imageId(
        value.appearancePhotoAssetId,
        `${location}.appearancePhotoAssetId`,
      );
  }
  function parts(values: ContentPart[] | undefined, location: string) {
    for (const [index, part] of (values ?? []).entries())
      if (part.type === "image")
        part.assetId = imageId(part.assetId, `${location}[${index}]`);
  }
  function summary(value: HistorySummary, location: string) {
    if (typeof value.text !== "string")
      throw new Error(`图片迁移失败：${location} 缺少摘要正文。`);
    if (references)
      value.text = value.text.replace(references, (id) => ids.get(id)!);
  }
  function observation(value: Observation, location: string) {
    value.assetId = imageId(value.assetId, location);
  }
  function catalog(values: CatalogAsset[], location: string) {
    for (const [index, asset] of values.entries()) {
      const path = `${location}[${index}]`;
      asset.assetId = imageId(asset.assetId, path);
      if (asset.observation)
        observation(asset.observation, `${path}.observation`);
    }
  }
  function plan(value: ImagePlan, location: string) {
    for (const selected of value.selectedHistoricalImages)
      selected.assetId = imageId(
        selected.assetId,
        `${location}.selectedHistoricalImages`,
      );
    value.candidateAssetIds = value.candidateAssetIds.map((id) =>
      imageId(id, `${location}.candidateAssetIds`),
    );
  }
  function context(value: ChatContext, location: string) {
    profile(value.character, `${location}.character`);
    parts(value.input.parts, `${location}.input.parts`);
    for (const message of value.history)
      parts(message.parts, `${location}.history/${message.id}`);
    summary(value.summary, `${location}.summary`);
    if (value.visual) {
      catalog(value.visual.assetCatalog, `${location}.visual.assetCatalog`);
      if (value.visual.plan) plan(value.visual.plan, `${location}.visual.plan`);
      for (const payload of value.visual.imagePayloads)
        payload.assetId = imageId(
          payload.assetId,
          `${location}.visual.imagePayloads`,
        );
    }
  }
  for (const asset of data.assets)
    asset.id = imageId(asset.id, `assets/${asset.id}`);
  for (const character of data.characters)
    profile(character, `characters/${character.id}`);
  for (const session of data.sessions) {
    profile(
      session.characterSnapshot,
      `sessions/${session.id}.characterSnapshot`,
    );
    summary(session.summary, `sessions/${session.id}.summary`);
  }
  for (const message of data.messages)
    parts(message.parts, `messages/${message.id}.parts`);
  for (const draft of data.drafts)
    parts(draft.parts, `drafts/${draft.sessionId}.parts`);
  for (const setting of data.settings) {
    if (setting.key.startsWith("characterDraft:")) {
      const value: CharacterProfile = JSON.parse(setting.value);
      profile(value, `settings/${setting.key}`);
      setting.value = JSON.stringify(value);
    }
  }
  for (const value of data.visualObservations) {
    if (value.id !== `${value.sessionId}:${value.assetId}`)
      throw new Error(
        `图片迁移失败：visualObservations/${value.id} 的复合主键与图片引用不一致。`,
      );
    observation(value, `visualObservations/${value.id}`);
    value.id = `${value.sessionId}:${value.assetId}`;
  }
  for (const value of data.imageUsages) {
    if (value.id !== `${value.messageId}:${value.assetId}`)
      throw new Error(
        `图片迁移失败：imageUsages/${value.id} 的复合主键与图片引用不一致。`,
      );
    value.assetId = imageId(value.assetId, `imageUsages/${value.id}`);
    value.id = `${value.messageId}:${value.assetId}`;
  }
  for (const table of ["stateTasks", "compactionTasks"] as const)
    for (const task of data[table])
      context(task.context, `${table}/${task.id}.context`);
  for (const operation of data.operations) {
    if (!operation.result) continue;
    const path = `operations/${operation.id}.result`;
    if (operation.kind === "selection") {
      const result = operation.result as SelectionResult;
      catalog(result.catalog, `${path}.catalog`);
      plan(result.plan, `${path}.plan`);
    } else if (operation.kind === "state_update") {
      for (const value of (operation.result as StateResult).visualObservations)
        observation(value, `${path}.visualObservations`);
    } else
      summary(
        (operation.result as CompactionResult).summary,
        `${path}.summary`,
      );
  }
  data.settings = data.settings.filter(
    (setting) => setting.key !== IMAGE_SEQUENCE_KEY,
  );
  data.settings.push({ key: IMAGE_SEQUENCE_KEY, value: String(ids.size) });
  return data;
}

/** 旧版本只在升级事务中出现，重新写入主键前清除旧键及唯一哈希索引。 */
export async function migrateV7(
  tx: IDBPTransaction<RoleplayDB, typeof TABLES, "versionchange">,
) {
  const tables = [...tx.objectStoreNames];
  const rows = await Promise.all(
    tables.map(
      async (table) => [table, await tx.objectStore(table).getAll()] as const,
    ),
  );
  const data = migrateImageIds(
    Object.fromEntries(rows) as unknown as MigrationData,
  );
  for (const table of tables) {
    const store = tx.objectStore(table);
    await store.clear();
    for (const row of data[table]) await store.put(row as never);
  }
}
