import { validateMemoryValue } from "./state/validation";
import {
  EMPTY_STORY,
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
    connection = openDB<RoleplayDB>("roleplay-agent", 3, {
      upgrade(db) {
        for (const name of Array.from(db.objectStoreNames))
          db.deleteObjectStore(name);
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
        db.createObjectStore("assets", { keyPath: "id" }).createIndex(
          "sha256",
          "sha256",
          { unique: true },
        );
        for (const name of [
          "visualObservations",
          "imageUsages",
          "stateTasks",
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
      throw error;
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
  const tx = db.transaction(["messages", "operations"], "readwrite");
  for (const status of ["pending", "streaming"]) {
    const messages = await tx
      .objectStore("messages")
      .index("status")
      .getAll(status);
    for (const message of messages)
      await tx.objectStore("messages").put({
        ...message,
        status: "interrupted",
        error: "上次生成中断，已保留保存的内容。",
        updatedAt: now(),
      });
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
) {
  const validated = parseCharacterProfile(profile);
  const db = await database();
  const tx = db.transaction("characters", "readwrite");
  const current = existing ? await tx.store.get(existing.id) : undefined;
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
  await tx.store.put(character);
  await tx.done;
  return character;
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
    stateVersion: 0,
    stateProcessedThroughSeq: 0,
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
export async function beginTurn(
  sessionId: string,
  text: string,
  parts?: ContentPart[],
) {
  const db = await database();
  const tx = db.transaction(["sessions", "messages", "drafts"], "readwrite");
  return atomic(tx, async () => {
    const session = await tx.objectStore("sessions").get(sessionId);
    if (!session) {
      tx.abort();
      await tx.done.catch(() => {});
      throw new Error("会话不存在。");
    }
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
  for (const table of [
    "visualObservations",
    "imageUsages",
    "stateTasks",
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
  for (const row of await tx.objectStore("messages").getAll())
    imageIds(row.parts).forEach((assetId) => used.add(assetId));
  for (const row of await tx.objectStore("drafts").getAll())
    imageIds(row.parts).forEach((assetId) => used.add(assetId));
  for (const row of await tx.objectStore("visualObservations").getAll())
    used.add(row.assetId);
  for (const row of await tx.objectStore("imageUsages").getAll())
    used.add(row.assetId);
  for (const row of await tx.objectStore("stateTasks").getAll()) {
    imageIds(row.context.input.parts).forEach((assetId) => used.add(assetId));
    row.context.visual?.assetCatalog.forEach((a) => used.add(a.assetId));
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
  validateMemoryValue(value);
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
    if (
      !existing &&
      records.filter((m) => m.sessionId === null || m.sessionId === sessionId)
        .length >= 50
    )
      throw new Error("当前会话可用记忆已达到 50 条，请修改已有项。");
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
