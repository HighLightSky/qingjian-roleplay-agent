"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDownIcon,
  SlidersHorizontalIcon,
  RatioIcon,
} from "lucide-react";

export function GenerationSettings({
  resultKey,
  summary,
  children,
}: {
  resultKey: string | undefined;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!resultKey);
  const previous = useRef(resultKey);
  useEffect(() => {
    if (previous.current !== resultKey) {
      setOpen(!resultKey);
      previous.current = resultKey;
    }
  }, [resultKey]);
  return (
    <details
      data-testid="generation-settings"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group/settings border-t border-border/70"
    >
      <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 py-3 text-sm [&::-webkit-details-marker]:hidden">
        <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">调整设置</span>
        <span className="ml-auto text-xs text-muted-foreground">{summary}</span>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-open/settings:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="grid min-w-0 gap-5 pb-2 pt-1">{children}</div>
    </details>
  );
}

export function ImageDimensions({
  width,
  height,
  alignment,
  disabled,
  onWidthChange,
  onHeightChange,
}: {
  width: string;
  height: string;
  alignment: number;
  disabled: boolean;
  onWidthChange(value: string): void;
  onHeightChange(value: string): void;
}) {
  const valid = [width, height].every(
    (value) =>
      value.trim() && Number.isSafeInteger(Number(value)) && Number(value) > 0,
  );
  const actualWidth = Math.ceil(Number(width) / alignment) * alignment;
  const actualHeight = Math.ceil(Number(height) / alignment) * alignment;
  return (
    <div className="grid gap-2">
      <span className="flex items-center gap-2 text-sm font-medium">
        <RatioIcon className="size-4 text-muted-foreground" />
        画幅
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          宽
          <input
            aria-label="画面宽度"
            type="number"
            min="1"
            value={width}
            disabled={disabled}
            onChange={(e) => onWidthChange(e.target.value)}
            className="h-9 w-24 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-ring"
          />
        </label>
        <span className="text-muted-foreground" aria-hidden>
          ×
        </span>
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          高
          <input
            aria-label="画面高度"
            type="number"
            min="1"
            value={height}
            disabled={disabled}
            onChange={(e) => onHeightChange(e.target.value)}
            className="h-9 w-24 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-ring"
          />
        </label>
      </div>
      {!valid ? (
        <p className="text-xs text-destructive">宽高必须为正整数。</p>
      ) : (
        (actualWidth !== Number(width) || actualHeight !== Number(height)) && (
          <p className="text-xs text-muted-foreground">
            实际输出尺寸：{actualWidth} × {actualHeight}
          </p>
        )
      )}
    </div>
  );
}
