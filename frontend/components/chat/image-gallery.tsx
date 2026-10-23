"use client";
import { useEffect, useState } from "react";
import { database } from "@/lib/db";
import { imageIds, type ImageAsset } from "@/lib/images/types";
import { imageSequence } from "@/lib/images/ids";
import { useImageUrl } from "@/hooks/use-image-url";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { report } from "@/stores/use-app-store";

type Metadata = Omit<ImageAsset, "originalBlob" | "thumbnailBlob">;
function Tile({ asset, select }: { asset: Metadata; select: () => void }) {
  const src = useImageUrl(asset.id, true);
  return (
    <button
      type="button"
      onClick={select}
      className="overflow-hidden rounded-md border text-left"
      aria-label={`查看 ${asset.displayName}`}
    >
      <img
        src={src}
        alt={asset.displayName}
        className="aspect-square w-full object-cover"
      />
      <p className="truncate p-1 text-xs">{asset.displayName}</p>
    </button>
  );
}
function Preview({ asset }: { asset: Metadata }) {
  const src = useImageUrl(asset.id);
  const [sources, setSources] = useState<string[]>([]);
  useEffect(() => {
    let disposed = false;
    void database()
      .then(async (db) => {
        const tx = db.transaction([
          "sessions",
          "messages",
          "drafts",
          "characters",
          "settings",
        ]);
        const [sessions, messages, drafts, characters, settings] =
          await Promise.all([
            tx.objectStore("sessions").getAll(),
            tx.objectStore("messages").getAll(),
            tx.objectStore("drafts").getAll(),
            tx.objectStore("characters").getAll(),
            tx.objectStore("settings").getAll(),
          ]);
        await tx.done;
        const names = new Map(sessions.map((s) => [s.id, s.title]));
        const result = messages
          .filter((m) => imageIds(m.parts).includes(asset.id))
          .map((m) => `${names.get(m.sessionId) ?? "会话"} · 消息 ${m.seq}`);
        drafts
          .filter((d) => imageIds(d.parts).includes(asset.id))
          .forEach((d) =>
            result.push(`${names.get(d.sessionId) ?? "会话"} · 草稿`),
          );
        drafts
          .filter((d) => imageIds(d.edit?.parts).includes(asset.id))
          .forEach((d) =>
            result.push(`${names.get(d.sessionId) ?? "会话"} · 编辑草稿`),
          );
        for (const c of characters)
          if (c.appearancePhotoAssetId === asset.id)
            result.push(`${c.name} · 角色形象照片 v${c.profileVersion}`);
        for (const session of sessions)
          if (session.characterSnapshot.appearancePhotoAssetId === asset.id)
            result.push(
              `${session.title} · 会话形象照片 v${session.profileVersion}`,
            );
        for (const row of settings)
          if (
            row.key.startsWith("characterDraft:") &&
            JSON.parse(row.value).appearancePhotoAssetId === asset.id
          )
            result.push("角色编辑草稿 · 形象照片");
        if (!disposed) setSources(result);
      })
      .catch(report);
    return () => {
      disposed = true;
    };
  }, [asset.id]);
  return (
    <>
      <DialogTitle>{asset.displayName}</DialogTitle>
      <DialogDescription>
        {asset.width} × {asset.height} ·{" "}
        {(asset.byteSize / 1024 / 1024).toFixed(2)} MiB
      </DialogDescription>
      <img
        src={src}
        alt={asset.displayName}
        className="max-h-[60dvh] w-full object-contain"
      />
      <p className="max-h-24 overflow-y-auto whitespace-pre-line text-xs text-muted-foreground">
        {sources.join("\n") || "保存在本地数据库"}
      </p>
    </>
  );
}
export function ImageGallery() {
  const [page, setPage] = useState(0);
  const [assets, setAssets] = useState<Metadata[]>([]);
  const [stats, setStats] = useState({ count: 0, bytes: 0 });
  const [selected, setSelected] = useState<Metadata>();
  useEffect(() => {
    let disposed = false;
    void database()
      .then(async (db) => {
        const tx = db.transaction("assets");
        let cursor = await tx.store.openCursor();
        let count = 0,
          bytes = 0;
        const values: Metadata[] = [];
        while (cursor) {
          const { originalBlob, thumbnailBlob, ...meta } = cursor.value;
          values.push(meta);
          count++;
          bytes += meta.byteSize;
          cursor = await cursor.continue();
        }
        await tx.done;
        if (!disposed) {
          values.sort((a, b) => imageSequence(a.id) - imageSequence(b.id));
          setAssets(values.slice(page * 12, (page + 1) * 12));
          setStats({ count, bytes });
        }
      })
      .catch(report);
    return () => {
      disposed = true;
    };
  }, [page]);
  return (
    <section className="border-t pt-5">
      <h3 className="text-sm font-medium">图片</h3>
      <p className="my-2 text-xs text-muted-foreground">
        {stats.count} 张 · 原图 {(stats.bytes / 1024 / 1024).toFixed(2)} MiB
      </p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {assets.map((asset) => (
          <Tile
            key={asset.id}
            asset={asset}
            select={() => setSelected(asset)}
          />
        ))}
      </div>
      {stats.count > 12 && (
        <div className="mt-2 flex items-center justify-between">
          <Button
            size="sm"
            variant="outline"
            disabled={!page}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </Button>
          <span className="text-xs">
            {page + 1} / {Math.ceil(stats.count / 12)}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={(page + 1) * 12 >= stats.count}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </div>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          {selected && <Preview key={selected.id} asset={selected} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
