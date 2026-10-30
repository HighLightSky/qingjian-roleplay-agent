"use client";

import { useId } from "react";
import {
  AccessibilityIcon,
  CheckIcon,
  ChevronDownIcon,
  Loader2Icon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import type { SceneDraft, PoseLibrary } from "@/lib/scene-images/types";
import {
  selectScenePose,
  withPoseLibrary,
  withPoseQuery,
} from "@/lib/scene-images/draft";

export function PoseControls({
  draft,
  disabled,
  canEdit,
  onChange,
  onSearch,
  onEdit,
  onReset,
}: {
  draft: SceneDraft;
  disabled: boolean;
  canEdit: boolean;
  onChange(draft: SceneDraft): void;
  onSearch(): void;
  onEdit(): void;
  onReset(): void;
}) {
  const group = useId();
  const searching = draft.poseSearch.status === "searching";
  return (
    <section
      aria-label="姿势参考"
      className="grid min-w-0 gap-3 border-t border-border/60 pt-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <AccessibilityIcon className="size-4 text-muted-foreground" />
        <label className="mr-auto flex min-h-9 cursor-pointer items-center gap-2 text-sm font-medium">
          姿势参考
          <span className="relative inline-flex h-5 w-9 shrink-0">
            <input
              type="checkbox"
              role="switch"
              aria-label="使用姿势参考"
              checked={draft.poseEnabled}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...draft, poseEnabled: e.target.checked })
              }
              className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0"
            />
            <span
              aria-hidden
              className="pointer-events-none relative h-5 w-9 rounded-full bg-muted-foreground/30 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-background after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50 motion-reduce:transition-none motion-reduce:after:transition-none"
            />
          </span>
        </label>
        {draft.poseEnabled && (
          <>
            <select
              aria-label="动作库检索范围"
              value={draft.poseLibrary}
              disabled={disabled}
              onChange={(e) =>
                onChange(withPoseLibrary(draft, e.target.value as PoseLibrary))
              }
              className="h-9 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-ring"
            >
              <option value="default">原有库 · 136</option>
              <option value="mixamo">Mixamo · 420</option>
              <option value="all">全部 · 556</option>
            </select>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || searching || !draft.poseQuery.trim()}
              onClick={onSearch}
            >
              {searching ? (
                <Loader2Icon className="animate-spin motion-reduce:animate-none" />
              ) : (
                <SearchIcon />
              )}
              重新检索
            </Button>
          </>
        )}
      </div>
      {draft.poseEnabled && (
        <>
          <textarea
            aria-label="姿态检索描述"
            rows={3}
            placeholder="描述动作、四肢位置、支撑关系和朝向…"
            value={draft.poseQuery}
            disabled={disabled}
            onChange={(e) => onChange(withPoseQuery(draft, e.target.value))}
            className="min-h-20 w-full resize-y rounded-md border border-input bg-background p-3 text-sm leading-relaxed focus-visible:outline-ring"
          />
          <div aria-live="polite" className="empty:hidden">
            {searching && (
              <p role="status" className="text-xs text-muted-foreground">
                正在检索姿势…
              </p>
            )}
            {draft.poseSearch.status === "failed" && (
              <p role="alert" className="break-words text-sm text-destructive">
                {draft.poseSearch.error}
              </p>
            )}
            {draft.poseSearch.status === "succeeded" &&
              !draft.poseSearch.matches.length && (
                <p className="text-xs text-muted-foreground">
                  没有姿势候选，请修改描述后重新检索。
                </p>
              )}
          </div>
          <div
            role="radiogroup"
            aria-label="姿势候选"
            className="grid gap-2 empty:hidden"
          >
            {draft.poseSearch.matches.map((match) => {
              const selected = draft.poseSearch.selectedPoseId === match.poseId;
              return (
                <div
                  key={match.poseId}
                  className={`min-w-0 rounded-md border transition-colors ${selected ? "border-primary/60 bg-primary/5" : "border-border/70 hover:bg-muted/40"}`}
                >
                  <label className="flex cursor-pointer items-start gap-3 p-3">
                    <input
                      type="radio"
                      name={group}
                      aria-label={`选择姿势 ${match.description.zh}`}
                      checked={selected}
                      disabled={disabled}
                      onChange={() =>
                        onChange(selectScenePose(draft, match.poseId))
                      }
                      className="mt-1 accent-primary"
                    />
                    <span className="line-clamp-3 min-w-0 flex-1 break-words text-sm leading-relaxed">
                      {match.description.zh}
                    </span>
                    {selected && (
                      <CheckIcon
                        aria-hidden
                        className="mt-0.5 size-4 shrink-0 text-primary"
                      />
                    )}
                  </label>
                  <details className="group/candidate px-3 pb-2 pl-10">
                    <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
                      详情
                      <ChevronDownIcon className="size-3 group-open/candidate:rotate-180" />
                    </summary>
                    <div className="grid gap-2 pb-1 text-xs leading-relaxed text-muted-foreground">
                      <p className="break-words text-foreground">
                        {match.description.zh}
                      </p>
                      <p className="break-words">{match.description.en}</p>
                      <span title="余弦相似度，越大越相近，不代表置信概率">
                        相似度 {match.score.toFixed(3)}
                      </span>
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
          {draft.poseSearch.selectedPoseId && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || !canEdit}
                onClick={onEdit}
              >
                <PencilIcon />
                编辑姿势
              </Button>
              {draft.poseEdit && (
                <>
                  <span className="rounded bg-primary/10 px-2 py-1 text-xs text-primary">
                    已编辑
                  </span>
                  <TooltipIconButton
                    tooltip="恢复检索姿势"
                    aria-label="恢复检索姿势"
                    disabled={disabled}
                    onClick={onReset}
                    className="size-9"
                  >
                    <RotateCcwIcon />
                  </TooltipIconButton>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
