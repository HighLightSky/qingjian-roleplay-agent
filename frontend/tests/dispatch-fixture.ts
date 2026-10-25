import type { DispatchSnapshot } from "../lib/chat/dispatch";
import { emptyStateResult } from "./state-fixture";
export function dispatchResponse(request: any, failure = false) {
  const context = request.context;
  const state = emptyStateResult({
    operationId: `state:${request.assistant.id}`,
    context,
    fromExclusiveSeq: request.user.seq - 1,
    throughSeq: request.assistant.seq,
    messages: [
      {
        ...request.user,
        role: "user",
        status: "complete",
        text: context.input.text,
      },
      {
        ...request.assistant,
        role: "assistant",
        status: "complete",
        text: "她检查地图。",
      },
    ],
  });
  const snapshot: DispatchSnapshot = {
    runId: request.runId,
    imagePrompt: "",
    scenePlan: null,
    imagePromptError: null,
    revision: 1,
    segments: [{ kind: "narration", text: "她检查地图。" }],
    stages: {
      selection: { name: "selection", status: "committed", error: null },
      body: { name: "body", status: "committed", error: null },
      state_update: {
        name: "state_update",
        status: failure ? "failed" : "committed",
        error: failure ? "整理失败" : null,
      },
    },
    budget: null,
    plan: {
      operationId: context.operationId,
      status: "ready",
      selectedHistoricalImages: [],
      candidateAssetIds: [],
      message: "",
      contextFingerprint: "fixture",
    },
    body: {
      finishReason: "stop",
      usage: {
        status: "reported",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
    },
    state: failure ? null : state,
    terminal: true,
    error: failure ? "整理失败" : null,
  };
  return new Response(
    `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
