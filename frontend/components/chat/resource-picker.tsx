"use client";

import { useEffect, useState } from "react";
import { database } from "@/lib/db";
import type { ImageAsset } from "@/lib/images/types";
import { imageSequence } from "@/lib/images/ids";
import { useImageUrl } from "@/hooks/use-image-url";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Metadata = Omit<ImageAsset, "originalBlob" | "thumbnailBlob">;
function Resource({
  asset,
  checked,
  disabled,
  toggle,
}: {
  asset: Metadata;
  checked: boolean;
  disabled: boolean;
  toggle: () => void;
}) {
  const { url } = useImageUrl(asset.id, true);
  return (
    <label className="relative min-w-0 cursor-pointer overflow-hidden rounded border p-2 has-checked:border-primary">
      <input
        type="checkbox"
        aria-label={`选择 ${asset.id}`}
        checked={checked}
        disabled={disabled}
        onChange={toggle}
      />
      <img
        src={url}
        alt={asset.displayName}
        className="aspect-square w-full object-contain"
      />
      <p className="truncate text-xs">
        {asset.id} · {asset.displayName}
      </p>
    </label>
  );
}

export function ResourcePicker({
  open,
  onOpenChange,
  excluded,
  limit,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excluded: string[];
  limit: number;
  onSelect: (ids: string[]) => Promise<void>;
}) {
  const [assets, setAssets] = useState<Metadata[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setSelected([]);
    setPage(0);
    setError("");
    void database()
      .then(async (db) => {
        const values: Metadata[] = [];
        const tx = db.transaction("assets");
        let cursor = await tx.store.openCursor();
        while (cursor) {
          const { originalBlob, thumbnailBlob, ...meta } = cursor.value;
          values.push(meta);
          cursor = await cursor.continue();
        }
        await tx.done;
        if (live)
          setAssets(
            values.sort((a, b) => imageSequence(b.id) - imageSequence(a.id)),
          );
      })
      .catch((e) => {
        if (live) setError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [open]);
  const available = assets.filter((asset) => !excluded.includes(asset.id));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>浏览器资源库</DialogTitle>
        <DialogDescription>
          选择参考图片，还可添加 {limit} 张。按点击顺序加入。
        </DialogDescription>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {!available.length && (
          <p className="text-sm text-muted-foreground">没有可添加的图片。</p>
        )}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {available.slice(page * 12, (page + 1) * 12).map((asset) => (
            <Resource
              key={asset.id}
              asset={asset}
              checked={selected.includes(asset.id)}
              disabled={
                busy ||
                (!selected.includes(asset.id) && selected.length >= limit)
              }
              toggle={() =>
                setSelected((current) =>
                  current.includes(asset.id)
                    ? current.filter((id) => id !== asset.id)
                    : [...current, asset.id],
                )
              }
            />
          ))}
        </div>
        <div className="flex justify-between">
          <Button
            variant="ghost"
            disabled={!page || busy}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </Button>
          <Button
            variant="ghost"
            disabled={(page + 1) * 12 >= available.length || busy}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </div>
        <DialogFooter>
          <Button
            disabled={busy || !selected.length}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onSelect(selected);
                onOpenChange(false);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            添加所选图片（{selected.length}）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
