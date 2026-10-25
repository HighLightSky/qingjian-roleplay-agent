import { fileBytes } from "./repository";
import { sha256 } from "./hash";
import type { SceneTaskSnapshot } from "../scene-images/types";

async function checked(response: Response) {
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }
  return response;
}

export async function generateDirectImage(
  prompt: string,
  files: File[],
  runId: string,
  signal: AbortSignal,
  onStatus: (snapshot: SceneTaskSnapshot) => void,
): Promise<Blob> {
  const references = [];
  for (const [index, file] of files.entries()) {
    const bytes = new Uint8Array(await fileBytes(file));
    const hash = sha256(bytes);
    await checked(
      await fetch(`/api/scene-images/inputs/${hash}`, {
        method: "PUT",
        body: file,
        signal,
      }),
    );
    references.push({
      assetId: `img${index + 1}`,
      scope: index === 0 ? "编辑目标" : "参考",
      sha256: hash,
      sourceSha256: hash,
      sourceGenerationId: null,
    });
  }
  const response = await checked(
    await fetch("/api/scene-images/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, prompt, referenceImages: references }),
      signal,
    }),
  );
  let snapshot: SceneTaskSnapshot = await response.json();
  for (;;) {
    onStatus(snapshot);
    if (snapshot.terminal) break;
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", aborted);
        resolve();
      }, 1000);
      signal.addEventListener("abort", aborted, { once: true });
    });
    snapshot = await (
      await checked(await fetch(`/api/scene-images/${runId}`, { signal }))
    ).json();
  }
  if (snapshot.status !== "succeeded") {
    await checked(
      await fetch(`/api/scene-images/${runId}/ack`, { method: "POST", signal }),
    );
    throw new Error(
      snapshot.error ??
        (snapshot.status === "cancelled" ? "已取消生成。" : "图片生成失败。"),
    );
  }
  const blob = await (
    await checked(await fetch(`/api/scene-images/${runId}/result`, { signal }))
  ).blob();
  if (blob.type !== "image/png") throw new Error("生成结果不是 PNG。");
  await checked(
    await fetch(`/api/scene-images/${runId}/ack`, { method: "POST", signal }),
  );
  return blob;
}
