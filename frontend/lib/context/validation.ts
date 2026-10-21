import { object, string, integer, array } from "../state/validation";
import type {
  ContextBudget,
  CompactionResult,
  HistorySummary,
  TokenUsage,
} from "./types";

export function validateSummary(
  value: unknown,
): asserts value is HistorySummary {
  object(value);
  string(value.text, 2_000_000);
  integer(value.throughSeq);
  integer(value.version);
  if (
    value.throughSeq === 0
      ? value.text !== "" || value.version !== 0
      : !value.text.trim() || !value.version
  )
    throw new Error("摘要正文、覆盖范围或版本无效。");
}
export function validateUsage(value: unknown): asserts value is TokenUsage {
  object(value);
  if (value.status === "unavailable") {
    if (
      [value.inputTokens, value.outputTokens, value.totalTokens].some(
        (v) => v !== null,
      )
    )
      throw new Error("未知用量不能包含伪造计数。");
  } else if (value.status === "reported") {
    integer(value.inputTokens);
    integer(value.outputTokens);
    integer(value.totalTokens);
    if (
      (value.inputTokens as number) + (value.outputTokens as number) !==
      value.totalTokens
    )
      throw new Error("用量总数与输入输出不一致。");
  } else throw new Error("用量状态无效。");
}
export function validateBudget(value: unknown): asserts value is ContextBudget {
  object(value);
  for (const field of ["inputTokens", "safetyTokens", "compactThroughSeq"])
    integer(value[field]);
  integer(value.contextWindowTokens, 1);
  integer(value.outputReserveTokens, 1);
  string(value.requestFingerprint, 200);
  if (
    !["exact", "estimated"].includes(value.accuracy as string) ||
    typeof value.needsCompaction !== "boolean" ||
    typeof value.fits !== "boolean" ||
    typeof value.usageRatio !== "number" ||
    !Number.isFinite(value.usageRatio) ||
    Math.abs(
      value.usageRatio -
        (value.inputTokens as number) / (value.contextWindowTokens as number),
    ) > 1e-10
  )
    throw new Error("上下文预算数据无效。");
}
export function validateCompaction(
  value: unknown,
): asserts value is CompactionResult {
  object(value);
  for (const field of ["operationId", "sessionId", "sourceFingerprint"])
    string(value[field], 200);
  for (const field of [
    "baseSessionVersion",
    "baseMemoryVersion",
    "baseSummaryVersion",
    "fromExclusiveSeq",
    "throughSeq",
    "beforeTokens",
    "afterTokens",
  ])
    integer(value[field]);
  validateSummary(value.summary);
  array(value.sourceMessageIds, 2000);
  for (const id of value.sourceMessageIds) string(id, 200);
  if (
    (value.throughSeq as number) <= (value.fromExclusiveSeq as number) ||
    value.summary.throughSeq !== value.throughSeq ||
    value.summary.version !== (value.baseSummaryVersion as number) + 1 ||
    (value.afterTokens as number) >= (value.beforeTokens as number) ||
    !value.sourceMessageIds.length ||
    new Set(value.sourceMessageIds).size !== value.sourceMessageIds.length
  )
    throw new Error("压缩结果覆盖范围、版本或减量无效。");
}
