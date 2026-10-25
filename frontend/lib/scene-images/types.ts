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
  roles: (
    | "base"
    | "identity"
    | "continuity"
    | "outfit"
    | "environment"
    | "pose"
    | "prop"
  )[];
  scope: string;
  sourceSha256: string;
  sourceGenerationId: string | null;
};
export type SceneImagePlan = {
  id: string;
  sessionId: string;
  assistantMessageId: string;
  sourceSeq: number;
  sourceCheckpointVersion: number;
  profileVersion: number;
  sceneId: string;
  previousPlanId: string;
  continuity: "new_scene" | "continue_scene" | "restage";
  target: Record<string, string>;
  referenceImages: SceneReference[];
  prompt: string;
  summary: string;
  fingerprint: string;
  status: "ready" | "reuse" | "unavailable" | "invalid";
  error: string | null;
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
  sceneId: string;
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
};
export type GenerationCapabilities = {
  enabled: boolean;
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
