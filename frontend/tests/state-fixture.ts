import { imageIds, type VisualSource } from "../lib/images/types";
import type { ChatContext } from "../lib/chat/context";
import type { SourceMessage, StateResult } from "../lib/state/types";
export type UpdateBody = {
  operationId: string;
  context: ChatContext;
  fromExclusiveSeq: number;
  throughSeq: number;
  assistantCheckpointVersion: number;
  messages: SourceMessage[];
};
export function emptyStateResult(body: UpdateBody): StateResult {
  return {
    scenePlan: {
      id: `scene:${body.operationId}`,
      sessionId: body.context.state.sessionId,
      assistantMessageId: body.messages.at(-1)!.id,
      sourceSeq: body.throughSeq,
      sourceCheckpointVersion: body.assistantCheckpointVersion,
      profileVersion: body.context.character.profileVersion,
      referenceImages: [],
      prompt: "女孩坐在书桌旁的椅子上，双脚落地，低头阅读桌上的书。",
      error: null,
    },
    operationId: body.operationId,
    sessionVersion: body.context.state.sessionVersion,
    memoryVersion: body.context.state.memoryVersion,
    fromExclusiveSeq: body.fromExclusiveSeq,
    throughSeq: body.throughSeq,
    visualChanges: [],
    storyChanges: [],
    memoryChanges: [],
    goalChanges: [],
    visualObservations: (body.context.visual?.imagePayloads ?? []).map((p) => ({
      assetId: p.assetId,
      summary: "地图",
      visibleDetails: ["红色标记"],
      extractedText: [],
      uncertainDetails: ["小字不清"],
      sources: observationSources(body, p.assetId),
      version:
        (body.context.visual!.assetCatalog.find((a) => a.assetId === p.assetId)
          ?.observation?.version ?? 0) + 1,
    })),
  };
}

function observationSources(body: UpdateBody, assetId: string): VisualSource[] {
  const catalog = body.context.visual!.assetCatalog;
  const sources = [
    ...(catalog.find((a) => a.assetId === assetId)?.sources ?? []),
  ];
  const index = imageIds(body.context.input.parts).indexOf(assetId) + 1;
  if (index) {
    const user = body.messages.filter((m) => m.role === "user").at(-1)!;
    const uploads = Math.max(
      0,
      ...[...catalog, ...(body.context.visual?.missingAssets ?? [])]
        .flatMap((a) => a.sources)
        .filter((s) => s.type === "message")
        .map((s) => s.uploadIndex),
    );
    sources.push({
      type: "message",
      messageId: user.id,
      seq: user.seq,
      text: body.context.input.text,
      imageIndex: index,
      uploadIndex: uploads + index,
    });
  }
  return sources;
}
