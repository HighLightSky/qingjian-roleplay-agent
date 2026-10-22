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

export function historyText(message: Message): string {
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
  const history = historyMessages(
    messages.filter((m) => m.seq > session.summary.throughSeq),
  );
  return {
    character: {
      ...session.characterSnapshot,
      profileVersion: session.profileVersion,
    },
    state: stateSnapshot(character, session, memories, goals),
    summary: { ...session.summary },
    history,
    input: { text: input, ...(parts ? { parts } : {}) },
    interactionSettings: { ...interactionSettings },
    operationId,
  };
}

export function historyMessages(messages: Message[]) {
  return messages
    .filter(
      (m) =>
        !["pending", "streaming"].includes(m.status) &&
        (plainText(m) || imageIds(m.parts).length),
    )
    .map((m) => ({
      role: m.role,
      id: m.id,
      seq: m.seq,
      status: m.status,
      checkpointVersion: m.checkpointVersion,
      parts: m.parts,
      text: historyText(m),
    }));
}
export type ChatContext = ReturnType<typeof chatContext> & {
  visual?: VisualContext;
};
