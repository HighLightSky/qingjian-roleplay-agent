import { database, TABLES, type RoleplayDB } from "./db";
import { parseCharacterProfile, type CharacterProfile } from "./domain";
import { imageIds } from "./images/types";
import type { ChatContext } from "./chat/context";

export type CharacterUsage = {
  id: string;
  name: string;
  archived: boolean;
  sessionCount: number;
  messageCount: number;
  imageCount: number;
  bytes: number;
};
export type LocalDataUsage = {
  characters: CharacterUsage[];
  sessionCount: number;
  messageCount: number;
  imageCount: number;
  bytes: number;
  sharedImages: { imageCount: number; bytes: number };
  publicData: { imageCount: number; bytes: number };
};

const encoder = new TextEncoder();
function jsonBytes(value: unknown) {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(2)} ${units[unit]}`;
}

/** 只计算已保存的数据，不读取 Blob 内容，也不把浏览器磁盘估算摊到角色。 */
export async function localDataUsage(): Promise<LocalDataUsage> {
  const db = await database();
  const tx = db.transaction(TABLES);
  const characters = new Map<string, CharacterUsage>();
  const sessions = new Map<string, string>();
  const assets = new Map<
    string,
    { bytes: number; owners: Set<string>; referenced: boolean }
  >();
  const result: LocalDataUsage = {
    characters: [],
    sessionCount: 0,
    messageCount: 0,
    imageCount: 0,
    bytes: 0,
    sharedImages: { imageCount: 0, bytes: 0 },
    publicData: { imageCount: 0, bytes: 0 },
  };

  async function scan<K extends (typeof TABLES)[number]>(
    table: K,
    visit: (row: RoleplayDB[K]["value"]) => void,
  ) {
    let cursor = await tx.objectStore(table).openCursor();
    while (cursor) {
      visit(cursor.value);
      cursor = await cursor.continue();
    }
  }
  function character(id: string) {
    const value = characters.get(id);
    if (!value) throw new Error(`统计失败：角色 ${id} 不存在。`);
    return value;
  }
  function sessionOwner(id: string) {
    const owner = sessions.get(id);
    if (!owner) throw new Error(`统计失败：会话 ${id} 不存在。`);
    return character(owner);
  }
  function reference(id: string, owner?: CharacterUsage) {
    const asset = assets.get(id);
    if (!asset) throw new Error(`统计失败：图片原件 ${id} 缺失。`);
    asset.referenced = true;
    if (owner) asset.owners.add(owner.id);
  }
  function photo(profile: CharacterProfile, owner?: CharacterUsage) {
    if (profile.appearancePhotoAssetId)
      reference(profile.appearancePhotoAssetId, owner);
  }
  function taskImages(context: ChatContext, owner: CharacterUsage) {
    photo(context.character, owner);
    imageIds(context.input.parts).forEach((id) => reference(id, owner));
    context.history.forEach((message) =>
      imageIds(message.parts).forEach((id) => reference(id, owner)),
    );
    context.visual?.assetCatalog.forEach((asset) =>
      reference(asset.assetId, owner),
    );
  }

  try {
    await scan("assets", ({ originalBlob, thumbnailBlob, ...metadata }) => {
      assets.set(metadata.id, {
        bytes:
          jsonBytes(metadata) + originalBlob.size + (thumbnailBlob?.size ?? 0),
        owners: new Set(),
        referenced: false,
      });
    });
    await scan("characters", (row) => {
      const owner: CharacterUsage = {
        id: row.id,
        name: row.name,
        archived: row.archived,
        sessionCount: 0,
        messageCount: 0,
        imageCount: 0,
        bytes: jsonBytes(row),
      };
      characters.set(row.id, owner);
      photo(row, owner);
    });
    await scan("sessions", (row) => {
      const owner = character(row.characterId);
      sessions.set(row.id, row.characterId);
      owner.sessionCount++;
      owner.bytes += jsonBytes(row);
      photo(row.characterSnapshot, owner);
    });
    await scan("messages", (row) => {
      const owner = sessionOwner(row.sessionId);
      owner.messageCount++;
      owner.bytes += jsonBytes(row);
      imageIds(row.parts).forEach((id) => reference(id, owner));
    });
    await scan("drafts", (row) => {
      const owner = sessionOwner(row.sessionId);
      owner.bytes += jsonBytes(row);
      imageIds(row.parts).forEach((id) => reference(id, owner));
      imageIds(row.edit?.parts).forEach((id) => reference(id, owner));
    });
    await scan("memories", (row) => {
      character(row.characterId).bytes += jsonBytes(row);
    });
    for (const table of ["visualObservations", "imageUsages"] as const) {
      await scan(table, (row) => {
        const owner = sessionOwner(row.sessionId);
        owner.bytes += jsonBytes(row);
        reference(row.assetId, owner);
      });
    }
    for (const table of ["goals", "operations"] as const) {
      await scan(table, (row) => {
        sessionOwner(row.sessionId).bytes += jsonBytes(row);
      });
    }
    for (const table of ["stateTasks", "compactionTasks"] as const) {
      await scan(table, (row) => {
        const owner = sessionOwner(row.sessionId);
        owner.bytes += jsonBytes(row);
        taskImages(row.context, owner);
      });
    }
    await scan("settings", (row) => {
      result.publicData.bytes += jsonBytes(row);
      if (row.key.startsWith("characterDraft:"))
        photo(parseCharacterProfile(JSON.parse(row.value), true));
    });
    await tx.done;
  } catch (error) {
    await tx.done.catch(() => {});
    throw error;
  }

  for (const [id, asset] of assets) {
    if (!asset.referenced)
      throw new Error(`统计失败：图片 ${id} 缺少来源引用。`);
    for (const owner of asset.owners) character(owner).imageCount++;
    if (asset.owners.size === 1) {
      character(asset.owners.values().next().value!).bytes += asset.bytes;
    } else {
      const group =
        asset.owners.size > 1 ? result.sharedImages : result.publicData;
      group.imageCount++;
      group.bytes += asset.bytes;
    }
  }
  result.characters = [...characters.values()];
  result.imageCount = assets.size;
  result.bytes = result.sharedImages.bytes + result.publicData.bytes;
  for (const owner of result.characters) {
    result.sessionCount += owner.sessionCount;
    result.messageCount += owner.messageCount;
    result.bytes += owner.bytes;
  }
  return result;
}

/** 独立读取哈希，使后端缓存面板不依赖本地归属统计成功。 */
export async function localImageHashes() {
  const db = await database();
  const tx = db.transaction("assets");
  const hashes: string[] = [];
  let cursor = await tx.store.index("sha256").openKeyCursor();
  while (cursor) {
    hashes.push(cursor.key);
    cursor = await cursor.continue();
  }
  await tx.done;
  return hashes;
}
