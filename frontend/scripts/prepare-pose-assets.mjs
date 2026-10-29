import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(resolve(project, "scripts/pose-assets.json"), "utf8"),
);
const root = resolve(project, "public/vendor/vnccs", manifest.revision);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

await Promise.all(
  manifest.files.map(async (file) => {
    const target = resolve(root, file.path);
    let cached;
    try {
      cached = await readFile(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (cached && digest(cached) === file.sha256) return;
    console.log(`准备姿态资源：${file.path}`);
    const response = await fetch(file.url, {
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok)
      throw new Error(
        `姿态资源下载失败：${file.path}，HTTP ${response.status}`,
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw new Error(`姿态资源校验失败：${file.path}`);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temp, bytes);
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }),
);
console.log(`姿态资源就绪：${manifest.revision}`);
