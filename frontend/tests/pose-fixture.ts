import type { PoseScene } from "../lib/pose-editor/scene";

export function poseScene(action = "standing"): PoseScene {
  const poses: Record<string, Record<string, [number, number, number]>> = {
    standing: { upperarm_l: [0, 0, -45], upperarm_r: [0, 0, 45] },
    boxing: {
      upperarm_l: [45, 0, 20],
      upperarm_r: [45, 0, -20],
      lowerarm_l: [0, 0, 120],
      lowerarm_r: [0, 0, -120],
    },
    sitting: {
      thigh_l: [-90, 0, 0],
      thigh_r: [-90, 0, 0],
      calf_l: [90, 0, 0],
      calf_r: [90, 0, 0],
    },
    jumping: {
      upperarm_l: [0, 0, 110],
      upperarm_r: [0, 0, -110],
      thigh_l: [-30, 0, 0],
      thigh_r: [-30, 0, 0],
      calf_l: [60, 0, 0],
      calf_r: [60, 0, 0],
    },
  };
  return {
    schema_version: 3,
    active_character_id: "hero",
    activeTab: 0,
    prompt: "此旧提示词不应改写",
    vendorMetadata: { preserved: true },
    characters: [
      {
        id: "hero",
        name: "主角",
        mesh: { age: 25, gender: 0.5, height: 0.5 },
        transform: { x: 0, y: 0, z: 0, zoom: 1 },
        poses: [
          {
            bones: poses[action],
            modelRotation: [0, 0, 0],
            ikEffectorPositions: {},
            poleTargetPositions: {},
            hipBonePosition: {},
            cameraParams: {
              offset_x: 0,
              offset_y: 0,
              zoom: 1,
              yaw_deg: 0,
              pitch_deg: 0,
            },
          },
          { bones: { head: [1, 2, 3] }, uneditedTab: true },
        ],
      },
    ],
  };
}
