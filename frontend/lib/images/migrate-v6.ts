import type { IDBPTransaction } from "idb";
import type { RoleplayDB, TABLES } from "../db";
import { imageIds } from "./types";
import { plainText } from "../domain";

/** 旧消息来源一次性升级，运行时仅使用联合来源协议。 */
export async function migrateV6(
  tx: IDBPTransaction<RoleplayDB, typeof TABLES, "versionchange">,
) {
  const messages = (await tx.objectStore("messages").getAll()).sort(
    (a, b) => a.seq - b.seq,
  );
  function sources(sessionId: string, assetId: string) {
    let uploadIndex = 0;
    return messages
      .filter((m) => m.sessionId === sessionId && m.role === "user")
      .flatMap((m) =>
        imageIds(m.parts).flatMap((id, index) => {
          uploadIndex++;
          return id === assetId
            ? [
                {
                  type: "message",
                  messageId: m.id,
                  seq: m.seq,
                  text: plainText(m),
                  imageIndex: index + 1,
                  uploadIndex,
                },
              ]
            : [];
        }),
      );
  }
  function observation(
    value: Record<string, any>,
    sessionId: string,
    available = sources(sessionId, value.assetId),
  ) {
    delete value.sourceMessageIds;
    value.sources = available;
  }
  function catalog(items: Record<string, any>[], sessionId: string) {
    for (const item of items) {
      item.sources = item.sources.map((s: object) => ({
        type: "message",
        ...s,
      }));
      if (item.observation)
        observation(item.observation, sessionId, item.sources);
    }
  }
  for (const row of await tx.objectStore("visualObservations").getAll()) {
    observation(row, row.sessionId);
    await tx.objectStore("visualObservations").put(row);
  }
  for (const table of ["stateTasks", "compactionTasks"] as const) {
    for (const row of await tx.objectStore(table).getAll()) {
      const session = await tx.objectStore("sessions").get(row.sessionId);
      if (!session) throw new Error("旧视觉任务缺少会话快照，无法升级。");
      if (!row.context.character)
        throw new Error("旧视觉任务缺少角色快照，无法升级。");
      row.context.character.profileVersion = session.profileVersion;
      if (row.context.visual)
        catalog(row.context.visual.assetCatalog, row.sessionId);
      await tx.objectStore(table).put(row);
    }
  }
  for (const row of await tx.objectStore("operations").getAll()) {
    const result = row.result as Record<string, any> | undefined;
    if (row.kind === "selection" && result)
      catalog(result.catalog, row.sessionId);
    if (row.kind === "state_update" && result)
      for (const item of result.visualObservations)
        observation(item, row.sessionId);
    await tx.objectStore("operations").put(row);
  }
}
