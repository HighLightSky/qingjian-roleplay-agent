import type { JsonObject } from "../scene-images/types";
import { object, array, integer, string } from "../state/validation";

const MAX_SCENE_CHARACTERS = 4;
const MAX_CHARACTER_POSES = 10000;

export type Vector = [number, number, number];
export type CharacterTransform = {
  x: number;
  y: number;
  z: number;
  zoom: number;
};
export type OutputCamera = {
  offset_x: number;
  offset_y: number;
  zoom: number;
  yaw_deg: number;
  pitch_deg: number;
};
export type CharacterPose = JsonObject & {
  bones: Record<string, Vector>;
  modelRotation?: Vector;
  bonePositions?: Record<string, Vector>;
  ikEffectorPositions?: Record<string, Vector>;
  poleTargetPositions?: Record<string, Vector>;
  hipBonePosition?: Record<string, Vector>;
  cameraParams?: OutputCamera;
};
export type PoseCharacter = JsonObject & {
  id: string;
  mesh: JsonObject;
  transform: CharacterTransform;
  poses: CharacterPose[];
};
export type PoseScene = JsonObject & {
  schema_version: 3;
  active_character_id: string;
  activeTab: number;
  characters: PoseCharacter[];
};

/** 旧单人姿势在入口转换为人物场景，原候选及未知字段保持不变。 */
export function normalizePoseScene(value: unknown): PoseScene {
  object(value);
  if (
    value.schema_version !== undefined &&
    value.schema_version !== 1 &&
    value.schema_version !== 2 &&
    value.schema_version !== 3
  )
    throw new Error(`不支持的姿势场景版本：${value.schema_version}。`);
  const scene = structuredClone(value);
  const activeTab = scene.activeTab === undefined ? 0 : scene.activeTab;
  integer(activeTab, 0);
  const sourceCharacters: unknown =
    scene.characters === undefined
      ? [
          {
            id: "character-1",
            mesh: scene.mesh === undefined ? {} : scene.mesh,
            transform: { x: 0, y: 0, z: 0, zoom: 1 },
            poses:
              scene.poses === undefined
                ? scene.image_poses === undefined
                  ? [{}]
                  : scene.image_poses
                : scene.poses,
          },
        ]
      : scene.characters;
  array(sourceCharacters, MAX_SCENE_CHARACTERS);
  const characters = sourceCharacters.map((source, index) => {
    object(source);
    const transform = source.transform === undefined ? {} : source.transform;
    object(transform);
    const normalizedTransform: Record<string, unknown> = {
      x: 0,
      y: 0,
      z: 0,
      zoom: 1,
      ...transform,
    };
    for (const [key, alias] of [
      ["x", "offset_x"],
      ["y", "offset_y"],
      ["z", "depth"],
      ["zoom", "scale"],
    ] as const) {
      if (transform[key] === undefined && transform[alias] !== undefined)
        normalizedTransform[key] = transform[alias];
    }
    return {
      ...source,
      id: source.id === undefined ? `character-${index + 1}` : source.id,
      poses: source.poses,
      mesh:
        source.mesh === undefined
          ? scene.mesh === undefined
            ? {}
            : scene.mesh
          : source.mesh,
      transform: normalizedTransform,
    };
  });
  const activeIndex =
    scene.active_character_index === undefined
      ? 0
      : scene.active_character_index;
  integer(activeIndex, 0);
  const activeId =
    scene.active_character_id === undefined
      ? scene.activeCharacterId === undefined
        ? characters[activeIndex]?.id
        : scene.activeCharacterId
      : scene.active_character_id;
  const active = characters.find((character) => character.id === activeId);
  if (!active) throw new Error("姿势场景缺少活动人物。");
  array(active.poses, MAX_CHARACTER_POSES);
  const pose = active.poses[activeTab];
  object(pose);
  // 早期场景会把活动姿态及输出机位放在顶层。
  for (const key of [...EDITED_POSE_FIELDS, "cameraParams"]) {
    if (pose[key] === undefined && scene[key] !== undefined)
      pose[key] = scene[key];
  }
  if (scene.export !== undefined) {
    object(scene.export);
    const camera = pose.cameraParams === undefined ? {} : pose.cameraParams;
    object(camera);
    for (const key of [
      "offset_x",
      "offset_y",
      "zoom",
      "yaw_deg",
      "pitch_deg",
    ]) {
      if (camera[key] === undefined && scene.export[`cam_${key}`] !== undefined)
        camera[key] = scene.export[`cam_${key}`];
    }
    pose.cameraParams = camera;
  }
  const normalized = {
    ...scene,
    schema_version: 3,
    ...(scene.type === "single_pose" || scene.type === "pose_set"
      ? { type: "scene_pose" }
      : {}),
    active_character_id: activeId,
    activeTab,
    characters,
  };
  validatePoseScene(normalized);
  return normalized;
}

function vector(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((n) => typeof n !== "number" || !Number.isFinite(n))
  )
    throw new Error("姿势向量必须包含三个有限数字。");
}

