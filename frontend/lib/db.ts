import { LIBRARY_ASSET_PREFIX } from "./images/types";
import {
  emptyVisualState,
  isActiveGeneration,
  type SceneImagePlan,
  type SceneGeneration,
} from "./scene-images/types";
import {
  upgradeV9Data,
  upgradeV8Record,
  upgradeV10Record,
  upgradeV11Record,
  upgradeV12Record,
  upgradeV13Record,
} from "./scene-images/migration";
import { IMAGE_SEQUENCE_KEY } from "./images/ids";
import {
  emptySummary,
  unknownUsage,
  type CompactionTask,
} from "./context/types";
import {
  EMPTY_STORY,
  type StateResult,
  type StateTask,
  type Operation,
  type Goal,
  type MemoryValue,
} from "./state/types";
import type {
  ImageAsset,
  VisualObservation,
  ImageUsage,
  ContentPart,
} from "./images/types";
import { imageIds } from "./images/types";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  id,
  finishReasoning,
  now,
  profileOf,
  parseCharacterProfile,
  titleFrom,
  type Character,
  type CharacterProfile,
  type Draft,
  type Memory,
  type Message,
  type Session,
  type Setting,
} from "./domain";

export interface RoleplayDB extends DBSchema {
  sceneImagePlans: {
    key: string;
    value: SceneImagePlan;
    indexes: { session: string; message: string };
  };
  sceneGenerations: {
    key: string;
    value: SceneGeneration;
    indexes: { session: string; message: string };
  };
  compactionTasks: {
    key: string;
    value: CompactionTask;
    indexes: { session: string };
  };
  assets: { key: string; value: ImageAsset; indexes: { sha256: string } };
  visualObservations: {
    key: string;
    value: VisualObservation;
    indexes: { session: string };
  };
  imageUsages: { key: string; value: ImageUsage; indexes: { session: string } };
  stateTasks: { key: string; value: StateTask; indexes: { session: string } };
  operations: { key: string; value: Operation; indexes: { session: string } };
  goals: { key: string; value: Goal; indexes: { session: string } };
  characters: { key: string; value: Character };
  sessions: { key: string; value: Session; indexes: { character: string } };
  messages: {
    key: string;
    value: Message;
    indexes: { sequence: [string, number]; status: string };
  };
  memories: { key: string; value: Memory; indexes: { character: string } };
  drafts: { key: string; value: Draft };
  settings: { key: string; value: Setting };
}
export const TABLES = [
  "sceneImagePlans",
  "sceneGenerations",
  "compactionTasks",
  "characters",
  "sessions",
  "messages",
  "memories",
  "drafts",
  "settings",
  "assets",
  "visualObservations",
  "imageUsages",
  "stateTasks",
  "operations",
  "goals",
] as const;
let connection: Promise<IDBPDatabase<RoleplayDB>> | undefined;
export function database(): Promise<IDBPDatabase<RoleplayDB>> {
  if (!connection) {
    let upgradeError: unknown;
    connection = openDB<RoleplayDB>("roleplay-agent", 14, {
      upgrade(db, oldVersion, _newVersion, tx) {
        void tx.done.catch((error: unknown) => {
          upgradeError ??= error;
        });
        if (
          oldVersion !== 0 &&
          oldVersion !== 8 &&
          oldVersion !== 9 &&
          oldVersion !== 10 &&
          oldVersion !== 11 &&
          oldVersion !== 12 &&
          oldVersion !== 13
        ) {
          upgradeError = new Error(
            "当前数据库版本不支持自动升级，原数据已保留，请使用旧版本导出备份。",
          );
          tx.abort();
          return;
        }
        if (oldVersion === 0 || oldVersion === 8) {
          for (const name of ["sceneImagePlans", "sceneGenerations"] as const) {
            const store = db.createObjectStore(name, { keyPath: "id" });
            store.createIndex("session", "sessionId");
            store.createIndex("message", "assistantMessageId");
          }
        }
        if (oldVersion !== 0) {
          void (async () => {
            if (oldVersion === 8) await migrateV8ToV9(tx);
            if (oldVersion === 9) await migrateV9ToV10(tx);
            for (const table of TABLES) {
              let cursor = await tx.objectStore(table).openCursor();
              while (cursor) {
                if (
                  table === "settings" &&
                  (cursor.value as Setting).key.startsWith("dispatch:")
                )
                  await cursor.delete();
                else {
                  let row = cursor.value as unknown as Record<string, unknown>;
                  if (oldVersion < 11) row = upgradeV10Record(table, row);
                  if (oldVersion < 12) row = upgradeV11Record(table, row);
                  if (oldVersion < 13) row = upgradeV12Record(table, row);
                  await cursor.update(upgradeV13Record(table, row) as never);
                }
                cursor = await cursor.continue();
              }
            }
          })().catch((error) => {
            upgradeError = error;
            tx.abort();
          });
          return;
        }
        db.createObjectStore("characters", { keyPath: "id" });
        db.createObjectStore("sessions", { keyPath: "id" }).createIndex(
          "character",
          "characterId",
        );
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("sequence", ["sessionId", "seq"], {
          unique: true,
        });
        messages.createIndex("status", "status");
        db.createObjectStore("memories", { keyPath: "id" }).createIndex(
          "character",
          "characterId",
        );
        db.createObjectStore("drafts", { keyPath: "sessionId" });
        db.createObjectStore("settings", { keyPath: "key" });
        void tx
          .objectStore("settings")
          .put({ key: IMAGE_SEQUENCE_KEY, value: "0" });
        db.createObjectStore("assets", { keyPath: "id" }).createIndex(
          "sha256",
          "sha256",
          { unique: true },
        );
        for (const name of [
          "visualObservations",
          "imageUsages",
          "stateTasks",
          "compactionTasks",
          "operations",
          "goals",
        ] as const)
          db.createObjectStore(name, { keyPath: "id" }).createIndex(
            "session",
            "sessionId",
          );
      },
      blocked() {
        window.dispatchEvent(new CustomEvent("roleplay-db-blocked"));
      },
      blocking() {
        void connection?.then((db) => db.close());
        window.dispatchEvent(new CustomEvent("roleplay-db-blocked"));
      },
    }).catch((error) => {
      connection = undefined;
      throw upgradeError ?? error;
    });
  }
  return connection;
}
export async function setting(key: string, value: string) {
  const db = await database();
  const tx = db.transaction("settings", "readwrite");
  await tx.store.put({ key, value });
  await tx.done;
}
export async function getMessages(
  sessionId: string,
  before = Number.MAX_SAFE_INTEGER,
  limit = 50,
) {
  const db = await database();
  const tx = db.transaction("messages");
  let cursor = await tx.store
    .index("sequence")
    .openCursor(
      IDBKeyRange.bound([sessionId, 0], [sessionId, before], false, true),
      "prev",
    );
  const messages: Message[] = [];
  while (cursor && messages.length < limit) {
    messages.push(cursor.value);
    cursor = await cursor.continue();
  }
  await tx.done;
  return { messages: messages.reverse(), hasEarlier: !!cursor };
}
export async function allMessages(sessionId: string, afterSeq = 0) {
  return (await database()).getAllFromIndex(
    "messages",
    "sequence",
    IDBKeyRange.bound(
      [sessionId, afterSeq],
      [sessionId, Number.MAX_SAFE_INTEGER],
      true,
    ),
  );
}
export async function recoverInterrupted() {
  const db = await database();
  const active = new Set(
    (await db.getAll("settings"))
      .filter((s) => s.key.startsWith("dispatch:"))
      .map((s) => JSON.parse(s.value).assistantMessageId as string),
  );
  const tx = db.transaction(["messages", "operations"], "readwrite");
  for (const status of ["pending", "streaming"]) {
    const messages = await tx
      .objectStore("messages")
      .index("status")
      .getAll(status);
    for (const message of messages) {
      if (active.has(message.id)) continue;
      await tx.objectStore("messages").put({
        ...message,
        status: "interrupted",
        reasoning: finishReasoning(message.reasoning, "error"),
        error: "上次生成中断，已保留保存的内容。",
        updatedAt: now(),
      });
    }
  }
  for (const operation of await tx.objectStore("operations").getAll()) {
    if (
      operation.status === "running" ||
      (operation.status === "pending" && operation.kind === "selection")
    )
      await tx.objectStore("operations").put({
        ...operation,
        status: "cancelled",
        error: "上次执行中断，待重试。",
        updatedAt: now(),
      });
  }
  await tx.done;
}
export async function saveCharacter(
  profile: CharacterProfile,
  existing?: Character,
  draftKey?: string,
) {
  const validated = parseCharacterProfile(profile);
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  return atomic(tx, async () => {
    const current = existing
      ? await tx.objectStore("characters").get(existing.id)
      : undefined;
    if (existing && !current) throw new Error("角色不存在。");
    const character: Character = {
      ...validated,
      id: existing?.id ?? id(),
      archived: current?.archived ?? false,
      profileVersion: (current?.profileVersion ?? 0) + 1,
      memoryVersion: current?.memoryVersion ?? 0,
      createdAt: current?.createdAt ?? now(),
      updatedAt: now(),
    };
    if (
      validated.appearancePhotoAssetId &&
      !(await tx.objectStore("assets").get(validated.appearancePhotoAssetId))
    )
      throw new Error("角色形象照片原件缺失，请重新选择或恢复备份。");
    await tx.objectStore("characters").put(character);
    if (draftKey) await tx.objectStore("settings").delete(draftKey);
    await collectUnreferenced(tx);
    return character;
  });
}
export async function saveCharacterDraft(key: string, value: CharacterProfile) {
  const profile = parseCharacterProfile(value, true);
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  await atomic(tx, async () => {
    if (
      profile.appearancePhotoAssetId &&
      !(await tx.objectStore("assets").get(profile.appearancePhotoAssetId))
    )
      throw new Error("角色草稿照片原件缺失。");
    const previous = await tx.objectStore("settings").get(key);
    const previousPhoto = previous
      ? parseCharacterProfile(JSON.parse(previous.value), true)
          .appearancePhotoAssetId
      : undefined;
    await tx
      .objectStore("settings")
      .put({ key, value: JSON.stringify(profile) });
    if (previousPhoto && previousPhoto !== profile.appearancePhotoAssetId)
      await collectUnreferenced(tx);
  });
}
export async function discardCharacterDraft(key: string) {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  await atomic(tx, async () => {
    await tx.objectStore("settings").delete(key);
    await collectUnreferenced(tx);
  });
}
export async function createSession(characterId: string) {
  const db = await database();
  const tx = db.transaction(
    ["characters", "sessions", "drafts", "settings"],
    "readwrite",
  );
  const character = await tx.objectStore("characters").get(characterId);
  if (!character || character.archived) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error("请先选择一个未归档的角色。");
  }
  const session: Session = {
    id: id(),
    characterId,
    title: "新对话",
    titleSource: "default",
    characterSnapshot: profileOf(character),
    profileVersion: character.profileVersion,
    story: structuredClone(EMPTY_STORY),
    storySources: {},
    visualState: emptyVisualState(),
    visualSources: {},
    stateVersion: 0,
    summary: emptySummary(),
    nextMessageSeq: 1,
    createdAt: now(),
    updatedAt: now(),
  };
  await tx.objectStore("sessions").put(session);
  await tx
    .objectStore("drafts")
    .put({ sessionId: session.id, text: "", updatedAt: now() });
  await tx.objectStore("settings").put({ key: "sessionId", value: session.id });
  await tx
    .objectStore("settings")
    .put({ key: "characterId", value: characterId });
  await tx.done;
  return session;
}
export async function requireInputImages(
  tx: import("./images/ids").ImageWriteTransaction,
  parts?: ContentPart[],
) {
  for (const assetId of imageIds(parts)) {
    if (!(await tx.objectStore("assets").get(assetId)))
      throw new Error(`本轮图片原件缺失：${assetId}，请移除或重新选择。`);
  }
}
export async function beginTurn(
  sessionId: string,
  text: string,
  parts?: ContentPart[],
) {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  return atomic(tx, async () => {
    const session = await tx.objectStore("sessions").get(sessionId);
    if (!session) {
      tx.abort();
      await tx.done.catch(() => {});
      throw new Error("会话不存在。");
    }
    await requireInputImages(tx, parts);
    const user: Message = {
      id: id(),
      sessionId,
      seq: session.nextMessageSeq,
      role: "user",
      text,
      ...(parts ? { parts } : {}),
      status: "complete",
      checkpointVersion: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    const assistant: Message = {
      usage: unknownUsage(),
      id: id(),
      sessionId,
      seq: session.nextMessageSeq + 1,
      role: "assistant",
      segments: [],
      replyToMessageId: user.id,
      status: "pending",
      checkpointVersion: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    const updated: Session = {
      ...session,
      nextMessageSeq: session.nextMessageSeq + 2,
      updatedAt: now(),
      ...(session.titleSource === "default"
        ? {
            title: titleFrom(text) || "图片对话",
            titleSource: "first-message" as const,
          }
        : {}),
    };
    await tx.objectStore("messages").put(user);
    await tx.objectStore("messages").put(assistant);
    await tx.objectStore("sessions").put(updated);
    await tx
      .objectStore("drafts")
      .put({ sessionId, text: "", updatedAt: now() });
    await collectUnreferenced(tx);
    return { user, assistant, session: updated };
  });
}
export async function checkpoint(message: Message) {
  const db = await database();
  const tx = db.transaction("messages", "readwrite");
  const previous = await tx.store.get(message.id);
  if (
    previous &&
    message.checkpointVersion >= previous.checkpointVersion &&
    (["pending", "streaming"].includes(previous.status) ||
      !["pending", "streaming"].includes(message.status))
  ) {
    await tx.store.put(message);
  }
  await tx.done;
}
export async function deleteSession(sessionId: string) {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  if (
    (
      await tx
        .objectStore("sceneGenerations")
        .index("session")
        .getAll(sessionId)
    ).some((g) => isActiveGeneration(g.status))
  ) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error("该会话仍在生图，请先停止或等待完成。");
  }
  for (const table of [
    "sceneImagePlans",
    "sceneGenerations",
    "visualObservations",
    "imageUsages",
    "stateTasks",
    "compactionTasks",
    "operations",
    "goals",
  ] as const) {
    for (const row of await tx
      .objectStore(table)
      .index("session")
      .getAll(sessionId))
      await tx.objectStore(table).delete(row.id);
  }
  let cursor = await tx
    .objectStore("messages")
    .index("sequence")
    .openCursor(
      IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]),
    );
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  for (const memory of await tx.objectStore("memories").getAll()) {
    if (memory.sessionId === sessionId)
      await tx.objectStore("memories").delete(memory.id);
  }
  await tx.objectStore("sessions").delete(sessionId);
  await tx.objectStore("drafts").delete(sessionId);
  if ((await tx.objectStore("settings").get("sessionId"))?.value === sessionId)
    await tx.objectStore("settings").delete("sessionId");
  await collectUnreferenced(tx);
  await tx.done;
}
export async function collectUnreferenced(
  tx: import("idb").IDBPTransaction<RoleplayDB, typeof TABLES, "readwrite">,
) {
  const used = new Set<string>();
  const photo = (profile: CharacterProfile) => {
    if (profile.appearancePhotoAssetId)
      used.add(profile.appearancePhotoAssetId);
  };
  for (const row of await tx.objectStore("characters").getAll()) photo(row);
  for (const row of await tx.objectStore("sessions").getAll())
    photo(row.characterSnapshot);
  for (const row of await tx.objectStore("settings").getAll()) {
    if (row.key.startsWith("characterDraft:"))
      photo(parseCharacterProfile(JSON.parse(row.value), true));
    if (row.key.startsWith(LIBRARY_ASSET_PREFIX)) used.add(row.value);
  }
  for (const row of await tx.objectStore("messages").getAll())
    imageIds(row.parts).forEach((assetId) => used.add(assetId));
  for (const row of await tx.objectStore("drafts").getAll()) {
    imageIds(row.parts).forEach((assetId) => used.add(assetId));
    imageIds(row.edit?.parts).forEach((assetId) => used.add(assetId));
  }
  for (const row of await tx.objectStore("visualObservations").getAll())
    used.add(row.assetId);
  for (const row of await tx.objectStore("imageUsages").getAll())
    used.add(row.assetId);
  for (const row of await tx.objectStore("stateTasks").getAll()) {
    photo(row.context.character);
    imageIds(row.context.input.parts).forEach((assetId) => used.add(assetId));
    row.context.visual?.assetCatalog.forEach((a) => used.add(a.assetId));
    row.context.visual?.missingAssets?.forEach((a) => used.add(a.assetId));
  }
  for (const row of await tx.objectStore("compactionTasks").getAll()) {
    photo(row.context.character);
    imageIds(row.context.input.parts).forEach((assetId) => used.add(assetId));
    row.context.visual?.assetCatalog.forEach((a) => used.add(a.assetId));
    row.context.visual?.missingAssets?.forEach((a) => used.add(a.assetId));
  }
  const generations = await tx.objectStore("sceneGenerations").getAll();
  const rejected = new Set(
    generations
      .filter((g) => g.referenceStatus === "rejected")
      .map((g) => g.id),
  );
  const reference = (ref: {
    assetId: string;
    sourceGenerationId: string | null;
  }) => {
    if (!ref.sourceGenerationId || !rejected.has(ref.sourceGenerationId))
      used.add(ref.assetId);
  };
  for (const row of await tx.objectStore("sceneImagePlans").getAll())
    row.referenceImages.forEach(reference);
  for (const row of generations) {
    if (row.assetId && row.referenceStatus !== "rejected")
      used.add(row.assetId);
    row.submission.referenceImages.forEach(reference);
  }
  for (const operation of await tx.objectStore("operations").getAll()) {
    if (operation.kind === "state_update" && operation.result) {
      const plan = (operation.result as StateResult).scenePlan;
      if (plan !== null) plan.referenceImages.forEach(reference);
    }
  }
  for (const asset of await tx.objectStore("assets").getAll())
    if (!used.has(asset.id)) await tx.objectStore("assets").delete(asset.id);
}
export async function putMemory(
  characterId: string,
  sessionId: string,
  value: MemoryValue,
  existing?: Memory,
) {
  const db = await database();
  const tx = db.transaction(
    ["characters", "sessions", "memories"],
    "readwrite",
  );
  return atomic(tx, async () => {
    const character = await tx.objectStore("characters").get(characterId);
    const session = await tx.objectStore("sessions").get(sessionId);
    if (!character || !session || session.characterId !== characterId)
      throw new Error("角色或会话不存在。");
    const records = await tx
      .objectStore("memories")
      .index("character")
      .getAll(characterId);
    const current = existing
      ? await tx.objectStore("memories").get(existing.id)
      : undefined;
    if (existing && current?.version !== existing.version)
      throw new Error("记忆已变化，请重新打开编辑。");
    const memory: Memory = {
      id: existing?.id ?? id(),
      characterId,
      sessionId: value.scope === "character" ? null : sessionId,
      value: { ...value, content: value.content.trim() },
      version: (current?.version ?? 0) + 1,
      origin: "manual",
      sourceSessionId: sessionId,
      sourceMessageIds: current?.sourceMessageIds ?? [],
      createdAt: current?.createdAt ?? now(),
      updatedAt: now(),
    };
    await tx.objectStore("memories").put(memory);
    if (value.scope === "character" || current?.value.scope === "character")
      await tx
        .objectStore("characters")
        .put({ ...character, memoryVersion: character.memoryVersion + 1 });
    await tx
      .objectStore("sessions")
      .put({ ...session, stateVersion: session.stateVersion + 1 });
    return memory;
  });
}

