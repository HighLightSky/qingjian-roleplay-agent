import type { StateTask, Operation, Goal } from "./state/types";
import {
  object,
  string,
  integer,
  validateSnapshot,
  validateStory,
  validateStateResult,
  validateMemoryValue,
  sourceIds,
  validateGoalValue,
} from "./state/validation";
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
} from "./images/types";
import { database, TABLES, atomic } from "./db";
import {
  parseCharacterProfile,
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
  stateTasks: StateTask[];
  operations: Operation[];
  goals: Goal[];
  characters: Character[];
  sessions: Session[];
  messages: Message[];
  memories: Memory[];
  drafts: Draft[];
  settings: Setting[];
};
export type Backup = {
  format: "roleplay-agent-backup";
  formatVersion: 5;
  exportedAt: string;
  data: Snapshot;
};
function date(value: unknown) {
  string(value, 100);
  if (!Number.isFinite(Date.parse(value)))
    throw new Error("备份中的日期无效。");
}
export function validateBackup(value: unknown): Backup {
  object(value);
  if (new Blob([JSON.stringify(value)]).size > 50 * 1024 * 1024)
    throw new Error("备份不能超过 50 MiB。");
  if (value.format !== "roleplay-agent-backup" || value.formatVersion !== 5)
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
    parseCharacterProfile(character);
    date(character.createdAt);
    if (typeof character.archived !== "boolean")
      throw new Error("角色归档状态无效。");
    integer(character.profileVersion, 1);
    integer(character.memoryVersion);
  }
  for (const session of snapshot.sessions) {
    if (!characters.has(session.characterId))
      throw new Error("会话引用了不存在的角色。");
    parseCharacterProfile(session.characterSnapshot);
    date(session.createdAt);
    string(session.title, 240);
    if (!["default", "first-message", "manual"].includes(session.titleSource))
      throw new Error("会话标题来源无效。");
    integer(session.profileVersion, 1);
    integer(session.nextMessageSeq, 1);
    integer(session.stateVersion);
    integer(session.stateProcessedThroughSeq);
    validateStory(session.story);
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
      session.stateProcessedThroughSeq >= session.nextMessageSeq
    )
      throw new Error("会话消息游标无效。");
  }
  for (const memory of snapshot.memories) {
    if (
      !characters.has(memory.characterId) ||
      (memory.sessionId !== null &&
        sessions.get(memory.sessionId)?.characterId !== memory.characterId)
    )
      throw new Error("记忆引用了不存在的角色或会话。");
    validateMemoryValue(memory.value);
    integer(memory.version, 1);
    sourceIds(memory.sourceMessageIds);
    date(memory.createdAt);
    string(memory.sourceSessionId, 200);
    if (!["manual", "automatic"].includes(memory.origin))
      throw new Error("记忆维护来源无效。");
  }
  for (const goal of snapshot.goals) {
    if (!sessions.has(goal.sessionId))
      throw new Error("目标引用了不存在的会话。");
    validateGoalValue(goal.value);
    integer(goal.version, 1);
    sourceIds(goal.sourceMessageIds);
    date(goal.createdAt);
    if (!["manual", "automatic"].includes(goal.origin))
      throw new Error("目标维护来源无效。");
  }
  for (const session of snapshot.sessions) {
    const character = characters.get(session.characterId)!;
    validateSnapshot({
      sessionId: session.id,
      characterId: character.id,
      sessionVersion: session.stateVersion,
      memoryVersion: character.memoryVersion,
      processedThroughSeq: session.stateProcessedThroughSeq,
      story: session.story,
      storySources: session.storySources,
      memories: snapshot.memories.filter(
        (m) =>
          m.characterId === character.id &&
          (m.sessionId === null || m.sessionId === session.id),
      ),
      goals: snapshot.goals.filter((g) => g.sessionId === session.id),
    });
  }
  for (const draft of snapshot.drafts) {
    if (!sessions.has(draft.sessionId))
      throw new Error("草稿引用了不存在的会话。");
    string(draft.text, 2000);
  }
  for (const setting of snapshot.settings) {
    string(setting.value, 50_000);
    if (setting.key.startsWith("characterDraft:")) {
      parseCharacterProfile(JSON.parse(setting.value), true);
    }
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
    formatVersion: 5,
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
  const operations = new Map(snapshot.operations.map((o) => [o.id, o]));
  for (const op of snapshot.operations) {
    if (
      messages.get(op.anchorMessageId)?.sessionId !== op.sessionId ||
      !sessions.has(op.sessionId) ||
      !["selection", "state_update"].includes(op.kind) ||
      !["before", "after"].includes(op.placement) ||
      ![
        "pending",
        "running",
        "computed",
        "committed",
        "failed",
        "cancelled",
        "stale",
      ].includes(op.status)
    )
      throw new Error("操作记录来源或状态无效。");
    string(op.runId, 200);
    if (op.error !== undefined) string(op.error, 8000);
    if (op.result !== undefined) {
      if (op.kind === "state_update") {
        validateStateResult(op.result);
        if (
          !Array.isArray(op.sourceVersions) ||
          op.sourceVersions.some((source) => {
            integer(source.checkpointVersion);
            string(source.id, 200);
            return messages.get(source.id)?.sessionId !== op.sessionId;
          })
        )
          throw new Error("整理结果缺少有效的来源版本。");
        if (
          op.result.operationId !== op.id ||
          op.result.throughSeq !== messages.get(op.anchorMessageId)!.seq
        )
          throw new Error("操作结果 ID 或处理区间无效。");
        for (const change of [
          ...op.result.storyChanges,
          ...op.result.memoryChanges,
          ...op.result.goalChanges,
        ]) {
          if (
            change.sourceMessageIds.some((id) => {
              const m = messages.get(id);
              return (
                !m ||
                m.sessionId !== op.sessionId ||
                m.status !== "complete" ||
                m.seq <=
                  (op.result as import("./state/types").StateResult)
                    .fromExclusiveSeq ||
                m.seq >
                  (op.result as import("./state/types").StateResult).throughSeq
              );
            })
          )
            throw new Error("整理变更的消息来源无效。");
        }
        for (const change of op.result.memoryChanges) {
          const memory = snapshot.memories.find((m) => m.id === change.id);
          if (change.action === "create" && memory && op.status !== "committed")
            throw new Error("待提交记忆 ID 已被使用。");
          if (
            change.action === "update" &&
            (!memory ||
              memory.characterId !==
                snapshot.sessions.find((s) => s.id === op.sessionId)!
                  .characterId ||
              (memory.sessionId !== null && memory.sessionId !== op.sessionId))
          )
            throw new Error("整理结果修改了无关记忆。");
        }
        for (const change of op.result.goalChanges) {
          const goal = snapshot.goals.find((g) => g.id === change.id);
          if (change.action === "create" && goal && op.status !== "committed")
            throw new Error("待提交目标 ID 已被使用。");
          if (
            change.action === "update" &&
            (!goal || goal.sessionId !== op.sessionId)
          )
            throw new Error("整理结果修改了无关目标。");
        }
        for (const observation of op.result.visualObservations) {
          if (
            !sessionHasAsset(op.sessionId, observation.assetId) ||
            observation.sourceMessageIds.some(
              (id) => messages.get(id)?.sessionId !== op.sessionId,
            )
          )
            throw new Error("整理结果的视觉来源无效。");
        }
      } else {
        const selection: unknown = op.result;
        object(selection);
        object(selection.plan);
        const plan = selection.plan;
        if (
          plan.operationId !== op.id ||
          !["ready", "ambiguous", "over_limit"].includes(
            plan.status as string,
          ) ||
          !Array.isArray(plan.selectedHistoricalImages) ||
          !Array.isArray(plan.candidateAssetIds) ||
          !Array.isArray(selection.catalog)
        )
          throw new Error("选图操作结果无效。");
        string(plan.message, 2000);
        string(plan.contextFingerprint, 200);
        const catalogIds = new Set<string>();
        for (const a of selection.catalog as unknown[]) {
          object(a);
          string(a.assetId, 200);
          catalogIds.add(a.assetId);
          if (!sessionHasAsset(op.sessionId, a.assetId as string))
            throw new Error("选图结果包含其他会话图片。");
          if (!Array.isArray(a.sources) || !a.sources.length)
            throw new Error("选图结果缺少图片来源。");
          for (const source of a.sources) {
            object(source);
            string(source.messageId, 200);
            const message = messages.get(source.messageId);
            if (
              !message ||
              message.sessionId !== op.sessionId ||
              message.seq !== source.seq ||
              !imageIds(message.parts).includes(a.assetId)
            )
              throw new Error("选图结果的消息来源无效。");
          }
        }
        const selectedIds = new Set<string>();
        for (const selected of plan.selectedHistoricalImages) {
          object(selected);
          string(selected.assetId, 200);
          string(selected.purpose, 2000);
          if (
            !catalogIds.has(selected.assetId) ||
            selectedIds.has(selected.assetId)
          )
            throw new Error("选图结果引用无效或重复。");
          selectedIds.add(selected.assetId);
        }
        if (
          plan.candidateAssetIds.some(
            (id) => typeof id !== "string" || !catalogIds.has(id),
          )
        )
          throw new Error("选图候选来源无效。");
      }
    } else if (["computed", "committed"].includes(op.status))
      throw new Error("操作缺少计算结果。");
    if (op.status === "running") {
      op.status = "cancelled";
      op.error = "从备份恢复的操作已中断。";
    }
  }
  for (const task of snapshot.stateTasks) {
    const assistant = messages.get(task.assistantMessageId);
    if (
      !assistant ||
      assistant.sessionId !== task.sessionId ||
      assistant.role !== "assistant" ||
      assistant.status !== "complete" ||
      task.throughSeq !== assistant.seq ||
      task.id !== `state:${assistant.id}` ||
      !operations.has(task.id) ||
      operations.get(task.id)!.status === "committed"
    )
      throw new Error("整理任务来源无效。");
    integer(task.automaticAttempts);
    object(task.context);
    validateSnapshot(task.context.state);
    parseCharacterProfile(task.context.character);
    parseInteractionSettings(task.context.interactionSettings);
    string(task.context.earlierHistory, 20_000);
    object(task.context.input);
    if (task.context.state.sessionId !== task.sessionId)
      throw new Error("整理任务会话无效。");
    const user = messages.get(assistant.replyToMessageId!);
    if (!user || user.role !== "user" || user.sessionId !== task.sessionId)
      throw new Error("整理输入来源缺失。");
    checkParts(task.context.input.parts, user.text ?? "");
    if (
      task.context.input.text !== user.text ||
      JSON.stringify(task.context.input.parts) !== JSON.stringify(user.parts)
    )
      throw new Error("整理任务输入不一致。");
    if (task.context.visual) {
      const visual = task.context.visual;
      if (
        visual.sessionId !== task.sessionId ||
        !Array.isArray(visual.imagePayloads) ||
        visual.imagePayloads.length ||
        !Array.isArray(visual.assetCatalog)
      )
        throw new Error("整理任务图片上下文无效。");
      for (const a of visual.assetCatalog) {
        if (
          !sessionHasAsset(task.sessionId, a.assetId) ||
          a.sources.some(
            (s) => messages.get(s.messageId)?.sessionId !== task.sessionId,
          )
        )
          throw new Error("整理任务图片来源无效。");
      }
      if (
        visual.plan &&
        (visual.plan.status !== "ready" ||
          visual.plan.selectedHistoricalImages.some(
            (s) => !visual.assetCatalog.some((a) => a.assetId === s.assetId),
          ))
      )
        throw new Error("整理任务选图计划无效。");
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
    formatVersion: 5,
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
  await atomic(tx, async () => {
    for (const table of TABLES) {
      await tx.objectStore(table).clear();
      const rows = table === "assets" ? assets : validated.data[table];
      for (const row of rows) await tx.objectStore(table).put(row);
    }
  });
}
