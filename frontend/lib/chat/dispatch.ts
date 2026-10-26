import type { Segment, ReasoningTrace } from "../domain";
import type { ChatContext } from "./context";
import type { ContextBudget, TokenUsage } from "../context/types";
import type { ImagePlan } from "../images/types";
import type { StateResult } from "../state/types";
import { SSEParser } from "./sse";

export type DispatchStage = {
  name: string;
  status: "running" | "committed" | "failed" | "cancelled";
  error: string | null;
  plan?: ImagePlan | null;
};
export type DispatchSnapshot = {
  runId: string;
  revision: number;
  segments: Segment[];
  reasoning?: ReasoningTrace | null;
  stages: Record<string, DispatchStage>;
  budget: ContextBudget | null;
  plan: ImagePlan | null;
  body: { finishReason: string; usage: TokenUsage } | null;
  state: StateResult | null;
  terminal: boolean;
  error: string | null;
};
export type StoredRun = {
  runId: string;
  sessionId: string;
  assistantMessageId: string;
  context: ChatContext;
};

export function dispatchError(snapshot: DispatchSnapshot): string | undefined {
  if (snapshot.stages.body?.status !== "failed")
    return snapshot.error ?? undefined;
  let summary: string;
  switch (snapshot.body?.finishReason) {
    case "stop":
      summary = "正文生成失败：模型已正常结束，但没有返回有效正文。";
      break;
    case "length":
      summary = "正文生成中断：模型达到长度限制，回复未完整生成。";
      break;
    default:
      summary = "正文生成失败，回复未完整生成。";
  }
  return `${summary}\n本轮未进行状态整理。\n诊断信息：${snapshot.error}\n任务 ID：${snapshot.runId}`;
}

export class ResultExpired extends Error {}
export class DispatchRejected extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

/** 重订阅只读取同一任务，绝不重新调用模型。 */
export async function followDispatch(
  run: StoredRun,
  signal: AbortSignal,
  apply: (snapshot: DispatchSnapshot) => Promise<void>,
  request?: unknown,
): Promise<void> {
  let snapshot: DispatchSnapshot | undefined;
  let first = request !== undefined;
  for (;;) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(
        first ? "/api/chat" : `/api/chat/${run.runId}/events`,
        {
          method: first ? "POST" : "GET",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          ...(first ? { body: JSON.stringify(request) } : {}),
          signal,
        },
      );
    } catch (error) {
      signal.throwIfAborted();
      // POST 的响应可能丢失，下一次只查询已分配的任务 ID。
      first = false;
      await reconnectDelay(signal);
      continue;
    }
    first = false;
    if (!response.ok) {
      const error = await response.json();
      if (response.status === 404) throw new ResultExpired(error.message);
      throw new DispatchRejected(error.message, error.code);
    }
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let applying = Promise.resolve();
    let applyError: unknown;
    const parser = new SSEParser((event) => {
      const wire = JSON.parse(event.data);
      if (event.name === "snapshot") {
        snapshot = wire as DispatchSnapshot;
        snapshot.segments = mergeSegments(snapshot.segments);
      } else {
        if (!snapshot || wire.revision <= snapshot.revision) return;
        snapshot = { ...snapshot, revision: wire.revision };
        const value = wire.value;
        if (event.name === "delta")
          snapshot.segments = append(snapshot.segments, value);
        if (event.name === "reasoning")
          snapshot.reasoning = {
            text: (snapshot.reasoning?.text ?? "") + value.delta,
            status: value.status,
            startedAt: value.startedAt,
            endedAt: value.endedAt,
          };
        if (event.name === "context") snapshot.budget = value;
        if (event.name === "stage") {
          snapshot.stages = { ...snapshot.stages, [value.name]: value };
          if (value.name === "selection" && value.plan)
            snapshot.plan = value.plan;
        }
        if (event.name === "body_done") snapshot.body = value;
        if (event.name === "state_result") snapshot.state = value;
        if (event.name === "done")
          snapshot = {
            ...value,
            revision: wire.revision,
            segments: mergeSegments(value.segments),
          };
      }
      const next = structuredClone(snapshot!);
      applying = applying
        .then(() => {
          if (applyError) return;
          return apply(next);
        })
        .catch((error) => {
          applyError = error;
          void reader.cancel().catch(() => {});
        });
    });
    try {
      while (!snapshot?.terminal) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          signal.throwIfAborted();
          break;
        }
        const { value, done } = chunk;
        if (done) {
          parser.feed(decoder.decode());
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await applying;
    }
    if (applyError) throw applyError;
    if (snapshot?.terminal) return;
    await reconnectDelay(signal);
  }
}
function append(segments: Segment[], delta: Segment): Segment[] {
  const last = segments.at(-1);
  return last?.kind === delta.kind
    ? [
        ...segments.slice(0, -1),
        { kind: last.kind, text: last.text + delta.text },
      ]
    : [...segments, delta];
}
function mergeSegments(segments: Segment[]) {
  return segments.reduce(append, [] as Segment[]);
}
function reconnectDelay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 1000);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
