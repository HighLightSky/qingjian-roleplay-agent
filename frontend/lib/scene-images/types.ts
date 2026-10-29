export type VisualState = {
  outfit: string;
  hairstyle: string;
  accessories: string[];
  appearanceChanges: string[];
};
export const emptyVisualState = (): VisualState => ({
  outfit: "",
  hairstyle: "",
  accessories: [],
  appearanceChanges: [],
});
export type VisualSources = Partial<
  Record<
    keyof VisualState,
    {
      origin: "manual" | "automatic";
      updatedAt: string;
      sourceMessageIds: string[];
    }
  >
>;
export type SceneReference = {
  assetId: string;
  scope: string;
  sourceSha256: string | null;
  sourceGenerationId: string | null;
};
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type PoseSelection = {
  poseId: string;
  score: number;
  description: { zh: string; en: string };
  pose: { [key: string]: JsonValue };
};
export type PoseSearch = {
  status: "idle" | "searching" | "succeeded" | "failed";
  query: string | null;
  revision: number;
  matches: PoseSelection[];
  selectedPoseId: string | null;
  error: string | null;
};
export type PoseSubmission = {
  poseEnabled: boolean;
  poseQuery: string | null;
  characterReferenceAssetId: string | null;
  poseSelection: PoseSelection | null;
};
export type SceneDraft = {
  prompt: string;
  width: number;
  height: number;
  referenceAssetIds: string[];
  poseEnabled: boolean;
  poseQuery: string;
  characterReferenceAssetId: string | null;
  poseSearch: PoseSearch;
};
export type SceneImagePlan = {
  id: string;
  sessionId: string;
  assistantMessageId: string;
  sourceSeq: number;
  sourceCheckpointVersion: number;
  profileVersion: number;
  referenceImages: SceneReference[];
  prompt: string;
  poseQuery: string | null;
  characterReferenceAssetId: string | null;
  error: string | null;
  draft?: SceneDraft;
};
export type SceneInputReference = Omit<SceneReference, "sourceSha256"> & {
  sourceSha256: string;
  sha256: string | null;
};
export type SceneSubmission = PoseSubmission & {
  prompt: string;
  effectivePrompt: string | null;
  // 旧失败任务无法还原请求尺寸，迁移时明确保留未知值。
  width: number | null;
  height: number | null;
  referenceImages: SceneInputReference[];
};
export type GenerationStatus =
  | "pending"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";
export type SceneGeneration = {
  id: string;
  sessionId: string;
  planId: string;
  assistantMessageId: string;
  sourceCheckpointVersion: number;
  sourceSeq: number;
  submission: SceneSubmission;
  status: GenerationStatus;
  assetId?: string;
  referenceStatus: "eligible" | "rejected";
  rejectionReason?: string;
  supersedesGenerationId?: string;
  error?: string;
  acknowledged?: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type SceneTaskSnapshot = {
  runId: string;
  revision: number;
  status: Exclude<GenerationStatus, "pending">;
  errorCode: string | null;
  error: string | null;
  terminal: boolean;
  submission: SceneSubmission;
};
export type GenerationCapabilities = {
  enabled: boolean;
  poseMaxBytes: number;
  poseSearchMaxRequestBytes: number;
  poseSearchMaxResponseBytes: number;
  poseSearchTopK: number;
  defaultWidth: number;
  defaultHeight: number;
  dimensionAlignment: number;
  maxReferenceImages: number;
  maxImageBytes: number;
  maxPixels: number;
  maxEdge: number;
  maxTotalPixels: number;
  maxRequestBytes: number;
  maxPromptCharacters: number;
  maxOutputBytes: number;
  maxOutputPixels: number;
  referenceMaxEdge: number;
  referenceJpegQuality: number;
};
export const isActiveGeneration = (status: GenerationStatus) =>
  ["pending", "running", "cancelling"].includes(status);
