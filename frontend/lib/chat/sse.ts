import type { Segment } from "../domain";
import type { ContextBudget, TokenUsage } from "../context/types";
import { validateBudget, validateUsage } from "../context/validation";

type Event = { name: string; data: string };
/** Incremental SSE lines: CR, LF and CRLF may themselves cross network chunks. */
export class SSEParser {
  private line = "";
  private afterCR = false;
  private name = "";
  private data: string[] = [];
  private size = 0;
  constructor(private emit: (event: Event) => void) {}
  feed(text: string) {
    for (const char of text) {
      if (this.afterCR) {
        this.afterCR = false;
        if (char === "\n") continue;
      }
      if (char === "\r" || char === "\n") {
        this.consumeLine();
        this.afterCR = char === "\r";
      } else {
        this.line += char;
        if (++this.size > 1_000_000) throw new Error("服务器事件过大。");
      }
    }
  }
  private consumeLine() {
    const line = this.line;
    this.line = "";
    if (!line) {
      if (this.data.length)
        this.emit({ name: this.name || "message", data: this.data.join("\n") });
      this.name = "";
      this.data = [];
      this.size = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.name = value;
    if (field === "data") this.data.push(value);
  }
}
export async function streamChat(
  body: unknown,
  signal: AbortSignal,
  onDelta: (delta: Segment) => void,
  onContext: (budget: ContextBudget) => void,
): Promise<{ finishReason: string; usage: TokenUsage }> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(
      error?.message || `聊天请求失败（HTTP ${response.status}）。`,
    );
  }
  if (
    !response.headers.get("content-type")?.includes("text/event-stream") ||
    !response.body
  )
    throw new Error("服务器未返回聊天事件流。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;
  const parser = new SSEParser((event) => {
    if (finishReason) return;
    if (!["context", "delta", "done", "error"].includes(event.name)) return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      throw new Error("聊天事件格式不正确。");
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("聊天事件格式不正确。");
    if (event.name === "error")
      throw new Error(data.message || "角色回复失败。");
    if (event.name === "context") {
      validateBudget(data);
      onContext(data);
      return;
    }
    if (event.name === "done") {
      if (typeof data.finishReason !== "string" || !data.finishReason)
        throw new Error("回复缺少结束原因。");
      finishReason = data.finishReason;
      validateUsage(data.usage);
      usage = data.usage;
    } else {
      if (
        !["dialogue", "narration"].includes(data.kind) ||
        typeof data.text !== "string"
      )
        throw new Error("回复段落格式不正确。");
      onDelta({ kind: data.kind, text: data.text });
    }
  });
  try {
    while (!finishReason) {
      const { value, done } = await reader.read();
      if (done) {
        parser.feed(decoder.decode());
        break;
      }
      parser.feed(decoder.decode(value, { stream: true }));
    }
    if (!finishReason)
      throw new Error("连接中断，已保留收到的回复。可以继续发送新消息。");
    if (!usage) throw new Error("回复终态缺少用量状态。");
    return { finishReason, usage };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
