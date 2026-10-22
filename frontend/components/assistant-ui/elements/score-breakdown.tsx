"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/data-usage";
import { field } from "./surfaces";

export type StorageCriterion = {
  id: string;
  label: string;
  bytes: number;
  note: ReactNode;
};

// 基于 assistant-ui Score Breakdown 官方 standalone 源码，使用容量与占比代替评分和权重。
// https://www.assistant-ui.com/elements/score-breakdown
export function ScoreBreakdown({
  total,
  label,
  summary,
  criteria,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  total: number;
  label: string;
  summary: ReactNode;
  criteria: readonly StorageCriterion[];
}) {
  return (
    <div
      data-slot="score-breakdown"
      className={cn("flex min-w-0 flex-col gap-5", className)}
      {...props}
    >
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl font-semibold tracking-tight tabular-nums">
            {formatBytes(total)}
          </span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {summary}
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {criteria.map((criterion) => {
          const percent = total === 0 ? 0 : (criterion.bytes / total) * 100;
          const value = formatBytes(criterion.bytes);
          return (
            <div
              key={criterion.id}
              data-slot="storage-criterion"
              className="min-w-0"
            >
              <div className="mb-2 flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                  {criterion.label}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {value}
                  <span className="ml-2 text-xs">{percent.toFixed(1)}%</span>
                </span>
              </div>
              <div
                role="meter"
                aria-label={criterion.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={`${value}，占 ${percent.toFixed(1)}%`}
                className={cn(field, "h-1.5 overflow-hidden rounded-full")}
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                {criterion.note}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