/** 只在编辑器入口校验场景；体型默认值由固定版本的上游模块解释。 */
export function validatePoseScene(value: unknown): asserts value is PoseScene {
  object(value);
  if (value.schema_version !== 3)
    throw new Error("编辑后的姿势场景必须使用 v3 格式。");
  if (value.type === "pose_animation" || value.animation)
    throw new Error("姿势编辑器暂不支持动画场景。");
  string(value.active_character_id);
  integer(value.activeTab, 0);
  array(value.characters, MAX_SCENE_CHARACTERS);
  if (!value.characters.length) throw new Error("姿势场景缺少人物。");
  const ids = new Set<string>();
  for (const character of value.characters) {
    object(character);
    string(character.id);
    if (!character.id || ids.has(character.id))
      throw new Error("场景人物标识为空或重复。");
    ids.add(character.id);
    object(character.mesh);
    object(character.transform);
    for (const key of ["x", "y", "z", "zoom"]) {
      if (
        typeof character.transform[key] !== "number" ||
        !Number.isFinite(character.transform[key])
      )
        throw new Error(`人物位置或缩放无效：${character.id} · ${key}`);
    }
    if ((character.transform.zoom as number) <= 0)
      throw new Error("人物缩放必须大于零。");
    array(character.poses, MAX_CHARACTER_POSES);
    const pose = character.poses[value.activeTab as number];
    object(pose);
    object(pose.bones);
    for (const rotation of Object.values(pose.bones)) vector(rotation);
    if (pose.modelRotation !== undefined) vector(pose.modelRotation);
    for (const key of [
      "bonePositions",
      "ikEffectorPositions",
      "poleTargetPositions",
      "hipBonePosition",
    ]) {
      if (pose[key] === undefined) continue;
      object(pose[key]);
      for (const position of Object.values(pose[key])) vector(position);
    }
    if (pose.cameraParams !== undefined) {
      object(pose.cameraParams);
      for (const n of Object.values(pose.cameraParams))
        if (typeof n !== "number" || !Number.isFinite(n))
          throw new Error("姿势相机参数必须是有限数字。");
    }
  }
  if (!ids.has(value.active_character_id))
    throw new Error("姿势场景缺少活动人物。");
}

export function sceneCharacter(scene: PoseScene, id: string): PoseCharacter {
  const character = scene.characters.find((row) => row.id === id);
  if (!character) throw new Error(`姿势场景缺少人物：${id}`);
  return character;
}

const EDITED_POSE_FIELDS = [
  "bones",
  "modelRotation",
  "bonePositions",
  "ikEffectorPositions",
  "poleTargetPositions",
  "hipBonePosition",
] as const;

/** 观察用 camera 不属于编辑结果，只有构图控件可以改变输出机位。 */
export function writeEditedPose(
  scene: PoseScene,
  characterId: string,
  edited: JsonObject,
) {
  const pose = sceneCharacter(scene, characterId).poses[scene.activeTab];
  for (const key of EDITED_POSE_FIELDS) {
    if (edited[key] !== undefined)
      (pose as JsonObject)[key] = structuredClone(edited[key]);
  }
}

export function writeOutputCamera(scene: PoseScene, camera: OutputCamera) {
  const pose = sceneCharacter(scene, scene.active_character_id).poses[
    scene.activeTab
  ];
  pose.cameraParams = { ...pose.cameraParams, ...camera };
  // 场景级镜像与当前姿态保持同一输出机位，不触碰观察相机的位置。
  const sceneCamera = scene.camera as JsonObject | undefined;
  scene.camera = {
    ...sceneCamera,
    yaw_deg: camera.yaw_deg,
    pitch_deg: camera.pitch_deg,
  };
  if (scene.export) {
    const settings = scene.export as JsonObject;
    for (const [key, value] of Object.entries(camera))
      settings[`cam_${key}`] = value;
  }
}

const MAX_HISTORY_STEPS = 30;

export class SceneHistory {
  private undoScenes: PoseScene[] = [];
  private redoScenes: PoseScene[] = [];
  private saved: string;
  private scene: PoseScene;
  constructor(scene: PoseScene) {
    this.scene = structuredClone(scene);
    this.saved = JSON.stringify(scene);
  }
  get canUndo() {
    return this.undoScenes.length > 0;
  }
  get canRedo() {
    return this.redoScenes.length > 0;
  }
  checkpoint(next: PoseScene): boolean {
    const serialized = JSON.stringify(next);
    if (serialized === this.saved) return false;
    this.undoScenes.push(structuredClone(this.scene));
    if (this.undoScenes.length > MAX_HISTORY_STEPS) this.undoScenes.shift();
    this.redoScenes = [];
    this.scene = structuredClone(next);
    this.saved = serialized;
    return true;
  }
  undo(): PoseScene {
    const scene = this.undoScenes.pop();
    if (!scene) throw new Error("没有可撤销的姿态编辑。");
    this.redoScenes.push(this.scene);
    this.scene = scene;
    this.saved = JSON.stringify(scene);
    return structuredClone(scene);
  }
  redo(): PoseScene {
    const scene = this.redoScenes.pop();
    if (!scene) throw new Error("没有可重做的姿态编辑。");
    this.undoScenes.push(this.scene);
    this.scene = scene;
    this.saved = JSON.stringify(scene);
    return structuredClone(scene);
  }
}
