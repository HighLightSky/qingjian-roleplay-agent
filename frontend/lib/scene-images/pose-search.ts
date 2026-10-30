import type {
  GenerationCapabilities,
  PoseLibrary,
  PoseSelection,
} from "./types";
import { array } from "../state/validation";
import { validatePoseSelection } from "./validation";

export async function requestPoseSearch(
  query: string,
  library: PoseLibrary,
  limits: GenerationCapabilities,
  signal?: AbortSignal,
): Promise<PoseSelection[]> {
  const response = await fetch("/api/scene-images/poses/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, library }),
    signal,
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`${error.code}：${error.message}`);
  }
  // 在读取过程中限流，不能先无界加载完整候选再检查大小。
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limits.poseSearchMaxResponseBytes) {
        await reader.cancel();
        throw new Error("姿势检索响应超过体积限制。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let result: { matches: unknown };
  try {
    result = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("姿势 JSON 格式错误。");
  }
  array(result.matches, limits.poseSearchTopK);
  const ids = new Set<string>();
  for (const match of result.matches) {
    validatePoseSelection(match, limits.poseMaxBytes);
    if (ids.has(match.poseId)) throw new Error("姿势检索返回了重复候选。");
    ids.add(match.poseId);
  }
  return result.matches as PoseSelection[];
}
