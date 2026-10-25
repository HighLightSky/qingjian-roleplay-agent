import { assertImageId } from "../images/ids";
import type { VisualSource } from "../images/types";
import {
  GOAL_LABELS,
  STORY_LABELS,
  STORY_TEXT_FIELDS,
  type Story,
  type MemoryValue,
  type GoalValue,
  type StateSnapshot,
  type StateResult,
} from "./types";

export function object(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("领域数据必须是对象。");
}
export function string(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is string {
  if (typeof value !== "string" || value.length > max)
    throw new Error("文字字段缺失或过长。");
}
export function date(value: unknown) {
  string(value, 100);
  if (!Number.isFinite(Date.parse(value))) throw new Error("领域时间无效。");
}
export function integer(value: unknown, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min)
    throw new Error("领域序号或版本无效。");
}
function text(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  string(value, max);
  if (!value.trim()) throw new Error("必需文字不能为空。");
}
function choice(value: unknown, options: string[]) {
  if (typeof value !== "string" || !options.includes(value))
    throw new Error("领域类型或状态无效。");
}
export function array(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("领域列表缺失或数量超限。");
}
function strings(value: unknown, max = 10000, chars = Number.MAX_SAFE_INTEGER) {
  array(value, max);
  value.forEach((v) => text(v, chars));
}
export function sourceIds(value: unknown) {
  strings(value, 10000, 200);
  if (new Set(value as string[]).size !== (value as string[]).length)
    throw new Error("来源 ID 重复。");
}
export function validateStory(value: unknown): asserts value is Story {
  object(value);
  for (const key of STORY_TEXT_FIELDS) string(value[key]);
  for (const key of [
    "presentCharacters",
    "relationships",
    "items",
    "openThreads",
  ])
    strings(value[key]);
}
export function validateMemoryValue(
  value: unknown,
): asserts value is MemoryValue {
  object(value);
  text(value.content);
  choice(value.scope, ["session", "character"]);
  choice(value.kind, ["preference", "fact", "agreement", "event"]);
  choice(value.epistemicStatus, ["established", "claim", "hypothesis"]);
  choice(value.status, ["active", "superseded", "dismissed"]);
}
export function validateGoalValue(value: unknown): asserts value is GoalValue {
  object(value);
  text(value.description);
  choice(value.status, Object.keys(GOAL_LABELS));
  string(value.currentFocus);
  string(value.progressSummary);
}
export function validateSnapshot(
  value: unknown,
): asserts value is StateSnapshot {
  object(value);
  text(value.sessionId, 200);
  text(value.characterId, 200);
  integer(value.sessionVersion);
  integer(value.memoryVersion);
  validateStory(value.story);
  object(value.visualState);
  string(value.visualState.outfit);
  string(value.visualState.hairstyle);
  strings(value.visualState.accessories);
  strings(value.visualState.appearanceChanges);
  object(value.visualSources);
  for (const [key, source] of Object.entries(value.visualSources)) {
    choice(key, ["outfit", "hairstyle", "accessories", "appearanceChanges"]);
    object(source);
    choice(source.origin, ["manual", "automatic"]);
    date(source.updatedAt);
    sourceIds(source.sourceMessageIds);
  }
  object(value.storySources);
  for (const [key, source] of Object.entries(value.storySources)) {
    choice(key, Object.keys(STORY_LABELS));
    object(source);
    choice(source.origin, ["manual", "automatic"]);
    date(source.updatedAt);
    sourceIds(source.sourceMessageIds);
  }
  array(value.memories, 10000);
  array(value.goals, 10000);
  const ids = new Set<string>();
  for (const m of value.memories) {
    object(m);
    text(m.id, 200);
    integer(m.version, 1);
    date(m.updatedAt);
    choice(m.origin, ["manual", "automatic"]);
    validateMemoryValue(m.value);
    sourceIds(m.sourceMessageIds);
    text(m.sourceSessionId, 200);
    if (
      ids.has(m.id as string) ||
      m.characterId !== value.characterId ||
      (m.value.scope === "session"
        ? m.sessionId !== value.sessionId
        : m.sessionId !== null)
    )
      throw new Error("记忆范围或 ID 无效。");
    ids.add(m.id as string);
  }
  ids.clear();
  for (const g of value.goals) {
    object(g);
    text(g.id, 200);
    integer(g.version, 1);
    date(g.updatedAt);
    choice(g.origin, ["manual", "automatic"]);
    validateGoalValue(g.value);
    sourceIds(g.sourceMessageIds);
    if (ids.has(g.id as string) || g.sessionId !== value.sessionId)
      throw new Error("目标范围或 ID 无效。");
    ids.add(g.id as string);
  }
}
export function validateStateResult(
  value: unknown,
): asserts value is StateResult {
  object(value);
  text(value.operationId, 200);
  integer(value.sessionVersion);
  integer(value.memoryVersion);
  integer(value.fromExclusiveSeq);
  integer(value.throughSeq, 1);
  if (value.throughSeq <= value.fromExclusiveSeq)
    throw new Error("整理消息范围无效。");
  for (const [field, max] of [
    ["storyChanges", Object.keys(STORY_LABELS).length],
    ["memoryChanges", 10000],
    ["goalChanges", 10000],
    ["visualChanges", 4],
  ] as const) {
    const changes = value[field];
    array(changes, max);
    const ids = new Set<string>();
    for (const c of changes) {
      object(c);
      text(c.id, 200);
      integer(c.expectedVersion);
      choice(c.action, ["create", "update"]);
      text(c.reason);
      sourceIds(c.sourceMessageIds);
      if (!(c.sourceMessageIds as string[]).length || ids.has(c.id as string))
        throw new Error("变更来源为空或目标重复。");
      ids.add(c.id as string);
      if (
        c.action === "create" &&
        (c.expectedVersion !== 0 || c.before !== null)
      )
        throw new Error("新增领域项的版本或原值无效。");
      if (
        c.action === "update" &&
        (c.before === null ||
          (!["storyChanges", "visualChanges"].includes(field) &&
            c.expectedVersion === 0))
      )
        throw new Error("修改领域项的版本或原值无效。");
      const check = (v: unknown) => {
        if (field === "memoryChanges") validateMemoryValue(v);
        else if (field === "goalChanges") validateGoalValue(v);
        else {
          choice(
            c.id,
            field === "visualChanges"
              ? ["outfit", "hairstyle", "accessories", "appearanceChanges"]
              : Object.keys(STORY_LABELS),
          );
          if (
            [...STORY_TEXT_FIELDS, "outfit", "hairstyle"].includes(
              c.id as string,
            )
          )
            string(v);
          else strings(v);
        }
      };
      check(c.value);
      if (c.before !== null) check(c.before);
      if (
        ["storyChanges", "visualChanges"].includes(field) &&
        c.action !== "update"
      )
        throw new Error("剧情只能更新已有字段。");
    }
  }
  array(value.visualObservations, 10000);
  for (const o of value.visualObservations) {
    object(o);
    assertImageId(o.assetId);
    text(o.summary, 600);
    integer(o.version, 1);
    validateVisualSources(o.sources);
    for (const key of ["visibleDetails", "extractedText", "uncertainDetails"])
      strings(o[key]);
  }
}

