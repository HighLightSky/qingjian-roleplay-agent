export type ContentPart =
  { type: "text"; text: string } | { type: "image"; assetId: string };
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
export type Observation = {
  assetId: string;
  summary: string;
  visibleDetails: string[];
  extractedText: string[];
  uncertainDetails: string[];
  sourceMessageIds: string[];
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
  sources: {
    messageId: string;
    seq: number;
    text: string;
    imageIndex: number;
    uploadIndex: number;
  }[];
  observation: Observation | null;
  recentUses: { messageId: string; purpose: string }[];
};
export type ImagePlan = {
  status: "ready" | "ambiguous" | "over_limit";
  selectedHistoricalImages: { assetId: string; purpose: string }[];
  candidateAssetIds: string[];
  message: string;
  contextFingerprint: string;
};
export type ImagePayload = { assetId: string; sha256: string; dataUrl: string };
export type VisualContext = {
  sessionId: string;
  assetCatalog: CatalogAsset[];
  plan: ImagePlan | null;
  imagePayloads: ImagePayload[];
};
export type VisualTask = {
  id: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  assistantText: string;
  context: import("../chat/context").ChatContext;
  createdAt: string;
  updatedAt: string;
};
export type Capabilities = {
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
