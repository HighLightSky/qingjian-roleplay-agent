import type { ChatContext } from "../chat/context";
import type { Observation, ImagePlan, CatalogAsset } from "../images/types";

export const EMPTY_STORY = {
  location: "",
  storyTime: "",
  characterState: "",
  userState: "",
  presentCharacters: [] as string[],
  relationships: [] as string[],
  items: [] as string[],
  openThreads: [] as string[],
};
export type Story = typeof EMPTY_STORY;
export const STORY_TEXT_FIELDS = [
  "location",
  "storyTime",
  "characterState",
  "userState",
];
export type StorySources = Partial<
  Record<
    keyof Story,
    {
      origin: "manual" | "automatic";
      updatedAt: string;
      sourceMessageIds: string[];
    }
  >
>;
export const STORY_LABELS: Record<keyof Story, string> = {
  location: "地点",
  storyTime: "故事时间",
  characterState: "角色状态",
  userState: "我的状态",
  presentCharacters: "在场人物",
  relationships: "人物关系",
  items: "物品状态",
  openThreads: "未解决线索",
};
export type MemoryValue = {
  content: string;
  scope: "character" | "session";
  kind: "preference" | "fact" | "agreement" | "event";
  epistemicStatus: "established" | "claim" | "hypothesis";
  status: "active" | "superseded" | "dismissed";
};
export type Memory = {
  id: string;
  characterId: string;
  sessionId: string | null;
  value: MemoryValue;
  version: number;
  origin: "manual" | "automatic";
  sourceSessionId: string;
  sourceMessageIds: string[];
  createdAt: string;
  updatedAt: string;
};
export const GOAL_LABELS = {
  candidate: "待确认",
  active: "进行中",
  blocked: "受阻",
  paused: "暂停",
  completed: "已完成",
  abandoned: "已放弃",
  dismissed: "已删除",
};
export type GoalValue = {
  description: string;
  status: keyof typeof GOAL_LABELS;
  currentFocus: string;
  progressSummary: string;
};
export type Goal = {
  id: string;
  sessionId: string;
  value: GoalValue;
  version: number;
  origin: "manual" | "automatic";
  sourceMessageIds: string[];
  createdAt: string;
  updatedAt: string;
};
export type StateSnapshot = {
  sessionId: string;
  characterId: string;
  sessionVersion: number;
  memoryVersion: number;
  story: Story;
  storySources: StorySources;
  visualState: import("../scene-images/types").VisualState;
  visualSources: import("../scene-images/types").VisualSources;
  memories: Omit<Memory, "createdAt">[];
  goals: Omit<Goal, "createdAt">[];
};
export type SourceMessage = {
  id: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  status: "complete";
  createdAt: string;
};
export type Change<T> = {
  action: "create" | "update";
  id: string;
  expectedVersion: number;
  before: T | null;
  value: T;
  reason: string;
  sourceMessageIds: string[];
};
export type StateResult = {
  operationId: string;
  sessionVersion: number;
  memoryVersion: number;
  fromExclusiveSeq: number;
  throughSeq: number;
  visualObservations: Observation[];
  storyChanges: Change<Story[keyof Story]>[];
  visualChanges: Change<string | string[]>[];
  memoryChanges: Change<MemoryValue>[];
  goalChanges: Change<GoalValue>[];
};
export type SelectionResult = { plan: ImagePlan; catalog: CatalogAsset[] };
export type Operation = {
  id: string;
  sessionId: string;
  runId: string;
  anchorMessageId: string;
  placement: "before" | "after";
  kind: "selection" | "state_update" | "compaction";
  status:
    | "pending"
    | "running"
    | "computed"
    | "committed"
    | "failed"
    | "cancelled"
    | "stale";
  result?:
    StateResult | SelectionResult | import("../context/types").CompactionResult;
  sourceVersions?: { id: string; checkpointVersion: number }[];
  error?: string;
  createdAt: string;
  updatedAt: string;
};
export type StateTask = {
  id: string;
  sessionId: string;
  assistantMessageId: string;
  throughSeq: number;
  context: ChatContext;
  createdAt: string;
  updatedAt: string;
};
