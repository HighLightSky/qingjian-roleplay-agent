import { test } from "node:test";
import assert from "node:assert/strict";
import { poseScene } from "./pose-fixture";
import {
  validatePoseScene,
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

test("编辑入口拒绝非 v3、缺少人物和非法关节数字，不替换默认姿势", () => {
  const scene = poseScene();
  validatePoseScene(scene);
  for (const invalid of [
    { ...scene, schema_version: 2 },
    { ...scene, active_character_id: "missing" },
    { ...scene, activeTab: 9 },
    { ...scene, type: "pose_animation" },
  ])
    assert.throws(() => validatePoseScene(invalid));
  scene.characters[0].poses[0].bones.upperarm_l = [0, Infinity, 0];
  assert.throws(() => validatePoseScene(scene), /有限数字/);
});
