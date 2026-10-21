import type { IDBPTransaction, StoreNames } from "idb";
import type { RoleplayDB } from "../db";
import type { ChatContext } from "../chat/context";
import { historyMessages } from "../chat/context";
import { emptySummary, unknownUsage } from "./types";

/** 一次性转换冻结的旧请求，保留原文、来源和已有待办。 */
export async function migrateV5(
  tx: IDBPTransaction<RoleplayDB, StoreNames<RoleplayDB>[], "versionchange">,
) {
  const sessions = tx.objectStore("sessions");
  for (const session of await sessions.getAll())
    await sessions.put({ ...session, summary: emptySummary() });
  const messages = tx.objectStore("messages");
  const rows = await messages.getAll();
  for (const message of rows)
    if (message.role === "assistant")
      await messages.put({ ...message, usage: unknownUsage() });
  const tasks = tx.objectStore("stateTasks");
  for (const task of await tasks.getAll()) {
    const assistant = rows.find((m) => m.id === task.assistantMessageId);
    const user = rows.find((m) => m.id === assistant?.replyToMessageId);
    if (!user) throw new Error("升级失败：待整理任务缺少本轮用户消息。");
    const legacy = task.context as unknown as ChatContext & {
      earlierHistory: string;
    };
    const { earlierHistory, ...context } = legacy;
    void earlierHistory;
    await tasks.put({
      ...task,
      context: {
        ...context,
        summary: emptySummary(),
        history: historyMessages(
          rows
            .filter((m) => m.sessionId === task.sessionId && m.seq < user.seq)
            .sort((a, b) => a.seq - b.seq),
        ),
      },
    });
  }
}
