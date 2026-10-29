import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePoseJson } from "../lib/scene-images/pose-json";

test("姿势传输仅要求顶层对象及任一标识字段，不套用内部 Schema 或版本白名单", () => {
  for (const pose of [
    { bones: null },
    { characters: [] },
    { poses: "由服务端解释" },
    { image_poses: [{ cameraParams: null }] },
    {
      bones: { future_bone: [99999, -99999, 1e100] },
      schema_version: "future",
      mesh: null,
      cameraParams: { zoom: -3 },
    },
    {
      characters: Array(8).fill({ poses: Array(10001).fill({}) }),
      schema_version: 999,
    },
    { bones: {}, type: "pose_animation", animation: { future: true } },
  ]) {
    const original = structuredClone(pose);
    validatePoseJson(pose);
    assert.deepEqual(pose, original);
  }
});

test("拒绝数组、原始值和检索响应包装，不把它们当成姿势对象", () => {
  for (const pose of [
    null,
    [],
    "{}",
    42,
    false,
    {},
    { schema_version: 3 },
    { matches: [{ pose: { bones: {} } }] },
  ])
    assert.throws(() => validatePoseJson(pose), /姿势 JSON/);
});

test("未知字段及嵌套数组中的非有限数值在序列化变成 null 之前被拒绝", () => {
  for (const number of [NaN, Infinity, -Infinity]) {
    const pose = { bones: {}, future: { nested: [number] } };
    assert.throws(() => validatePoseJson(pose), /NaN|Infinity/);
    assert.ok(Object.is(pose.future.nested[0], number));
  }
  validatePoseJson({
    bones: {},
    label: "NaN、Infinity 是普通文本",
    nullable: null,
  });
});

test("非 JSON 数据与循环引用明确报错，不静默丢弃字段", () => {
  for (const value of [undefined, () => {}, Symbol("x"), 1n])
    assert.throws(
      () => validatePoseJson({ bones: {}, future: value }),
      /格式错误/,
    );
  const cyclic: Record<string, unknown> = { bones: {} };
  cyclic.self = cyclic;
  assert.throws(() => validatePoseJson(cyclic), /格式错误/);
});

test("大小按照最终 JSON 文本的 UTF-8 字节数及配置检查，边界包含等号", () => {
  const pose = {
    bones: {},
    description: "中文😀",
    unknown: { preserved: true },
  };
  const original = structuredClone(pose);
  const bytes = new TextEncoder().encode(JSON.stringify(pose)).byteLength;
  assert.ok(bytes > JSON.stringify(pose).length);
  validatePoseJson(pose, bytes);
  assert.throws(() => validatePoseJson(pose, bytes - 1), /大小限制/);
  const large = { bones: {}, extra: "x".repeat(1048576) };
  assert.throws(() => validatePoseJson(large, 1048576), /1048576/);
  validatePoseJson(large, 2097152);
  assert.deepEqual(pose, original);
});
