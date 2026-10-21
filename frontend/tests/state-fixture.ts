import type { ChatContext } from "../lib/chat/context";
import type { SourceMessage, StateResult } from "../lib/state/types";
export type UpdateBody = {
  operationId: string;
  context: ChatContext;
  fromExclusiveSeq: number;
  throughSeq: number;
  messages: SourceMessage[];
};
export function emptyStateResult(body: UpdateBody): StateResult {
  return {
    operationId: body.operationId,
    sessionVersion: body.context.state.sessionVersion,
    memoryVersion: body.context.state.memoryVersion,
    fromExclusiveSeq: body.fromExclusiveSeq,
    throughSeq: body.throughSeq,
    storyChanges: [],
    memoryChanges: [],
    goalChanges: [],
    visualObservations: (body.context.visual?.imagePayloads ?? []).map((p) => ({
      assetId: p.assetId,
      summary: "地图",
      visibleDetails: ["红色标记"],
      extractedText: [],
      uncertainDetails: ["小字不清"],
      sourceMessageIds: body.messages
        .filter((m) => m.role === "user")
        .slice(-1)
        .map((m) => m.id),
      version:
        (body.context.visual!.assetCatalog.find((a) => a.assetId === p.assetId)
          ?.observation?.version ?? 0) + 1,
    })),
  };
}
