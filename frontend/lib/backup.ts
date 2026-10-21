import { sha256 } from "./images/hash";
import {
  inspectImage,
  validateImageBlob,
  fileBytes,
} from "./images/repository";
import {
  imageIds,
  type ImageAsset,
  type VisualObservation,
  type ImageUsage,
  type VisualTask,
  type ContentPart,
} from "./images/types";
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

type BackupAsset = Omit<ImageAsset, "originalBlob" | "thumbnailBlob"> & {
  base64: string;
};
export type Snapshot = {
  assets: BackupAsset[];
  visualObservations: VisualObservation[];
  imageUsages: ImageUsage[];
  visualTasks: VisualTask[];
  characters: Character[];
  sessions: Session[];
  messages: Message[];
  memories: Memory[];
  drafts: Draft[];
  settings: Setting[];
};
export type Backup = {
  format: "roleplay-agent-backup";
  formatVersion: 1 | 2;
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
  if (new Blob([JSON.stringify(value)]).size > 50 * 1024 * 1024)
    throw new Error("备份不能超过 50 MiB。");
  if (
    value.format !== "roleplay-agent-backup" ||
    ![1, 2].includes(value.formatVersion as number)
  )
    throw new Error("不支持此备份格式或版本，请选择本应用导出的文件。");
  date(value.exportedAt);
  object(value.data);
  const data = value.data;
  if (value.formatVersion === 1) {
    for (const table of [
      "assets",
      "visualObservations",
      "imageUsages",
      "visualTasks",
    ])
      data[table] = [];
  }
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
  validateImages(snapshot);
  return {
    format: "roleplay-agent-backup",
    formatVersion: 2,
    exportedAt: value.exportedAt as string,
    data: snapshot,
  };
}
function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("备份原图编码无效。");
  }
}
function validateImages(snapshot: Snapshot) {
  const assets = new Map(snapshot.assets.map((a) => [a.id, a]));
  const hashes = new Set<string>();
  const messages = new Map(snapshot.messages.map((m) => [m.id, m]));
  const sessions = new Set(snapshot.sessions.map((s) => s.id));
  for (const a of snapshot.assets) {
    string(a.sha256, 64);
    string(a.mimeType, 100);
    string(a.displayName, 1000);
    string(a.base64, 14_000_000);
    integer(a.byteSize, 1);
    integer(a.width, 1);
    integer(a.height, 1);
    if (
      a.byteSize > 10 * 1024 * 1024 ||
      a.width * a.height > 20_000_000 ||
      hashes.has(a.sha256)
    )
      throw new Error("备份原图超限或重复。");
    hashes.add(a.sha256);
    const bytes = decodeBase64(a.base64);
    const size = inspectImage(bytes, a.mimeType);
    if (
      bytes.length !== a.byteSize ||
      size.width !== a.width ||
      size.height !== a.height ||
      sha256(bytes) !== a.sha256
    )
      throw new Error("备份原图哈希或元信息不一致。");
  }
  const checkParts = (parts: unknown, text: string, user = true) => {
    if (parts === undefined) return;
    if (!Array.isArray(parts)) throw new Error("图片内容块无效。");
    const ids = new Set<string>();
    const texts: string[] = [];
    for (const part of parts) {
      object(part);
      if (part.type === "text") {
        string(part.text, 2000);
        texts.push(part.text);
      } else if (part.type === "image" && user) {
        string(part.assetId, 200);
        if (!assets.has(part.assetId) || ids.has(part.assetId))
          throw new Error("图片引用缺失或重复。");
        ids.add(part.assetId);
      } else throw new Error("图片内容块类型无效。");
    }
    if (texts.join("\n") !== text || ids.size > 4)
      throw new Error("图片消息的文字或数量不一致。");
  };
  for (const m of snapshot.messages)
    checkParts(
      m.parts,
      m.role === "user" ? (m.text ?? "") : "",
      m.role === "user",
    );
  for (const d of snapshot.drafts) {
    // Draft parts contain attachment references; text is stored independently for IME-safe autosaving.
    checkParts(d.parts, "");
  }
  const sessionHasAsset = (sessionId: string, assetId: string) =>
    snapshot.messages.some(
      (m) =>
        m.sessionId === sessionId &&
        m.role === "user" &&
        imageIds(m.parts).includes(assetId),
    );
  for (const o of snapshot.visualObservations) {
    if (
      !sessions.has(o.sessionId) ||
      !sessionHasAsset(o.sessionId, o.assetId) ||
      o.id !== `${o.sessionId}:${o.assetId}`
    )
      throw new Error("视觉观察来源无效。");
    string(o.summary, 600);
    integer(o.version, 1);
    for (const field of [
      o.visibleDetails,
      o.extractedText,
      o.uncertainDetails,
    ]) {
      if (!Array.isArray(field) || field.length > 20)
        throw new Error("视觉观察列表无效。");
      field.forEach((v) => string(v, 300));
    }
    if (
      !Array.isArray(o.sourceMessageIds) ||
      !o.sourceMessageIds.length ||
      o.sourceMessageIds.some(
        (id) => messages.get(id)?.sessionId !== o.sessionId,
      )
    )
      throw new Error("视觉观察消息来源无效。");
  }
  for (const u of snapshot.imageUsages) {
    if (
      !sessionHasAsset(u.sessionId, u.assetId) ||
      messages.get(u.messageId)?.sessionId !== u.sessionId ||
      u.id !== `${u.messageId}:${u.assetId}`
    )
      throw new Error("图片使用记录来源无效。");
    string(u.purpose, 2000);
  }
  for (const task of snapshot.visualTasks) {
    const user = messages.get(task.userMessageId),
      assistant = messages.get(task.assistantMessageId);
    if (
      !sessions.has(task.sessionId) ||
      user?.sessionId !== task.sessionId ||
      user.role !== "user" ||
      assistant?.sessionId !== task.sessionId ||
      assistant.role !== "assistant" ||
      assistant.replyToMessageId !== user.id ||
      assistant.status !== "complete" ||
      task.id !== assistant.id
    )
      throw new Error("视觉任务来源无效。");
    string(task.assistantText);
    object(task.context);
    object(task.context.input);
    object(task.context.visual);
    if (
      task.context.visual.sessionId !== task.sessionId ||
      !Array.isArray(task.context.visual.assetCatalog) ||
      !Array.isArray(task.context.visual.imagePayloads) ||
      task.context.visual.imagePayloads.length
    )
      throw new Error("视觉任务上下文无效。");
    checkParts(task.context.input.parts, user.text ?? "");
    if (JSON.stringify(task.context.input.parts) !== JSON.stringify(user.parts))
      throw new Error("视觉任务输入不一致。");
    for (const a of task.context.visual.assetCatalog) {
      object(a);
      if (
        !sessionHasAsset(task.sessionId, a.assetId) ||
        !Array.isArray(a.sources) ||
        a.sources.some(
          (source) =>
            messages.get(source.messageId)?.sessionId !== task.sessionId,
        )
      )
        throw new Error("视觉任务图片目录来源无效。");
    }
    const plan = task.context.visual.plan;
    if (plan !== null) {
      object(plan);
      if (
        plan.status !== "ready" ||
        !Array.isArray(plan.selectedHistoricalImages) ||
        plan.selectedHistoricalImages.some(
          (v) =>
            !task.context.visual!.assetCatalog.some(
              (a) => a.assetId === v.assetId,
            ),
        )
      )
        throw new Error("视觉任务选图计划无效。");
    }
  }
}
export async function takeSnapshot(): Promise<Backup> {
  const db = await database();
  const tx = db.transaction(TABLES, "readonly");
  const rows = await Promise.all(
    TABLES.map(
      async (table) => [table, await tx.objectStore(table).getAll()] as const,
    ),
  );
  await tx.done;
  const data = Object.fromEntries(rows) as unknown as Snapshot & {
    assets: ImageAsset[];
  };
  const serialized: BackupAsset[] = [];
  for (const asset of data.assets) {
    const { originalBlob, thumbnailBlob, ...metadata } = asset;
    const bytes = new Uint8Array(await fileBytes(originalBlob));
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    serialized.push({ ...metadata, base64: btoa(binary) });
  }
  const backup: Backup = {
    format: "roleplay-agent-backup",
    formatVersion: 2,
    exportedAt: new Date().toISOString(),
    data: { ...data, assets: serialized },
  };
  if (new Blob([JSON.stringify(backup)]).size > 50 * 1024 * 1024)
    throw new Error("完整备份超过 50 MiB，未省略任何图片；本地数据保持完整。");
  return backup;
}
export async function restoreSnapshot(backup: Backup) {
  const validated = validateBackup(structuredClone(backup));
  const assets: ImageAsset[] = [];
  for (const asset of validated.data.assets) {
    const { base64, ...metadata } = asset;
    const originalBlob = new Blob([decodeBase64(base64) as BlobPart], {
      type: asset.mimeType,
    });
    const info = await validateImageBlob(originalBlob);
    assets.push({
      ...metadata,
      originalBlob,
      thumbnailBlob: info.thumbnailBlob,
    });
  }
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  for (const table of TABLES) {
    await tx.objectStore(table).clear();
    const rows = table === "assets" ? assets : validated.data[table];
    for (const row of rows) await tx.objectStore(table).put(row);
  }
  await tx.done;
}
