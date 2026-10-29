import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "../lib/scene-images/types";
import { poseScene } from "./pose-fixture";
import {
  createPoseEditorScene,
  applyPoseSceneEdits,
  writeEditedPose,
  writeOutputCamera,
  SceneHistory,
} from "../lib/pose-editor/scene";

test("编辑姿态仅写目标人物骨骼与 IK，保留未知字段和输出机位", () => {
  const scene = poseScene();
  const original = structuredClone(scene);
  const character = structuredClone(scene.characters[0]);
  character.id = "other";
  scene.characters.push(character);
  writeEditedPose(scene, "other", {
    bones: { upperarm_l: [10, 20, 30] },
    bonePositions: { pelvis: [1, 2, 3] },
    ikEffectorPositions: { hand_l: [3, 4, 5] },
    camera: { posX: 99 },
    cameraParams: { zoom: 99 },
  });
  assert.deepEqual(scene.characters[0], original.characters[0]);
  assert.equal(scene.active_character_id, "hero");
  assert.deepEqual(scene.characters[1].poses[0].bones.upperarm_l, [10, 20, 30]);
  assert.deepEqual(
    scene.characters[1].poses[0].ikEffectorPositions!.hand_l,
    [3, 4, 5],
  );
  assert.deepEqual(
    scene.characters[1].poses[0].cameraParams,
    original.characters[0].poses[0].cameraParams,
  );
  assert.deepEqual(
    scene.characters[1].poses[1],
    original.characters[0].poses[1],
  );
  assert.deepEqual(scene.vendorMetadata, { preserved: true });
});

test("场景撤销重做包含构图和人物位置，恢复后新编辑丢弃旧重做分支", () => {
  const scene = poseScene();
  const history = new SceneHistory(scene);
  scene.characters[0].transform.x = 2;
  history.checkpoint(scene);
  writeOutputCamera(scene, {
    offset_x: 1,
    offset_y: 2,
    zoom: 1.2,
    yaw_deg: 30,
    pitch_deg: 15,
  });
  history.checkpoint(scene);
  const undone = history.undo();
  assert.equal(undone.characters[0].transform.x, 2);
  assert.equal(undone.characters[0].poses[0].cameraParams!.yaw_deg, 0);
  assert.equal(history.redo().characters[0].poses[0].cameraParams!.yaw_deg, 30);
  const reset = history.undo();
  reset.characters[0].transform.y = 3;
  history.checkpoint(reset);
  assert.equal(history.canRedo, false);
});

for (const version of [undefined, 1, 2, 3, 99, "future"]) {
  for (const shape of ["single_pose", "poses", "image_poses"]) {
    test(`编辑 ${version ?? "无版本"} · ${shape} 只保存用户改动，保留原包装和缺省字段`, () => {
      const source: JsonObject = {
        ...(version === undefined ? {} : { schema_version: version }),
        vendorMetadata: { preserved: true },
        ...(shape === "single_pose"
          ? { bones: { head: [1, 2, 3], unknown_bone: [4, 5, 6] } }
          : {
              [shape]: [
                { bones: { head: [1, 2, 3], unknown_bone: [4, 5, 6] } },
                { untouched: true },
              ],
            }),
      };
      const original = structuredClone(source);
      const before = createPoseEditorScene(source);
      assert.deepEqual(applyPoseSceneEdits(source, before, before), source);
      const after = structuredClone(before);
      writeEditedPose(after, after.active_character_id, {
        bones: { head: [10, 20, 30] },
      });
      const expected = structuredClone(source);
      const pose =
        shape === "single_pose"
          ? expected
          : (expected[shape] as JsonObject[])[0];
      (pose.bones as JsonObject).head = [10, 20, 30];
      assert.deepEqual(applyPoseSceneEdits(source, before, after), expected);
      assert.deepEqual(source, original);
    });
  }
}

test("人物场景和部分机位只写修改的参数，不添加缺省体型、机位或改变版本", () => {
  const source: JsonObject = {
    schema_version: 99,
    characters: [
      {
        id: "hero",
        poses: [{ bones: { head: [0, 0, 0] }, cameraParams: { custom: true } }],
      },
    ],
  };
  const before = createPoseEditorScene(source);
  // 本地视口的机位缺省值只作为比较基线。
  before.characters[0].poses[0].cameraParams = {
    offset_x: 0,
    offset_y: 0,
    zoom: 1,
    yaw_deg: 0,
    pitch_deg: 0,
    custom: true,
  };
  const after = structuredClone(before);
  writeOutputCamera(after, {
    offset_x: 0,
    offset_y: 0,
    zoom: 1,
    yaw_deg: 450,
    pitch_deg: 0,
  });
  const result = applyPoseSceneEdits(source, before, after);
  assert.deepEqual(result, {
    schema_version: 99,
    characters: [
      {
        id: "hero",
        poses: [
          {
            bones: { head: [0, 0, 0] },
            cameraParams: { custom: true, yaw_deg: 450 },
          },
        ],
      },
    ],
  });
});

test("多人场景编辑保留未知骨骼、其他人物、其他姿态和原始数据", () => {
  const source = poseScene();
  source.characters[0].poses[0].bones.custom_bone = [1, 2, 3];
  const other = structuredClone(source.characters[0]);
  other.id = "other";
  source.characters.push(other);
  const original = structuredClone(source);
  const before = createPoseEditorScene(source);
  const after = structuredClone(before);
  writeEditedPose(after, "other", { bones: { head: [10, 20, 30] } });
  const result = applyPoseSceneEdits(source, before, after) as typeof source;
  assert.deepEqual(result.characters[0], original.characters[0]);
  assert.deepEqual(
    result.characters[1].poses[1],
    original.characters[1].poses[1],
  );
  assert.deepEqual(result.characters[1].poses[0].bones.custom_bone, [1, 2, 3]);
  assert.deepEqual(source, original);
});