export function validateVisualSources(
  value: unknown,
): asserts value is VisualSource[] {
  array(value, 10000);
  if (!value.length) throw new Error("视觉记录缺少真实来源。");
  const keys = new Set<string>();
  for (const source of value) {
    object(source);
    if (source.type === "message") {
      string(source.messageId, 200);
      if (!source.messageId) throw new Error("视觉消息来源 ID 不能为空。");
      integer(source.seq, 1);
      integer(source.imageIndex, 1);
      integer(source.uploadIndex, 1);
      string(source.text);
    } else if (source.type === "character_photo") {
      string(source.characterId, 200);
      if (!source.characterId) throw new Error("角色照片来源 ID 不能为空。");
      integer(source.profileVersion, 1);
    } else if (source.type === "scene_generation") {
      string(source.generationId, 200);
      string(source.planId, 200);
      object(source.target);
      Object.values(source.target).forEach((v) => string(v));
      string(source.messageId, 200);
      string(source.sceneId, 200);
      integer(source.seq, 1);
      string(source.summary);
      if (typeof source.rejected !== "boolean")
        throw new Error("生成来源有效性缺失。");
    } else throw new Error("视觉来源类型无效。");
    const key =
      source.type === "message"
        ? `message:${source.messageId}:${source.imageIndex}`
        : source.type === "scene_generation"
          ? `generation:${source.generationId}`
          : "character_photo";
    if (keys.has(key)) throw new Error("视觉来源重复。");
    keys.add(key);
  }
}
