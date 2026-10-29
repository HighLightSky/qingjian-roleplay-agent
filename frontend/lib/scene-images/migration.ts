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

/** 仅迁移结构已知的旧业务数据，保留 Blob 和其他非普通对象。 */
function upgradeSources(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(upgradeSources);
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return value;
  const row = Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, upgradeSources(field)]),
  );
  if (row.type === "scene_generation") {
    delete row.sceneId;
    delete row.target;
  }
  return row;
}

export function upgradeV9Data(data: Record<string, unknown[]>) {
  const plans = data.sceneImagePlans as Record<string, unknown>[];
  const assets = data.assets as Record<string, unknown>[];
  const convertReferences = (value: unknown) => {
    const references = new Map<string, Record<string, unknown>>();
    for (const old of value as Record<string, unknown>[]) {
      const roles = (old.roles as string[]).filter((role) => role !== "base");
      const existing = references.get(old.assetId as string);
      references.set(old.assetId as string, {
        ...old,
        roles: [
          ...new Set([...((existing?.roles as string[]) ?? []), ...roles]),
        ],
        scope: existing ? `${existing.scope}；${old.scope}` : old.scope,
      });
    }
    return [...references.values()].sort(
      (a, b) =>
        Number((b.roles as string[]).includes("identity")) -
        Number((a.roles as string[]).includes("identity")),
    );
  };
  const converted: Record<string, unknown[]> = {};
  for (const [table, rows] of Object.entries(data)) {
    converted[table] = rows
      .map((value) => {
        const row = upgradeSources(value) as Record<string, unknown>;
        if (table === "sceneImagePlans") {
          const {
            sceneId,
            previousPlanId,
            continuity,
            target,
            summary,
            fingerprint,
            status,
            ...plan
          } = row;
          return {
            ...plan,
            referenceImages: convertReferences(plan.referenceImages),
          };
        }
        if (table === "sceneGenerations") {
          const { sceneId, ...generation } = row;
          const plan = plans.find((plan) => plan.id === generation.planId);
          if (!plan) throw new Error("旧生成记录缺少来源画面计划。");
          const asset = assets.find((asset) => asset.id === generation.assetId);
          const active = ["pending", "running", "cancelling"].includes(
            generation.status as string,
          );
          return {
            ...generation,
            submission: {
              prompt: plan.prompt,
              effectivePrompt: plan.prompt,
              width: asset ? asset.width : null,
              height: asset ? asset.height : null,
              referenceImages: convertReferences(plan.referenceImages).map(
                (ref) => ({ ...ref, sha256: null }),
              ),
            },
            ...(active
              ? {
                  status: "unknown",
                  acknowledged: true,
                  error: "版本升级中断了旧任务，结果未知，请手动重新生成。",
                }
              : {}),
          };
        }
        if (
          table === "messages" &&
          ["pending", "streaming"].includes(row.status as string)
        )
          return {
            ...row,
            status: "interrupted",
            error: "版本升级中断了旧请求，保留已收到正文。",
          };
        if (
          table === "operations" &&
          ["pending", "running"].includes(row.status as string)
        )
          return {
            ...row,
            status: "cancelled",
            error: "版本升级中断了旧请求，可手动重试。",
          };
        return row;
      })
      .filter(
        (value) =>
          table !== "settings" ||
          !(value as { key: string }).key.startsWith("dispatch:"),
      );
  }
  return converted;
}

export function convertV10Backup(value: Record<string, unknown>) {
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("旧备份数据缺失。");
  for (const rows of Object.values(data))
    if (!Array.isArray(rows)) throw new Error("旧备份数据表无效。");
  return {
    ...value,
    formatVersion: 11,
    data: upgradeV9Data(data as Record<string, unknown[]>),
  };
}

