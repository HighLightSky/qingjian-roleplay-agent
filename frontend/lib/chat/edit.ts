import { database, TABLES, atomic, collectUnreferenced } from "../db";
import { now, type Message, type EditDraft } from "../domain";
import { imageIds, type ContentPart } from "../images/types";
import type { Operation } from "../state/types";
import { unknownUsage } from "../context/types";

export function failedTurn(messages: Message[], operations: Operation[]) {
  const user = messages.filter((m) => m.role === "user").at(-1);
  const assistant = messages.at(-1);
  if (
    !user ||
    !assistant ||
    assistant.replyToMessageId !== user.id ||
    !["error", "cancelled", "interrupted"].includes(assistant.status) ||
    operations.some(
      (o) =>
        o.anchorMessageId === assistant.id &&
        o.kind === "state_update" &&
        ["computed", "committed"].includes(o.status),
    )
  )
    return undefined;
  return { user, assistant };
}

async function requireFailedTurn(
  tx: import("../images/ids").ImageWriteTransaction,
  sessionId: string,
  userMessageId: string,
) {
  const messages = await tx
    .objectStore("messages")
    .index("sequence")
    .getAll(
      IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]),
    );
  const operations = await tx
    .objectStore("operations")
    .index("session")
    .getAll(sessionId);
  const turn = failedTurn(messages, operations);
  if (!turn || turn.user.id !== userMessageId)
    throw new Error("仅支持编辑或重试最近一轮失败、中断的回复。");
  const runs = await tx.objectStore("settings").getAll();
  if (
    runs.some(
      (r) =>
        r.key.startsWith("dispatch:") &&
        JSON.parse(r.value).sessionId === sessionId,
    )
  )
    throw new Error("本轮后台任务尚未处理完毕，请先恢复或停止任务。");
  return turn;
}

export async function beginEditDraft(sessionId: string, userMessageId: string) {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  return atomic(tx, async () => {
    const { user, assistant } = await requireFailedTurn(
      tx,
      sessionId,
      userMessageId,
    );
    const draft = await tx.objectStore("drafts").get(sessionId);
    if (!draft) throw new Error("编辑消息的会话草稿缺失。");
    if (draft.edit) return draft.edit;
    const edit: EditDraft = {
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      userCheckpointVersion: user.checkpointVersion,
      assistantCheckpointVersion: assistant.checkpointVersion,
      text: user.text ?? "",
      parts: imageIds(user.parts).map((assetId) => ({
        type: "image",
        assetId,
      })),
    };
    await tx.objectStore("drafts").put({ ...draft, edit, updatedAt: now() });
    return edit;
  });
}

export async function discardEditDraft(
  sessionId: string,
  userMessageId: string,
) {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  await atomic(tx, async () => {
    const draft = await tx.objectStore("drafts").get(sessionId);
    if (draft?.edit?.userMessageId !== userMessageId) return;
    await tx
      .objectStore("drafts")
      .put({ ...draft, edit: undefined, updatedAt: now() });
    await collectUnreferenced(tx);
  });
}

export async function replaceFailedTurn(
  sessionId: string,
  userMessageId: string,
  text: string,
  parts?: ContentPart[],
) {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  return atomic(tx, async () => {
    const previous = await requireFailedTurn(tx, sessionId, userMessageId);
    const draft = await tx.objectStore("drafts").get(sessionId);
    if (!draft) throw new Error("重发消息的会话草稿缺失。");
    const edit = draft.edit;
    if (
      edit &&
      (edit.userMessageId !== previous.user.id ||
        edit.assistantMessageId !== previous.assistant.id ||
        edit.userCheckpointVersion !== previous.user.checkpointVersion ||
        edit.assistantCheckpointVersion !==
          previous.assistant.checkpointVersion)
    )
      throw new Error("编辑期间原消息已变化，请取消编辑后重新打开。");
    if (!text.trim() && !imageIds(parts).length)
      throw new Error("请输入文字或添加图片。");
    for (const assetId of imageIds(parts)) {
      if (!(await tx.objectStore("assets").get(assetId)))
        throw new Error(`本轮图片原件缺失：${assetId}，请移除或重新选择。`);
    }
    const sentAt = now();
    const user: Message = {
      ...previous.user,
      text,
      parts,
      checkpointVersion: previous.user.checkpointVersion + 1,
      createdAt: sentAt,
      updatedAt: sentAt,
    };
    const assistant: Message = {
      ...previous.assistant,
      segments: [],
      status: "pending",
      error: undefined,
      finishReason: undefined,
      usage: unknownUsage(),
      checkpointVersion: previous.assistant.checkpointVersion + 1,
      createdAt: sentAt,
      updatedAt: sentAt,
    };
    await tx.objectStore("messages").put(user);
    await tx.objectStore("messages").put(assistant);
    for (const table of [
      "operations",
      "stateTasks",
      "compactionTasks",
      "imageUsages",
    ] as const) {
      for (const row of await tx
        .objectStore(table)
        .index("session")
        .getAll(sessionId)) {
        const anchored =
          "anchorMessageId" in row
            ? row.anchorMessageId
            : "assistantMessageId" in row
              ? row.assistantMessageId
              : row.messageId;
        if (
          anchored === assistant.id &&
          !(
            "kind" in row &&
            row.kind === "compaction" &&
            row.status === "committed"
          )
        )
          await tx.objectStore(table).delete(row.id);
      }
    }
    await tx
      .objectStore("drafts")
      .put({ ...draft, edit: undefined, updatedAt: sentAt });
    const session = await tx.objectStore("sessions").get(sessionId);
    if (!session) throw new Error("重发消息的会话不存在。");
    await tx.objectStore("sessions").put({ ...session, updatedAt: sentAt });
    await collectUnreferenced(tx);
    return { user, assistant };
  });
}
