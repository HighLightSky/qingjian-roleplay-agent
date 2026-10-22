import { localImageHashes } from "./data-usage";

export type ImageCacheStats = {
  imageCount: number;
  bytes: number;
  inUseImageCount: number;
  inUseBytes: number;
};
export type ImageCacheClearResult = {
  releasedImageCount: number;
  releasedBytes: number;
};

export async function imageCacheRequest<T>(
  action: "stats" | "clear",
  signal: AbortSignal,
): Promise<T> {
  const hashes = await localImageHashes();
  const response = await fetch(`/api/images/cache/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hashes }),
    cache: "no-store",
    signal,
  });
  const result = await response.json();
  if (!response.ok) {
    const detail =
      result.message ||
      `图片缓存请求失败：HTTP ${response.status} ${response.statusText}`;
    throw new Error(
      response.status === 404
        ? `${detail}。后端尚未提供图片缓存接口，请重启更新后的后端服务。`
        : detail,
    );
  }
  return result;
}
