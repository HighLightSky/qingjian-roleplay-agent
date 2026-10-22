export type ContentPart =
  { type: "text"; text: string } | { type: "image"; assetId: string };
/** id 为浏览器数据库内全局递增的 imgN，与聊天上传顺序无关。 */
export type ImageAsset = {
  id: string;
  sha256: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  displayName: string;
  originalBlob: Blob;
  thumbnailBlob?: Blob;
  createdAt: string;
};
export type VisualSource =
  | {
      type: "message";
      messageId: string;
      seq: number;
      text: string;
      imageIndex: number;
      uploadIndex: number;
    }
  | { type: "character_photo"; characterId: string; profileVersion: number };
export const messageSourceIds = (sources: VisualSource[]) =>
  sources.filter((s) => s.type === "message").map((s) => s.messageId);
export const photoSources = (sources: VisualSource[]) =>
  sources.filter((s) => s.type === "character_photo");
export type Observation = {
  assetId: string;
  summary: string;
  visibleDetails: string[];
  extractedText: string[];
  uncertainDetails: string[];
  sources: VisualSource[];
  version: number;
};
export type VisualObservation = Observation & {
  id: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
};
export type ImageUsage = {
  id: string;
  assetId: string;
  sessionId: string;
  messageId: string;
  purpose: string;
  createdAt: string;
};
export type CatalogAsset = {
  assetId: string;
  sha256: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  sources: VisualSource[];
  observation: Observation | null;
  recentUses: { messageId: string; purpose: string }[];
};
export type ImagePlan = {
  status: "ready" | "ambiguous" | "over_limit";
  selectedHistoricalImages: { assetId: string; purpose: string }[];
  candidateAssetIds: string[];
  message: string;
  contextFingerprint: string;
  operationId: string;
};
export type ImagePayload = { assetId: string; sha256: string; dataUrl: string };
export type VisualContext = {
  sessionId: string;
  assetCatalog: CatalogAsset[];
  plan: ImagePlan | null;
  imagePayloads: ImagePayload[];
};
export type Capabilities = {
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyTokens: number;
  compactionTriggerRatio: number;
  compactionTargetRatio: number;
  retainedTurns: number;
  compactionMaxBatches: number;
  visionSupported: boolean;
  mimeTypes: string[];
  maxImages: number;
  maxImageBytes: number;
  maxPixels: number;
  maxRequestBytes: number;
};
export const imageIds = (parts?: readonly ContentPart[]) =>
  (parts ?? [])
    .filter(
      (p): p is Extract<ContentPart, { type: "image" }> => p.type === "image",
    )
    .map((p) => p.assetId);

export type Commit = <T>(task: () => Promise<T>) => Promise<T>;

export function requiredImageIds(context: {
  input: { parts?: ContentPart[] };
  visual?: VisualContext;
}) {
  return [
    ...new Set([
      ...imageIds(context.input.parts),
      ...(context.visual?.assetCatalog ?? [])
        .filter(
          (a) =>
            a.sources.some((s) => s.type === "character_photo") &&
            !a.observation,
        )
        .map((a) => a.assetId),
    ]),
  ];
}
