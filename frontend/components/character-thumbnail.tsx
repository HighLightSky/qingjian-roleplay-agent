"use client";

import { LeafIcon } from "lucide-react";
import { useImageUrl } from "@/hooks/use-image-url";
import { cn } from "@/lib/utils";

export function CharacterThumbnail({
  assetId,
  name,
  className,
}: {
  assetId?: string;
  name: string;
  className?: string;
}) {
  const { url: src, missing } = useImageUrl(assetId, true);
  if (!assetId)
    return (
      <LeafIcon
        aria-hidden
        className={cn("size-8 shrink-0 text-primary", className)}
      />
    );
  return (
    <span
      title={missing ? `角色照片 ${assetId} 原件缺失，已跳过` : undefined}
      aria-label={missing ? `角色照片 ${assetId} 原件缺失，已跳过` : undefined}
      className={cn(
        "size-8 shrink-0 overflow-hidden rounded-full border bg-muted",
        className,
      )}
    >
      {missing && (
        <span className="flex h-full items-center justify-center text-xs text-destructive">
          缺图
        </span>
      )}
      {src && (
        <img
          src={src}
          alt={`${name}的形象缩略图`}
          className="size-full object-cover"
        />
      )}
    </span>
  );
}
