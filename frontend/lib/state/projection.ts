import type { Message } from "../domain";
import type { Operation } from "./types";

export type RuntimeEntry = Message | Operation;
/** 过程仅在渲染时插入，不写回故事消息，也不影响故事序号。 */
export function projectMessages(
  messages: Message[],
  operations: Operation[],
): RuntimeEntry[] {
  const result: RuntimeEntry[] = [];
  for (const message of messages) {
    const anchored = operations.filter((o) => o.anchorMessageId === message.id);
    result.push(
      ...anchored
        .filter((o) => o.placement === "before")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
    result.push(message);
    result.push(
      ...anchored
        .filter((o) => o.placement === "after")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  }
  return result;
}
