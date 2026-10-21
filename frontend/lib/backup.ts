import { database, TABLES } from "./db";
import {
  EMPTY_PROFILE,
  parseInteractionSettings,
  type Character,
  type Draft,
  type Memory,
  type Message,
  type Session,
  type Setting,
} from "./domain";

export type Snapshot = {
  characters: Character[];
  sessions: Session[];
  messages: Message[];
  memories: Memory[];
  drafts: Draft[];
  settings: Setting[];
};
export type Backup = {
  format: "roleplay-agent-backup";
  formatVersion: 1;
  exportedAt: string;
  data: Snapshot;
};
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("备份包含无效记录。");
}
function string(value: unknown, max = 1_000_000): asserts value is string {
  if (typeof value !== "string" || value.length > max)
    throw new Error("备份中的文字字段无效或过长。");
}
function integer(value: unknown, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min)
    throw new Error("备份中的序号无效。");
}
function date(value: unknown) {
  string(value, 100);
  if (!Number.isFinite(Date.parse(value)))
    throw new Error("备份中的日期无效。");
}
function profile(value: unknown) {
  object(value);
  for (const key of Object.keys(EMPTY_PROFILE))
    string(value[key], key === "name" ? 120 : 8000);
  if (!(value.name as string).trim() || !(value.description as string).trim())
    throw new Error("备份中的角色资料不完整。");
}
export function validateBackup(value: unknown): Backup {
  object(value);
  if (value.format !== "roleplay-agent-backup" || value.formatVersion !== 1)
    throw new Error("不支持此备份格式或版本，请选择本应用导出的文件。");
  date(value.exportedAt);
  object(value.data);
  const data = value.data;
  for (const table of TABLES) {
    if (!Array.isArray(data[table]))
      throw new Error(`备份缺少 ${table} 数据。`);
    const keys = new Set<string>();
    for (const row of data[table]) {
      object(row);
      const key =
        row[
          table === "settings" ? "key" : table === "drafts" ? "sessionId" : "id"
        ];
      string(key, 200);
      if (!key || keys.has(key)) throw new Error("备份包含空 ID 或重复记录。");
      keys.add(key);
      if (table !== "settings") date(row.updatedAt ?? row.createdAt);
    }
  }
  const snapshot = data as unknown as Snapshot;
  const characters = new Map(
    snapshot.characters.map((character) => [character.id, character]),
  );
  const sessions = new Map(
    snapshot.sessions.map((session) => [session.id, session]),
  );
  const sequences = new Set<string>();
  const maxSeq = new Map<string, number>();
  for (const character of snapshot.characters) {
    profile(character);
    date(character.createdAt);
    if (typeof character.archived !== "boolean")
      throw new Error("角色归档状态无效。");
    integer(character.profileVersion, 1);
    string(character.sharedSummary, 8000);
  }
  for (const session of snapshot.sessions) {
    if (!characters.has(session.characterId))
      throw new Error("会话引用了不存在的角色。");
    profile(session.characterSnapshot);
    date(session.createdAt);
    string(session.title, 240);
    if (session.titleSource === undefined) session.titleSource = "manual";
    if (!["default", "first-message", "manual"].includes(session.titleSource))
      throw new Error("会话标题来源无效。");
    integer(session.profileVersion, 1);
    integer(session.nextMessageSeq, 1);
    integer(session.summaryThroughSeq);
    string(session.summary, 8000);
  }
  for (const message of snapshot.messages) {
    if (!sessions.has(message.sessionId))
      throw new Error("消息引用了不存在的会话。");
    integer(message.seq, 1);
    integer(message.checkpointVersion);
    date(message.createdAt);
    const key = `${message.sessionId}:${message.seq}`;
    if (sequences.has(key)) throw new Error("会话中存在重复消息序号。");
    sequences.add(key);
    maxSeq.set(
      message.sessionId,
      Math.max(maxSeq.get(message.sessionId) ?? 0, message.seq),
    );
    if (
      ![
        "pending",
        "streaming",
        "complete",
        "cancelled",
        "error",
        "interrupted",
      ].includes(message.status)
    )
      throw new Error("消息状态无效。");
    if (message.role === "user") string(message.text, 2000);
    else if (message.role === "assistant" && Array.isArray(message.segments)) {
      for (const segment of message.segments) {
        object(segment);
        if (!["dialogue", "narration"].includes(segment.kind as string))
          throw new Error("消息段落类型无效。");
        string(segment.text);
      }
    } else throw new Error("消息内容或发送方无效。");
    if (message.error !== undefined) string(message.error, 8000);
    if (message.finishReason !== undefined) string(message.finishReason, 200);
    if (["pending", "streaming"].includes(message.status)) {
      message.status = "interrupted";
      message.error = "从备份恢复的生成已中断。";
    }
  }
  for (const session of snapshot.sessions) {
    if (
      session.nextMessageSeq <= (maxSeq.get(session.id) ?? 0) ||
      session.summaryThroughSeq >= session.nextMessageSeq
    )
      throw new Error("会话消息游标无效。");
  }
  const counts = new Map<string, number>();
  for (const memory of snapshot.memories) {
    if (!characters.has(memory.characterId))
      throw new Error("记忆引用了不存在的角色。");
    string(memory.content, 300);
    date(memory.createdAt);
    if (!memory.content.trim()) throw new Error("记忆内容不能为空。");
    counts.set(memory.characterId, (counts.get(memory.characterId) ?? 0) + 1);
    if (counts.get(memory.characterId)! > 50)
      throw new Error("角色记忆超过 50 条。");
  }
  for (const draft of snapshot.drafts) {
    if (!sessions.has(draft.sessionId))
      throw new Error("草稿引用了不存在的会话。");
    string(draft.text, 2000);
  }
  for (const setting of snapshot.settings) {
    string(setting.value, 50_000);
    if (setting.key === "interactionSettings") {
      try {
        parseInteractionSettings(JSON.parse(setting.value));
      } catch {
        throw new Error("备份中的交互设置无效。");
      }
    }
    if (
      setting.key === "themeMode" &&
      !["system", "light", "dark"].includes(setting.value)
    )
      throw new Error("主题设置无效。");
  }
  return {
    format: "roleplay-agent-backup",
    formatVersion: 1,
    exportedAt: value.exportedAt as string,
    data: snapshot,
  };
}
export async function takeSnapshot(): Promise<Backup> {
  const db = await database();
  const tx = db.transaction(TABLES, "readonly");
  const [characters, sessions, messages, memories, drafts, settings] =
    await Promise.all(TABLES.map((table) => tx.objectStore(table).getAll()));
  await tx.done;
  return {
    format: "roleplay-agent-backup",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    data: {
      characters,
      sessions,
      messages,
      memories,
      drafts,
      settings,
    } as Snapshot,
  };
}
export async function restoreSnapshot(backup: Backup) {
  const validated = validateBackup(structuredClone(backup));
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  for (const table of TABLES) {
    await tx.objectStore(table).clear();
    for (const row of validated.data[table])
      await tx.objectStore(table).put(row);
  }
  await tx.done;
}