/** 写入中途的同步错误也要回滚，不能让已排队的部分写入自行提交。 */
export async function atomic<T>(
  tx: {
    readonly error: DOMException | null;
    abort(): void;
    readonly done: Promise<void>;
  },
  work: () => Promise<T>,
): Promise<T> {
  try {
    const value = await work();
    await tx.done;
    return value;
  } catch (error) {
    if (!tx.error) tx.abort();
    await tx.done.catch(() => {});
    throw error;
  }
}

export async function migrateV8ToV9(
  tx: import("idb").IDBPTransaction<
    RoleplayDB,
    Array<(typeof TABLES)[number]>,
    "versionchange"
  >,
) {
  for (const table of [
    "assets",
    "sessions",
    "stateTasks",
    "compactionTasks",
    "operations",
    "messages",
  ] as const) {
    let cursor = await tx.objectStore(table).openCursor();
    while (cursor) {
      await cursor.update(
        upgradeV8Record(
          table,
          cursor.value as unknown as Record<string, unknown>,
        ) as never,
      );
      cursor = await cursor.continue();
    }
  }
  let cursor = await tx.objectStore("settings").openCursor();
  while (cursor) {
    if (cursor.value.key.startsWith("dispatch:")) await cursor.delete();
    cursor = await cursor.continue();
  }
}

async function migrateV9ToV10(
  tx: import("idb").IDBPTransaction<
    RoleplayDB,
    Array<(typeof TABLES)[number]>,
    "versionchange"
  >,
) {
  const data: Record<string, unknown[]> = {};
  for (const table of TABLES)
    data[table] = await tx.objectStore(table).getAll();
  const converted = upgradeV9Data(data);
  for (const table of TABLES) {
    await tx.objectStore(table).clear();
    for (const row of converted[table])
      await tx.objectStore(table).put(row as never);
  }
}
