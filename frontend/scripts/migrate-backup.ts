import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TABLES } from "../lib/db";
import { validateBackup, type Backup } from "../lib/backup";
import { object, string } from "../lib/state/validation";
import { migrateImageIds } from "../lib/images/migrate-v7";

/** 旧格式仅在独立转换工具中读取，正式应用只接受 v8。 */
export function convertBackup(value: unknown): Backup {
  object(value);
  if (new Blob([JSON.stringify(value)]).size > 50 * 1024 * 1024)
    throw new Error("旧备份不能超过 50 MiB。");
  if (value.format !== "roleplay-agent-backup" || value.formatVersion !== 7)
    throw new Error("转换工具只接受 v7 备份。");
  object(value.data);
  for (const table of TABLES) {
    const rows = value.data[table];
    if (!Array.isArray(rows)) throw new Error(`旧备份缺少 ${table} 数据。`);
    const keys = new Set<string>();
    for (const row of rows) {
      object(row);
      const key =
        row[
          table === "settings" ? "key" : table === "drafts" ? "sessionId" : "id"
        ];
      string(key, 200);
      if (!key || keys.has(key))
        throw new Error(`旧备份 ${table} 包含空编号或重复记录。`);
      keys.add(key);
    }
  }
  const data = migrateImageIds(value.data as Backup["data"]);
  return validateBackup({ ...value, formatVersion: 8, data });
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || resolve(input) === resolve(output))
    throw new Error(
      "用法：npm run migrate:backup -- 旧备份.json 新备份.json；输出必须使用新文件。",
    );
  const converted = convertBackup(JSON.parse(await readFile(input, "utf8")));
  await writeFile(output, JSON.stringify(converted, null, 2), { flag: "wx" });
  process.stdout.write(`已转换为 v8 备份：${output}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