/** v10 的参考用途归并为 scope，旧整理确实没有画面结果时显式保留 null。 */
export function upgradeV10Record(
  table: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const row = { ...value };
  const references = (items: unknown) =>
    (items as Record<string, unknown>[]).map(
      ({ roles, ...reference }) => reference,
    );
  if (table === "sceneImagePlans")
    row.referenceImages = references(row.referenceImages);
  if (table === "sceneGenerations") {
    const submission = row.submission as Record<string, unknown>;
    row.submission = {
      ...submission,
      referenceImages: references(submission.referenceImages),
    };
    if (["pending", "running", "cancelling"].includes(row.status as string)) {
      row.status = "unknown";
      row.acknowledged = true;
      row.error = "版本升级中断了旧任务，结果未知，请手动重新生成。";
    }
  }
  if (table === "operations") {
    if (row.kind === "state_update" && row.result)
      row.result = { ...(row.result as object), scenePlan: null };
    if (["pending", "running"].includes(row.status as string)) {
      row.status = "cancelled";
      row.error = "版本升级中断了旧请求，保留已保存内容，可手动重试。";
    }
  }
  if (
    table === "messages" &&
    ["pending", "streaming"].includes(row.status as string)
  ) {
    row.status = "interrupted";
    row.error = "版本升级中断了旧请求，保留已收到正文。";
  }
  return row;
}

export function convertV11Backup(value: Record<string, unknown>) {
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("旧备份数据缺失。");
  const converted: Record<string, unknown[]> = {};
  for (const [table, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) throw new Error(`旧备份的 ${table} 数据无效。`);
    converted[table] = rows
      .filter((row) => table !== "settings" || !row.key.startsWith("dispatch:"))
      .map((row) => upgradeV10Record(table, row));
  }
  return { ...value, formatVersion: 12, data: converted };
}

/** v11 尚未拆分动作，升级时不能从历史提示词猜测姿势。 */
export function upgradeV11Record(
  table: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const row = { ...value };
  const ordinaryPose = {
    poseEnabled: false,
    poseQuery: null,
    characterReferenceAssetId: null,
    poseSelection: null,
  };
  if (table === "sceneImagePlans") {
    row.poseQuery = null;
    row.characterReferenceAssetId = null;
    if (row.draft)
      row.draft = {
        ...(row.draft as object),
        poseEnabled: false,
        poseQuery: "",
        characterReferenceAssetId: null,
        poseSearch: {
          status: "idle",
          query: null,
          revision: 0,
          matches: [],
          selectedPoseId: null,
          error: null,
        },
      };
  }
  if (table === "sceneGenerations")
    row.submission = { ...(row.submission as object), ...ordinaryPose };
  if (table === "operations" && row.kind === "state_update" && row.result) {
    const result = row.result as Record<string, unknown>;
    if (result.scenePlan)
      row.result = {
        ...result,
        scenePlan: upgradeV11Record(
          "sceneImagePlans",
          result.scenePlan as Record<string, unknown>,
        ),
      };
  }
  return row;
}

export function convertV13Backup(value: Record<string, unknown>) {
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("旧备份数据缺失。");
  const converted: Record<string, unknown[]> = {};
  for (const [table, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) throw new Error(`旧备份的 ${table} 数据无效。`);
    converted[table] = rows.map((row) => upgradeV11Record(table, row));
  }
  return { ...value, formatVersion: 14, data: converted };
}

/** 编辑姿态独立于检索候选；升级时不能重跑会清空姿势状态的旧迁移。 */
export function upgradeV12Record(
  table: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const row = { ...value };
  if (table === "sceneImagePlans" && row.draft)
    row.draft = { ...(row.draft as object), poseEdit: null };
  if (table === "operations" && row.kind === "state_update" && row.result) {
    const result = row.result as Record<string, unknown>;
    if (result.scenePlan)
      row.result = {
        ...result,
        scenePlan: upgradeV12Record(
          "sceneImagePlans",
          result.scenePlan as Record<string, unknown>,
        ),
      };
  }
  return row;
}

export function convertV14Backup(value: Record<string, unknown>) {
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("旧备份数据缺失。");
  const converted: Record<string, unknown[]> = {};
  for (const [table, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) throw new Error(`旧备份的 ${table} 数据无效。`);
    converted[table] = rows.map((row) => upgradeV12Record(table, row));
  }
  return { ...value, formatVersion: 15, data: converted };
}
