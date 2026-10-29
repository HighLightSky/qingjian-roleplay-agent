import type { JsonObject } from "../scene-images/types";

export type Vector = [number, number, number];
export type CharacterTransform = {
  x: number;
  y: number;
  z: number;
  zoom: number;
};
export type OutputCamera = JsonObject & {
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
  active_character_id: string;
  activeTab: number;
  characters: PoseCharacter[];
};

/** 缺省值只用于本地视口，不写入待提交的姿势 JSON。 */
export function createPoseEditorScene(value: JsonObject): PoseScene {
  const source = structuredClone(value);
  const legacyPoses = source.poses ?? source.image_poses ?? [source];
  const characters = (
    (source.characters ?? [
      {
        mesh: source.mesh,
        transform: source.transform,
        poses: legacyPoses,
      },
    ]) as JsonObject[]
  ).map((character, index) => {
    const transform = (character.transform ?? {}) as JsonObject;
    return {
      ...character,
      id: character.id ?? `character-${index + 1}`,
      mesh: character.mesh ?? source.mesh ?? {},
      transform: {
        ...transform,
        x: transform.x ?? transform.offset_x ?? 0,
        y: transform.y ?? transform.offset_y ?? 0,
        z: transform.z ?? transform.depth ?? 0,
        zoom: transform.zoom ?? transform.scale ?? 1,
      },
      poses: (
        (character.poses ??
          character.image_poses ??
          legacyPoses) as JsonObject[]
      ).map((pose) => ({ ...pose })),
    };
  });
  const scene = {
    ...source,
    activeTab: source.activeTab ?? 0,
    active_character_id:
      source.active_character_id ??
      source.activeCharacterId ??
      characters[(source.active_character_index ?? 0) as number].id,
    characters,
  } as PoseScene;
  const pose = sceneCharacter(scene, scene.active_character_id).poses[
    scene.activeTab
  ];
  for (const key of EDITED_POSE_FIELDS) {
    if (pose[key] === undefined && source[key] !== undefined)
      (pose as JsonObject)[key] = source[key];
  }
  if (
    value.characters === undefined &&
    value.poses === undefined &&
    value.image_poses === undefined
  )
    pose.bones = (source.bones as Record<string, Vector>) ?? {};
  for (const character of scene.characters)
    for (const pose of character.poses) pose.bones ??= {};
  const camera: JsonObject = {
    ...(source.cameraParams as JsonObject),
    ...pose.cameraParams,
  };
  const settings = source.export as JsonObject | undefined;
  if (settings) {
    for (const key of CAMERA_FIELDS) {
      if (camera[key] === undefined && settings[`cam_${key}`] !== undefined)
        camera[key] = settings[`cam_${key}`];
    }
  }
  pose.cameraParams = camera as OutputCamera;
  return scene;
}

function writeChangedFields(
  target: JsonObject,
  before: JsonObject,
  after: JsonObject,
  fields: readonly string[],
) {
  const changes: JsonObject = {};
  for (const key of fields) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      changes[key] = structuredClone(after[key]);
  }
  Object.assign(target, changes);
  return changes;
}

/** 只合并用户改动，保留原来的版本、包装结构和缺省字段。 */
export function applyPoseSceneEdits(
  source: JsonObject,
  before: PoseScene,
  after: PoseScene,
): JsonObject {
  const result = structuredClone(source);
  for (const [index, character] of after.characters.entries()) {
    const previous = before.characters[index];
    const targetCharacter =
      result.characters == null
        ? result
        : (result.characters as JsonObject[])[index];
    const poses = (targetCharacter.poses ?? targetCharacter.image_poses) as
      JsonObject[] | undefined;
    const targetPose =
      poses === undefined ? targetCharacter : poses[after.activeTab];
    const oldPose = previous.poses[before.activeTab];
    const newPose = character.poses[after.activeTab];
    for (const key of EDITED_POSE_FIELDS) {
      if (key === "modelRotation") {
        writeChangedFields(targetPose, oldPose, newPose, [key]);
      } else {
        const oldValues = (oldPose[key] ?? {}) as JsonObject;
        const newValues = (newPose[key] ?? {}) as JsonObject;
        const target = { ...(targetPose[key] as JsonObject) };
        const changes = writeChangedFields(
          target,
          oldValues,
          newValues,
          Object.keys(newValues),
        );
        if (Object.keys(changes).length) targetPose[key] = target;
      }
    }
    const transform = { ...(targetCharacter.transform as JsonObject) };
    if (
      Object.keys(
        writeChangedFields(transform, previous.transform, character.transform, [
          "x",
          "y",
          "z",
          "zoom",
        ]),
      ).length
    )
      targetCharacter.transform = transform;
    const camera = { ...(targetPose.cameraParams as JsonObject) };
    const cameraChanges = writeChangedFields(
      camera,
      oldPose.cameraParams ?? {},
      newPose.cameraParams ?? {},
      CAMERA_FIELDS,
    );
    if (Object.keys(cameraChanges).length) targetPose.cameraParams = camera;
    if (character.id === after.active_character_id) {
      for (const [key, value] of Object.entries(cameraChanges)) {
        if (result.export) (result.export as JsonObject)[`cam_${key}`] = value;
        if (result.camera && (key === "yaw_deg" || key === "pitch_deg"))
          (result.camera as JsonObject)[key] = value;
      }
    }
  }
  return result;
}

const CAMERA_FIELDS = [
  "offset_x",
  "offset_y",
  "zoom",
  "yaw_deg",
  "pitch_deg",
] as const;

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
      (pose as JsonObject)[key] =
        key === "modelRotation"
          ? structuredClone(edited[key])
          : {
              ...(pose[key] as JsonObject),
              ...(structuredClone(edited[key]) as JsonObject),
            };
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

export class SceneHistory<T extends JsonObject = PoseScene> {
  private undoScenes: T[] = [];
  private redoScenes: T[] = [];
  private saved: string;
  private scene: T;
  constructor(scene: T) {
    this.scene = structuredClone(scene);
    this.saved = JSON.stringify(scene);
  }
  get canUndo() {
    return this.undoScenes.length > 0;
  }
  get canRedo() {
    return this.redoScenes.length > 0;
  }
  checkpoint(next: T): boolean {
    const serialized = JSON.stringify(next);
    if (serialized === this.saved) return false;
    this.undoScenes.push(structuredClone(this.scene));
    if (this.undoScenes.length > MAX_HISTORY_STEPS) this.undoScenes.shift();
    this.redoScenes = [];
    this.scene = structuredClone(next);
    this.saved = serialized;
    return true;
  }
  undo(): T {
    const scene = this.undoScenes.pop();
    if (!scene) throw new Error("没有可撤销的姿态编辑。");
    this.redoScenes.push(this.scene);
    this.scene = scene;
    this.saved = JSON.stringify(scene);
    return structuredClone(scene);
  }
  redo(): T {
    const scene = this.redoScenes.pop();
    if (!scene) throw new Error("没有可重做的姿态编辑。");
    this.undoScenes.push(this.scene);
    this.scene = scene;
    this.saved = JSON.stringify(scene);
    return structuredClone(scene);
  }
}
