import { emptyVisualState } from "./types";

/** 只在旧数据入口使用，运行时不保留旧协议。 */
export function upgradeV8Record(
  table: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const row = { ...value };
  if (table === "assets") row.creationOrigin = "uploaded";
  if (table === "sessions") {
    row.visualState = emptyVisualState();
    row.visualSources = {};
  }
  if (table === "stateTasks" || table === "compactionTasks") {
    const context = row.context as Record<string, unknown>;
    row.context = {
      ...context,
      state: {
        ...(context.state as object),
        visualState: emptyVisualState(),
        visualSources: {},
      },
    };
  }
  if (table === "operations") {
    if (row.kind === "state_update" && row.result)
      row.result = { ...(row.result as object), visualChanges: [] };
    if (
      row.status === "running" ||
      (row.kind === "selection" && row.status === "pending")
    ) {
      row.status = "cancelled";
      row.error = "版本升级中断了旧请求，保留已保存内容，可手动重试。";
    }
  }
  if (
    table === "messages" &&
    ["pending", "streaming"].includes(row.status as string)
  ) {
    row.status = "error";
    row.error = "版本升级中断了旧请求，保留已收到正文。";
  }
  return row;
}

export function convertV9Backup(value: Record<string, unknown>) {
  const data = value.data as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("旧备份数据缺失。");
  const converted: Record<string, unknown> = {};
  for (const [table, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) throw new Error(`旧备份的 ${table} 数据无效。`);
    converted[table] = rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error("旧备份记录无效。");
      return upgradeV8Record(table, row);
    });
  }
  converted.sceneImagePlans = [];
  converted.sceneGenerations = [];
  return { ...value, formatVersion: 10, data: converted };
}
