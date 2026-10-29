import type { JsonObject } from "./types";

/** 只检查 JSON 传输边界；姿势内部结构由渲染器解释。 */
export function validatePoseJson(
  value: unknown,
  maxBytes?: number,
): asserts value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("姿势 JSON 顶层必须是对象。");
  if (
    !["bones", "characters", "poses", "image_poses"].some((key) =>
      Object.hasOwn(value, key),
    )
  )
    throw new Error(
      "姿势 JSON 缺少 bones、characters、poses 或 image_poses 标识字段。",
    );
  let text: string;
  try {
    text = JSON.stringify(value, (_key, item) => {
      if (typeof item === "number" && !Number.isFinite(item))
        throw new Error("姿势 JSON 不能包含 NaN 或 Infinity。");
      if (["undefined", "function", "symbol", "bigint"].includes(typeof item))
        throw new Error("姿势 JSON 格式错误。");
      return item;
    });
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith("姿势 JSON"))
      throw reason;
    throw new Error("姿势 JSON 格式错误。");
  }
  if (
    maxBytes !== undefined &&
    new TextEncoder().encode(text).byteLength > maxBytes
  )
    throw new Error(`姿势 JSON 超过大小限制（${maxBytes} 字节）。`);
}
