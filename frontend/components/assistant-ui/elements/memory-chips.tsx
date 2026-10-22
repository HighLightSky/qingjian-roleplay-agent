"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { field } from "./surfaces";

// 基于 assistant-ui standalone MemoryChips，适配主题色、中文标题与只读展示。
export interface MemoryChip {
  id: string;
  text: string;
  change: "added" | "updated" | "existing";
}

export function MemoryChips({
  chips,
  label,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  chips: readonly MemoryChip[];
  label?: ReactNode;
}) {
  return (
    <div
      data-slot="memory-chips"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    >
      {label && <div className="text-xs text-muted-foreground">{label}</div>}
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <span
            key={chip.id}
            className={cn(
              "animate-in fade-in zoom-in-95 fill-mode-both max-w-full rounded-full px-2.5 py-1 text-xs leading-5 [overflow-wrap:anywhere] duration-300 motion-reduce:animate-none",
              chip.change === "existing"
                ? cn(field, "text-muted-foreground")
                : "bg-primary/10 text-primary",
            )}
          >
            {chip.text}
          </span>
        ))}
      </div>
    </div>
  );
}
