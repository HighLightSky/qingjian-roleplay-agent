"use client";
import { useEffect, useState } from "react";
import { database } from "@/lib/db";
export function useImageUrl(assetId: string | undefined, thumbnail = false) {
  const [entry, setEntry] = useState<{ key: string; url: string }>();
  const key = `${assetId}:${thumbnail}`;
  useEffect(() => {
    if (!assetId) return;
    let disposed = false;
    let url: string | undefined;
    void database()
      .then((db) => db.get("assets", assetId))
      .then((asset) => {
        if (disposed || !asset) return;
        url = URL.createObjectURL(
          thumbnail
            ? (asset.thumbnailBlob ?? asset.originalBlob)
            : asset.originalBlob,
        );
        setEntry({ key, url });
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [assetId, thumbnail, key]);
  return entry?.key === key ? entry.url : undefined;
}
