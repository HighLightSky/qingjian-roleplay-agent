import type { ChatContext } from "../chat/context";

export type HistorySummary = {
  text: string;
  throughSeq: number;
  version: number;
};
export const emptySummary = (): HistorySummary => ({
  text: "",
  throughSeq: 0,
  version: 0,
});
export type TokenUsage =
  | {
      status: "reported";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
  | {
      status: "unavailable";
      inputTokens: null;
      outputTokens: null;
      totalTokens: null;
    };
export const unknownUsage = (): TokenUsage => ({
  status: "unavailable",
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
});
export type ContextBudget = {
  inputTokens: number;
  contextWindowTokens: number;
  usageRatio: number;
  outputReserveTokens: number;
  safetyTokens: number;
  accuracy: "exact" | "estimated";
  needsCompaction: boolean;
  fits: boolean;
  requestFingerprint: string;
  compactThroughSeq: number;
};
export type CompactionResult = {
  operationId: string;
  sessionId: string;
  baseSessionVersion: number;
  baseMemoryVersion: number;
  baseSummaryVersion: number;
  fromExclusiveSeq: number;
  throughSeq: number;
  summary: HistorySummary;
  beforeTokens: number;
  afterTokens: number;
  sourceMessageIds: string[];
  sourceFingerprint: string;
};
export type CompactionTask = {
  id: string;
  sessionId: string;
  assistantMessageId: string;
  context: ChatContext;
  automaticAttempts: number;
  createdAt: string;
  updatedAt: string;
};
