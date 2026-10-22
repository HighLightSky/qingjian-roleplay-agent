import type { IDBPTransaction, StoreNames } from "idb";
import type { RoleplayDB } from "../db";
import type { Setting } from "../domain";

export const IMAGE_SEQUENCE_KEY = "imageAssetSequence";

export function assertImageId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    /^img[1-9][0-9]*$/.exec(value)?.[0] !== value
  )
    throw new Error(`图片编号无效：${String(value)}`);
}

export function imageSequence(id: string): number {
  return Number(id.slice(3));
}

export function readImageSequence(setting: Setting | undefined): number {
  if (
    !setting ||
    /^(0|[1-9][0-9]*)$/.exec(setting.value)?.[0] !== setting.value
  )
    throw new Error("图片全局计数器缺失或损坏。");
  const sequence = Number(setting.value);
  if (!Number.isSafeInteger(sequence))
    throw new Error("图片全局计数器超过安全整数范围。");
  return sequence;
}

export type ImageWriteTransaction = IDBPTransaction<
  RoleplayDB,
  StoreNames<RoleplayDB>[],
  "readwrite"
>;

/** 分配与资产、草稿共用事务，失败时编号一起回滚。 */
export async function allocateImageId(
  tx: ImageWriteTransaction,
): Promise<string> {
  const settings = tx.objectStore("settings");
  const sequence =
    readImageSequence(await settings.get(IMAGE_SEQUENCE_KEY)) + 1;
  if (!Number.isSafeInteger(sequence))
    throw new Error("图片编号已超过安全整数范围。");
  await settings.put({ key: IMAGE_SEQUENCE_KEY, value: String(sequence) });
  return `img${sequence}`;
}
