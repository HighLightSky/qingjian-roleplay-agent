import type { ContentPart, VisualContext } from "../images/types";
import { imageIds } from "../images/types";
import {
  plainText,
  type Character,
  type Memory,
  type Message,
  type Session,
  type InteractionSettings,
} from "../domain";

export function chatContext(
  character: Character,
  session: Session,
  memories: Memory[],
  messages: Message[],
  input: string,
  interactionSettings: InteractionSettings,
  parts?: ContentPart[],
) {
  const history = messages
    .filter(
      (message) =>
        !["pending", "streaming"].includes(message.status) &&
        (plainText(message) || imageIds(message.parts).length > 0),
    )
    .map((message) => ({
      role: message.role,
      seq: message.seq,
      id: message.id,
      parts: message.parts,
      text:
        plainText(message) +
        (message.status === "complete" ? "" : "\n（该回复未完成。）"),
    }));
  const recent = history.slice(-20);
  const firstRecent = recent[0]?.seq ?? Number.MAX_SAFE_INTEGER;
  const earlier = history.filter(
    (message) =>
      message.seq < firstRecent && message.seq > session.summaryThroughSeq,
  );
  const raw = earlier
    .map(
      (message) =>
        `${message.role === "user" ? "用户" : character.name}：${message.text}`,
    )
    .join("\n");
  if (raw.length > 20_000)
    throw new Error(
      "较早记录已超过本轮上下文预算。请在会话菜单的「整理剧情」中写下要保留的剧情，再继续聊天。原始记录不会删除。",
    );
  return {
    character: session.characterSnapshot,
    memories: memories
      .filter((memory) => memory.characterId === character.id)
      .map((memory) => memory.content),
    summary: [
      character.sharedSummary &&
        `【角色共享经历（用户维护）】\n${character.sharedSummary}`,
      session.summary && `【当前会话剧情（用户维护）】\n${session.summary}`,
      raw && `【较早聊天原文，尚未摘要】\n${raw}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    history: recent.map(({ role, text, id, parts }) => ({
      role,
      text,
      ...(parts ? { id, parts } : {}),
    })),
    input: { text: input, image: null, ...(parts ? { parts } : {}) },
    interactionSettings: { ...interactionSettings },
  };
}

export type ChatContext = ReturnType<typeof chatContext> & {
  visual?: VisualContext;
};
