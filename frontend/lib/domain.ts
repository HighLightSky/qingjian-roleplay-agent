export type CharacterProfile = {
  name: string;
  description: string;
  personality: string;
  speakingStyle: string;
  worldSetting: string;
  openingScene: string;
};
export type Character = CharacterProfile & {
  id: string;
  archived: boolean;
  profileVersion: number;
  sharedSummary: string;
  createdAt: string;
  updatedAt: string;
};
export type Session = {
  id: string;
  characterId: string;
  title: string;
  titleSource: "default" | "first-message" | "manual";
  characterSnapshot: CharacterProfile;
  profileVersion: number;
  summary: string;
  summaryThroughSeq: number;
  nextMessageSeq: number;
  createdAt: string;
  updatedAt: string;
};
export type Segment = { kind: "dialogue" | "narration"; text: string };
export type Message = {
  id: string;
  sessionId: string;
  seq: number;
  role: "user" | "assistant";
  text?: string;
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
export type Memory = {
  id: string;
  characterId: string;
  content: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  createdAt: string;
  updatedAt: string;
};
export type Draft = { sessionId: string; text: string; updatedAt: string };
export type ThemeMode = "system" | "light" | "dark";
export type Setting = { key: string; value: string };
export const EMPTY_PROFILE: CharacterProfile = {
  name: "",
  description: "",
  personality: "",
  speakingStyle: "",
  worldSetting: "",
  openingScene: "",
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
  return Object.fromEntries(
    Object.keys(EMPTY_PROFILE).map((key) => [
      key,
      character[key as keyof CharacterProfile],
    ]),
  ) as CharacterProfile;
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
