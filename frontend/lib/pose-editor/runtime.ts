import type { JsonObject } from "../scene-images/types";
import type { CharacterTransform, OutputCamera, PoseScene } from "./scene";

export interface PoseRuntime {
  editingId: string;
  initialize(scene: PoseScene, width: number, height: number): Promise<void>;
  loadScene(scene: PoseScene, editingId: string): Promise<void>;
  updateScene(scene: PoseScene): void;
  cameraParams(): OutputCamera;
  currentPose(): JsonObject;
  resize(width: number, height: number): void;
  boneNames(): string[];
  selectBone(name: string): void;
  setIKMode(enabled: boolean): void;
  rotateBone(name: string, axis: number, degrees: number): void;
  transformCharacter(transform: CharacterTransform): void;
  snapToOutput(): void;
  capturePreview(): Promise<Blob>;
  dispose(): void;
}
export type RuntimeOptions = {
  assetBase: string;
  onPoseChange(pose: JsonObject): void;
  onBoneSelection(name: string | null): void;
};
export async function loadPoseRuntime(): Promise<{
  PoseSceneRuntime: new (
    canvas: HTMLCanvasElement,
    options: RuntimeOptions,
  ) => PoseRuntime;
}> {
  const path = "/pose-editor/runtime.mjs";
  return import(/* webpackIgnore: true */ path);
}
