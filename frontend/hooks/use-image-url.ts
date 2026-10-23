"use client";
import { useEffect, useState } from "react";
import { database } from "@/lib/db";
import { report, useAppStore } from "@/stores/use-app-store";
export function useImageUrl(assetId: string | undefined, thumbnail = false) {
  const [entry, setEntry] = useState<{
    key: string;
    url?: string;
    missing: boolean;
  }>();
  const knownMissing = useAppStore(
    (state) => !!assetId && state.missingImages.includes(assetId),
  );
  const key = `${assetId}:${thumbnail}`;
  useEffect(() => {
    if (!assetId) return;
    let disposed = false;
    let url: string | undefined;
    void database()
      .then((db) => db.get("assets", assetId))
      .then((asset) => {
        if (disposed) return;
        if (!asset) {
          setEntry({ key, missing: true });
          return;
        }
        url = URL.createObjectURL(
          thumbnail
            ? (asset.thumbnailBlob ?? asset.originalBlob)
            : asset.originalBlob,
        );
        setEntry({ key, url, missing: false });
      })
      .catch((error) => {
        if (!disposed) report(error);
      });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [assetId, thumbnail, key, knownMissing]);
  return entry?.key === key ? entry : { url: undefined, missing: false };
}
