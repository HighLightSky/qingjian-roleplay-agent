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
  const src = useImageUrl(assetId, true);
  if (!assetId)
    return (
      <LeafIcon
        aria-hidden
        className={cn("size-8 shrink-0 text-primary", className)}
      />
    );
  return (
    <span
      className={cn(
        "size-8 shrink-0 overflow-hidden rounded-full border bg-muted",
        className,
      )}
    >
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
