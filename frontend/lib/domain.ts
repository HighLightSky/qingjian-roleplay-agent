import { assertImageId } from "./images/ids";
import type { ContentPart } from "./images/types";
import type { Story, StorySources } from "./state/types";
import type { HistorySummary, TokenUsage } from "./context/types";
export type { Memory } from "./state/types";

export type CharacterProfile = {
  name: string;
  identity: string;
  description: string;
  appearancePhotoAssetId?: string;
};
export function parseCharacterProfile(
  value: unknown,
  allowEmptyName = false,
): CharacterProfile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("角色资料无效。");
  const profile = value as Record<string, unknown>;
  const labels = {
    name: "角色名称",
    identity: "角色身份",
    description: "角色描述",
  };
  for (const field of ["name", "identity", "description"] as const) {
    if (typeof profile[field] !== "string")
      throw new Error(`${labels[field]}必须是字符串，无内容时请填空字符串。`);
  }
  if (profile.appearancePhotoAssetId !== undefined)
    assertImageId(profile.appearancePhotoAssetId);
  const name = (profile.name as string).trim();
  if (!allowEmptyName && !name) throw new Error("请填写角色名称。");
  return {
    name: allowEmptyName ? (profile.name as string) : name,
    identity: profile.identity as string,
    description: profile.description as string,
    ...(profile.appearancePhotoAssetId !== undefined
      ? { appearancePhotoAssetId: profile.appearancePhotoAssetId as string }
      : {}),
  };
}
export type Character = CharacterProfile & {
  id: string;
  archived: boolean;
  profileVersion: number;
  memoryVersion: number;
  createdAt: string;
  updatedAt: string;
};
export type Session = {
  summary: HistorySummary;
  id: string;
  characterId: string;
  title: string;
  titleSource: "default" | "first-message" | "manual";
  characterSnapshot: CharacterProfile;
  profileVersion: number;
  story: Story;
  storySources: StorySources;
  visualState: import("./scene-images/types").VisualState;
  visualSources: import("./scene-images/types").VisualSources;
  stateVersion: number;
  nextMessageSeq: number;
  createdAt: string;
  updatedAt: string;
};
export type Segment = { kind: "dialogue" | "narration"; text: string };
export type ReasoningTrace = {
  text: string;
  status: "streaming" | "complete" | "cancelled" | "error";
  startedAt: number;
  endedAt: number | null;
};
export function finishReasoning(
  reasoning: ReasoningTrace | undefined,
  status: "cancelled" | "error",
): ReasoningTrace | undefined {
  return reasoning?.status === "streaming"
    ? { ...reasoning, status, endedAt: Date.now() }
    : reasoning;
}
export type Message = {
  reasoning?: ReasoningTrace;
  usage?: TokenUsage;
  id: string;
  sessionId: string;
  seq: number;
  role: "user" | "assistant";
  text?: string;
  parts?: ContentPart[];
  segments?: Segment[];
  status:
    | "pending"
    | "streaming"
    | "complete"
    | "cancelled"
    | "error"
    | "interrupted";
  finishReason?: string;
  error?: string;
  replyToMessageId?: string;
  checkpointVersion: number;
  createdAt: string;
  updatedAt: string;
};
export type EditDraft = {
  userMessageId: string;
  assistantMessageId: string;
  userCheckpointVersion: number;
  assistantCheckpointVersion: number;
  text: string;
  parts?: ContentPart[];
};
export type Draft = {
  edit?: EditDraft;
  sessionId: string;
  text: string;
  parts?: ContentPart[];
  updatedAt: string;
};
export type ThemeMode = "system" | "light" | "dark";
export type Setting = { key: string; value: string };
export type ReplyLength = "short" | "standard" | "detailed";
export type NarrativeMode = "interactive" | "scene";
export type InteractionSettings = {
  replyLength: ReplyLength;
  narrativeMode: NarrativeMode;
};
export const DEFAULT_INTERACTION_SETTINGS: Readonly<InteractionSettings> =
  Object.freeze({
    replyLength: "standard",
    narrativeMode: "scene",
  });
export const REPLY_LENGTH_OPTIONS = [
  { value: "short", label: "简短", description: "约 300-600 字" },
  { value: "standard", label: "标准", description: "约 600—1200 字" },
  { value: "detailed", label: "详细", description: "约 2000—3000 字" },
] as const;
export const NARRATIVE_MODE_OPTIONS = [
  {
    value: "interactive",
    label: "频繁互动",
    description: "较早停在自然互动点",
  },
  { value: "scene", label: "场景推进", description: "展开完整的场景片段" },
] as const;
export function parseInteractionSettings(value: unknown): InteractionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("交互设置无效。");
  const settings = value as Record<string, unknown>;
  if (
    !REPLY_LENGTH_OPTIONS.some(
      (option) => option.value === settings.replyLength,
    )
  )
    throw new Error("回复长度设置无效。");
  if (
    !NARRATIVE_MODE_OPTIONS.some(
      (option) => option.value === settings.narrativeMode,
    )
  )
    throw new Error("叙事推进设置无效。");
  return {
    replyLength: settings.replyLength as ReplyLength,
    narrativeMode: settings.narrativeMode as NarrativeMode,
  };
}
export const EMPTY_PROFILE: CharacterProfile = {
  name: "",
  identity: "",
  description: "",
};
export const now = () => new Date().toISOString();
export function id(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID requires HTTPS or localhost. getRandomValues also works when
  // the local application is opened over HTTP on a LAN IP address.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function profileOf(character: Character): CharacterProfile {
  return {
    name: character.name,
    identity: character.identity,
    description: character.description,
    ...(character.appearancePhotoAssetId
      ? { appearancePhotoAssetId: character.appearancePhotoAssetId }
      : {}),
  };
}
export function plainText(message: Message): string {
  return message.role === "user"
    ? (message.text ?? "")
    : (message.segments ?? []).map((segment) => segment.text).join("\n");
}
export function visibleCharacters(text: string): string[] {
  return Array.from(
    new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(text),
    (item) => item.segment,
  );
}
export function titleFrom(text: string): string {
  const chars = visibleCharacters(text.trim().replace(/\s+/g, " "));
  return chars.slice(0, 20).join("") + (chars.length > 20 ? "…" : "");
}
export function appendDelta(message: Message, delta: Segment): Message {
  const segments = [...(message.segments ?? [])];
  const last = segments.at(-1);
  if (last?.kind === delta.kind)
    segments[segments.length - 1] = { ...last, text: last.text + delta.text };
  else segments.push({ ...delta });
  return {
    ...message,
    segments,
    status: "streaming",
    updatedAt: now(),
    checkpointVersion: message.checkpointVersion + 1,
  };
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}
