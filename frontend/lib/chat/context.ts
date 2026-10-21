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
import type { Goal, StateSnapshot } from "../state/types";

function historyText(message: Message): string {
  const text =
    message.role === "user"
      ? plainText(message)
      : message
          .segments!.flatMap((segment) =>
            segment.text
              .split(/\r?\n/)
              .filter((line) => line.trim())
              .map(
                (line) =>
                  `[${segment.kind === "dialogue" ? "台词" : "描写"}]${line}`,
              ),
          )
          .join("\n");
  return (
    text + (message.status === "complete" ? "" : "\n[描写]（该回复未完成。）")
  );
}
export function stateSnapshot(
  character: Character,
  session: Session,
  memories: Memory[],
  goals: Goal[],
): StateSnapshot {
  return {
    sessionId: session.id,
    characterId: character.id,
    sessionVersion: session.stateVersion,
    memoryVersion: character.memoryVersion,
    processedThroughSeq: session.stateProcessedThroughSeq,
    story: session.story,
    storySources: session.storySources,
    memories: memories
      .filter(
        (m) =>
          m.characterId === character.id &&
          (m.sessionId === null || m.sessionId === session.id),
      )
      .map(({ createdAt, ...m }) => m),
    goals: goals.map(({ createdAt, ...g }) => g),
  };
}
export function chatContext(
  character: Character,
  session: Session,
  memories: Memory[],
  messages: Message[],
  input: string,
  interactionSettings: InteractionSettings,
  parts?: ContentPart[],
  goals: Goal[] = [],
  operationId = `chat:${session.id}`,
) {
  const history = messages
    .filter(
      (m) =>
        !["pending", "streaming"].includes(m.status) &&
        (plainText(m) || imageIds(m.parts).length),
    )
    .map((m) => ({
      role: m.role,
      id: m.id,
      parts: m.parts,
      text: historyText(m),
    }));
  const earlierHistory = history
    .slice(0, -20)
    .map((m) => `${m.role === "user" ? "用户" : character.name}：${m.text}`)
    .join("\n");
  if (earlierHistory.length > 20_000)
    throw new Error("较早原文已超过本轮上下文字符预算，本版尚未支持自动压缩。");
  return {
    character: session.characterSnapshot,
    state: stateSnapshot(character, session, memories, goals),
    earlierHistory,
    history: history.slice(-20),
    input: { text: input, ...(parts ? { parts } : {}) },
    interactionSettings: { ...interactionSettings },
    operationId,
  };
}
export type ChatContext = ReturnType<typeof chatContext> & {
  visual?: VisualContext;
};
