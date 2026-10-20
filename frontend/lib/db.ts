import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  id,
  now,
  profileOf,
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
] as const;
let connection: Promise<IDBPDatabase<RoleplayDB>> | undefined;
export function database(): Promise<IDBPDatabase<RoleplayDB>> {
  if (!connection) {
    connection = openDB<RoleplayDB>("roleplay-agent", 1, {
      upgrade(db) {
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
  const tx = db.transaction("messages", "readwrite");
  for (const status of ["pending", "streaming"]) {
    const messages = await tx.store.index("status").getAll(status);
    for (const message of messages)
      await tx.store.put({
        ...message,
        status: "interrupted",
        error: "上次生成中断，已保留保存的内容。",
        updatedAt: now(),
      });
  }
  await tx.done;
}
export async function saveCharacter(
  profile: CharacterProfile,
  existing?: Character,
) {
  if (!profile.name.trim() || !profile.description.trim())
    throw new Error("请填写角色名称与身份背景。");
  const character: Character = {
    ...profile,
    name: profile.name.trim(),
    id: existing?.id ?? id(),
    archived: existing?.archived ?? false,
    profileVersion: (existing?.profileVersion ?? 0) + 1,
    sharedSummary: existing?.sharedSummary ?? "",
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  };
  const db = await database();
  const tx = db.transaction("characters", "readwrite");
  await tx.store.put(character);
  await tx.done;
  return character;
}
export async function createSession(characterId: string) {
  const db = await database();
  const tx = db.transaction(
    ["characters", "sessions", "messages", "drafts", "settings"],
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
    summary: "",
    summaryThroughSeq: 0,
    nextMessageSeq: character.openingScene.trim() ? 2 : 1,
    createdAt: now(),
    updatedAt: now(),
  };
  await tx.objectStore("sessions").put(session);
  if (character.openingScene.trim())
    await tx.objectStore("messages").put({
      id: id(),
      sessionId: session.id,
      seq: 1,
      role: "assistant",
      segments: [{ kind: "narration", text: character.openingScene }],
      status: "complete",
      finishReason: "stop",
      checkpointVersion: 0,
      createdAt: now(),
      updatedAt: now(),
    });
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
export async function beginTurn(sessionId: string, text: string) {
  const db = await database();
  const tx = db.transaction(["sessions", "messages", "drafts"], "readwrite");
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
      ? { title: titleFrom(text), titleSource: "first-message" as const }
      : {}),
  };
  await tx.objectStore("messages").put(user);
  await tx.objectStore("messages").put(assistant);
  await tx.objectStore("sessions").put(updated);
  await tx.objectStore("drafts").put({ sessionId, text: "", updatedAt: now() });
  await tx.done;
  return { user, assistant, session: updated };
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
  const tx = db.transaction(
    ["sessions", "messages", "drafts", "settings"],
    "readwrite",
  );
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
  await tx.objectStore("sessions").delete(sessionId);
  await tx.objectStore("drafts").delete(sessionId);
  if ((await tx.objectStore("settings").get("sessionId"))?.value === sessionId)
    await tx.objectStore("settings").delete("sessionId");
  await tx.done;
}
export async function putMemory(
  characterId: string,
  content: string,
  existing?: Memory,
  source?: { sourceSessionId: string; sourceMessageId: string },
) {
  if (!content.trim() || content.length > 300)
    throw new Error("记忆内容需要在 1–300 个字符之间。");
  const db = await database();
  const tx = db.transaction(["characters", "memories"], "readwrite");
  if (!(await tx.objectStore("characters").get(characterId))) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error("角色不存在。");
  }
  const memories = tx.objectStore("memories");
  if (
    !existing &&
    (await memories.index("character").count(characterId)) >= 50
  ) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error("每个角色最多 50 条重要事实，请先合并或删除。");
  }
  const memory: Memory = {
    ...existing,
    ...source,
    id: existing?.id ?? id(),
    characterId,
    content: content.trim(),
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  };
  await memories.put(memory);
  await tx.done;
  return memory;
}
