"use client";

import { useState, type PropsWithChildren } from "react";
import { DownloadIcon } from "lucide-react";
import {
  Dialog,
  DialogTitle,
  DialogDescription,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function ImagePreviewDialog({
  children,
  src,
  name,
}: PropsWithChildren<{ src: string | undefined; name: string }>) {
  const [loaded, setLoaded] = useState(false);
  if (!src) return children;
  return (
    <Dialog>
      <DialogTrigger
        className="aui-attachment-preview-trigger cursor-zoom-in"
        asChild
      >
        {children}
      </DialogTrigger>
      <DialogContent className="aui-attachment-preview-dialog-content p-2 sm:max-w-3xl">
        <DialogTitle className="sr-only">查看图片 {name}</DialogTitle>
        <DialogDescription className="sr-only">
          图片预览，可下载原图到本地。
        </DialogDescription>
        <div className="aui-attachment-preview relative mx-auto flex max-h-[75dvh] w-full items-center justify-center overflow-hidden rounded-sm bg-background">
          <img
            src={src}
            alt={`图片 ${name}`}
            className={cn(
              "block h-auto max-h-[75dvh] w-auto max-w-full rounded-sm object-contain transition-opacity motion-reduce:transition-none",
              loaded ? "opacity-100" : "opacity-0",
            )}
            onLoad={() => setLoaded(true)}
          />
        </div>
        <a
          href={src}
          download={name}
          className="m-2 inline-flex w-fit items-center gap-2 text-sm text-primary"
        >
          <DownloadIcon className="size-4" />
          下载图片
        </a>
      </DialogContent>
    </Dialog>
  );
}
