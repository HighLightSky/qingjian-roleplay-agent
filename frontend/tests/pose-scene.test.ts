import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "../lib/scene-images/types";
import { poseScene } from "./pose-fixture";
import {
  validatePoseScene,
  normalizePoseScene,
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

test("编辑结果拒绝未归一化场景、缺少人物和非法关节数字", () => {
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

for (const version of [undefined, 1, 2, 3]) {
  for (const shape of ["single_pose", "poses", "image_poses"]) {
    test(`编辑入口兼容 ${version ?? "无版本"} · ${shape}，保留姿势、体型和构图`, () => {
      const modern = poseScene();
      const character = modern.characters[0];
      const source: JsonObject = {
        ...(version === undefined ? {} : { schema_version: version }),
        vendorMetadata: modern.vendorMetadata,
        mesh: character.mesh,
        ...(shape === "single_pose"
          ? { ...character.poses[0], type: "single_pose", version: "1.0" }
          : { [shape]: character.poses, activeTab: 1 }),
        export: { cam_offset_x: 2, cam_zoom: 1.4, cam_yaw_deg: 25 },
      };
      const original = structuredClone(source);
      const scene = normalizePoseScene(source);
      const activePose = scene.characters[0].poses[scene.activeTab];
      assert.equal(scene.schema_version, 3);
      assert.equal(scene.active_character_id, "character-1");
      assert.deepEqual(scene.characters[0].mesh, character.mesh);
      assert.deepEqual(scene.characters[0].transform, {
        x: 0,
        y: 0,
        z: 0,
        zoom: 1,
      });
      assert.deepEqual(
        activePose.bones,
        character.poses[shape === "single_pose" ? 0 : 1].bones,
      );
      assert.equal(
        activePose.cameraParams!.zoom,
        shape === "single_pose" ? 1 : 1.4,
      );
      assert.equal(
        activePose.cameraParams!.offset_x,
        shape === "single_pose" ? 0 : 2,
      );
      assert.deepEqual(scene.vendorMetadata, modern.vendorMetadata);
      if (shape !== "single_pose")
        assert.deepEqual(scene.characters[0].poses[0], character.poses[0]);
      writeEditedPose(scene, scene.active_character_id, {
        bones: { head: [10, 20, 30] },
      });
      assert.deepEqual(source, original);
    });
  }

  test(`编辑入口兼容 ${version ?? "无版本"} 人物场景，保留活动人物及未知字段`, () => {
    const source: JsonObject = poseScene();
    if (version === undefined) delete source.schema_version;
    else source.schema_version = version;
    const scene = normalizePoseScene(source);
    assert.deepEqual(scene, poseScene());
    scene.characters[0].poses[0].bones.upperarm_l[0] = 90;
    assert.deepEqual(
      (source.characters as JsonObject[])[0],
      poseScene().characters[0],
    );
  });
}

test("早期人物包装可从顶层恢复活动姿态及机位，其他人物不被覆盖", () => {
  const source: JsonObject = {
    schema_version: 3,
    activeCharacterId: "other",
    bones: { head: [1, 2, 3] },
    cameraParams: { zoom: 1.2 },
    characters: [
      { id: "hero", poses: [{ bones: { head: [4, 5, 6] } }] },
      {
        id: "other",
        poses: [{}],
        transform: { offset_x: 2, depth: 3, scale: 1.5 },
        custom: true,
      },
    ],
  };
  const scene = normalizePoseScene(source);
  assert.equal(scene.active_character_id, "other");
  assert.deepEqual(scene.characters[1].poses[0].bones, source.bones);
  assert.deepEqual(
    scene.characters[1].poses[0].cameraParams,
    source.cameraParams,
  );
  assert.deepEqual(scene.characters[0].poses[0].bones.head, [4, 5, 6]);
  assert.equal(scene.characters[1].transform.x, 2);
  assert.equal(scene.characters[1].transform.z, 3);
  assert.equal(scene.characters[1].transform.zoom, 1.5);
  assert.equal(scene.characters[1].custom, true);
});

test("旧格式兼容不掩盖未知版本、缺失姿势、动画和非法数据", () => {
  for (const source of [
    { bones: {}, schema_version: 4 },
    { bones: {}, schema_version: "3" },
    { bones: {}, schema_version: null },
    { schema_version: 1, mesh: {} },
    { bones: {}, type: "pose_animation", animation: {} },
    { poses: [] },
    { poses: [{ bones: {} }], activeTab: 1 },
    { bones: { head: [0, Infinity, 0] } },
    { bones: {}, mesh: null },
    { characters: [{ poses: [{ bones: {} }], transform: { x: null } }] },
    { ...poseScene(), active_character_id: "missing" },
    { ...poseScene(), characters: Array(5).fill(poseScene().characters[0]) },
  ])
    assert.throws(() => normalizePoseScene(source));
});
