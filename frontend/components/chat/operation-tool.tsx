"use client";
import type { ReactNode } from "react";
import {
  BookOpenIcon,
  BrainIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockIcon,
  FlagIcon,
  PauseIcon,
  TriangleAlertIcon,
  ChevronRightIcon,
  type LucideIcon,
} from "lucide-react";
import {
  GoalDetails,
  GoalStatus,
  MemoryMeta,
  StateTag,
  StoryValue,
} from "./state-presentation";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import {
  ToolGroupRoot,
  ToolGroupTrigger,
  ToolGroupContent,
} from "@/components/assistant-ui/elements/tool-group.aui";
import {
  useAppStore,
  recoverStateTasks,
  recoverCompactionTasks,
  retryLastMessage,
  report,
} from "@/stores/use-app-store";
import { SourceLinks } from "./source-links";
import {
  STORY_LABELS,
  type Change,
  type Story,
  type StateResult,
  type SelectionResult,
  type Operation,
  type MemoryValue,
  type GoalValue,
} from "@/lib/state/types";
import { useImageUrl } from "@/hooks/use-image-url";
import { Button } from "@/components/ui/button";
import {
  messageSourceIds,
  photoSources,
  type VisualSource,
} from "@/lib/images/types";
import type { CompactionResult } from "@/lib/context/types";

function Picture({ id }: { id: string }) {
  const url = useImageUrl(id, true);
  return url ? (
    <img
      src={url}
      alt="参考原图"
      className="my-2 size-20 rounded border object-contain"
    />
  ) : (
    <span role="status">正在读取图片…</span>
  );
}
function summary(op: Operation) {
  const label =
    op.kind === "selection"
      ? "选择历史图片"
      : op.kind === "compaction"
        ? "压缩较早剧情"
        : "整理视觉、剧情、记忆与目标";
  if (op.status === "pending") return `${label}：等待执行`;
  if (op.status === "running") return `${label}：正在请求`;
  if (op.status === "computed")
    return `${label}：${op.error ? "保存失败，待重试" : "正在保存"}`;
  if (op.status === "cancelled") return `${label}：已停止`;
  if (op.status === "stale") return `${label}：结果已过期`;
  if (op.status === "failed")
    return op.kind === "state_update"
      ? "正文已保存，整理待重试"
      : op.kind === "compaction"
        ? "压缩未完成，待重试"
        : "选图未完成";
  if (op.kind === "compaction") {
    const result = op.result as CompactionResult;
    return `已压缩较早剧情：${result.beforeTokens.toLocaleString()} → ${result.afterTokens.toLocaleString()} token`;
  }
  if (op.kind === "selection") {
    const { plan } = op.result as SelectionResult;
    return plan.selectedHistoricalImages.length
      ? `已选择 ${plan.selectedHistoricalImages.length} 张历史图片`
      : "本轮无需历史图";
  }
  const r = op.result as StateResult;
  const counts = [
    r.storyChanges.length ? `剧情 ${r.storyChanges.length} 项` : "",
    r.memoryChanges.length ? `记忆 ${r.memoryChanges.length} 项` : "",
    r.goalChanges.length ? `目标 ${r.goalChanges.length} 项` : "",
  ].filter(Boolean);
  return counts.length
    ? `已更新：${counts.join("，")}`
    : `已检查，剧情、记忆和目标无变化${r.visualObservations.length ? `；已记录 ${r.visualObservations.length} 张图片` : ""}`;
}
function SelectionDetails({ result }: { result: SelectionResult }) {
  const ids = new Set([
    ...result.plan.selectedHistoricalImages.map((s) => s.assetId),
    ...result.plan.candidateAssetIds,
  ]);
  return (
    <div className="space-y-3">
      {result.plan.message && <p>{result.plan.message}</p>}
      {!ids.size && <p>根据本轮输入与已有视觉记录，无需重新读取历史原图。</p>}
      {result.catalog
        .filter((a) => ids.has(a.assetId))
        .map((asset) => (
          <article key={asset.assetId}>
            <Picture id={asset.assetId} />
            <p>
              {result.plan.selectedHistoricalImages.find(
                (s) => s.assetId === asset.assetId,
              )?.purpose ?? "待澄清候选图片"}
            </p>
            <VisualSources sources={asset.sources} />
          </article>
        ))}
    </div>
  );
}
function VisualSources({ sources }: { sources: VisualSource[] }) {
  return (
    <>
      {photoSources(sources).map((s) => (
        <p key={s.characterId} className="text-xs text-muted-foreground">
          角色形象照片 · 资料 v{s.profileVersion}
        </p>
      ))}
      <SourceLinks ids={messageSourceIds(sources)} />
    </>
  );
}
function ChangeGroup<T>({
  label,
  Icon,
  changes,
  title,
  render,
}: {
  label: string;
  Icon: LucideIcon;
  changes: Change<T>[];
  title: (change: Change<T>) => string;
  render: (value: T, change: Change<T>) => ReactNode;
}) {
  if (!changes.length) return null;
  return (
    <section className="space-y-3" aria-label={`${label}变更`}>
      <h4 className="flex items-center gap-2 text-sm font-medium">
        <Icon aria-hidden="true" className="size-4 text-primary" />
        {label}
        <span className="text-xs font-normal text-muted-foreground">
          {changes.length} 项
        </span>
      </h4>
      <div className="divide-y divide-border/60">
        {changes.map((change) => (
          <article
            key={change.id}
            data-state-change={change.id}
            className="space-y-2.5 py-4 first:pt-0 last:pb-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h5 className="text-xs font-medium text-muted-foreground">
                {title(change)}
              </h5>
              <StateTag>
                {change.action === "create" ? "新增" : "更新"}
              </StateTag>
            </div>
            <div
              data-slot="change-current"
              className="space-y-2 border-l-2 border-primary/40 bg-primary/5 px-3 py-2.5 text-sm leading-7 [overflow-wrap:anywhere]"
            >
              {render(change.value, change)}
            </div>
            <p className="text-xs leading-6 text-muted-foreground">
              依据：{change.reason}
            </p>
            {change.action === "update" && (
              <details className="group/before text-xs text-muted-foreground">
                <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1 rounded px-1 outline-offset-2 hover:bg-primary/5 hover:text-primary focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
                  <ChevronRightIcon
                    aria-hidden="true"
                    className="size-3 transition-transform group-open/before:rotate-90 motion-reduce:transition-none"
                  />
                  查看原内容
                </summary>
                <div
                  data-slot="change-before"
                  className="mt-1 space-y-2 border-l border-border pl-3 text-sm leading-7 [overflow-wrap:anywhere]"
                >
                  {render(change.before!, change)}
                </div>
              </details>
            )}
            <SourceLinks ids={change.sourceMessageIds} />
          </article>
        ))}
      </div>
    </section>
  );
}

function MemoryContent({ value }: { value: MemoryValue }) {
  return (
    <>
      <p className="whitespace-pre-wrap">{value.content}</p>
      <MemoryMeta value={value} />
    </>
  );
}

function GoalContent({ value }: { value: GoalValue }) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 whitespace-pre-wrap font-medium">
          {value.description}
        </p>
        <GoalStatus status={value.status} />
      </div>
      <GoalDetails value={value} />
    </>
  );
}

function StateDetails({ result }: { result: StateResult }) {
  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        已检查消息范围：{result.fromExclusiveSeq + 1}—{result.throughSeq}
      </p>
      {result.visualObservations.length ? (
        <section className="space-y-3">
          <h4 className="font-medium">视觉观察</h4>
          {result.visualObservations.map((o) => (
            <article key={o.assetId} className="space-y-1">
              <Picture id={o.assetId} />
              <p>{o.summary}</p>
              <p>可见细节：{o.visibleDetails.join("；") || "无新增"}</p>
              <p>图片文字：{o.extractedText.join("；") || "无"}</p>
              <p>不确定项：{o.uncertainDetails.join("；") || "无"}</p>
              <VisualSources sources={o.sources} />
            </article>
          ))}
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">本轮未使用原图。</p>
      )}
      <ChangeGroup
        label="剧情"
        Icon={BookOpenIcon}
        changes={result.storyChanges}
        title={(change) => STORY_LABELS[change.id as keyof Story]}
        render={(value, change) => (
          <StoryValue field={change.id as keyof Story} value={value} />
        )}
      />
      <ChangeGroup
        label="记忆"
        Icon={BrainIcon}
        changes={result.memoryChanges}
        title={() => "记忆内容"}
        render={(value) => <MemoryContent value={value} />}
      />
      <ChangeGroup
        label="目标"
        Icon={FlagIcon}
        changes={result.goalChanges}
        title={() => "目标内容"}
        render={(value) => <GoalContent value={value} />}
      />
    </div>
  );
}

function OperationIcon({ operation }: { operation: Operation }) {
  const Icon =
    operation.error || operation.status === "failed"
      ? TriangleAlertIcon
      : operation.status === "committed"
        ? CircleCheckIcon
        : operation.status === "pending"
          ? ClockIcon
          : operation.status === "cancelled"
            ? PauseIcon
            : CircleDashedIcon;
  return (
    <Icon
      aria-hidden="true"
      className={`size-3.5 shrink-0 ${operation.error || operation.status === "failed" ? "text-destructive" : operation.status === "committed" ? "text-primary" : "text-muted-foreground"}`}
    />
  );
}

function UpdatedSummary({ result }: { result: StateResult }) {
  const counts = [
    ["剧情", result.storyChanges.length],
    ["记忆", result.memoryChanges.length],
    ["目标", result.goalChanges.length],
  ] as const;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1.5 py-0.5 leading-5">
      <span className="font-medium text-primary">已更新</span>
      {counts
        .filter(([, count]) => count > 0)
        .map(([label, count]) => (
          <StateTag key={label}>
            {label} {count}
          </StateTag>
        ))}
      <span className="text-xs text-muted-foreground group-data-open/trigger:hidden">
        展开
      </span>
      <span className="hidden text-xs text-muted-foreground group-data-open/trigger:inline">
        收起
      </span>
    </span>
  );
}

const AppOperation: ToolCallMessagePartComponent = (props) => {
  const operation = useAppStore((state) =>
    state.operations.find((o) => o.id === props.args.operationId),
  );
  const disabled = useAppStore(
    (state) =>
      state.readOnly ||
      !!state.activeSessionId ||
      (operation?.kind === "selection" &&
        state.messages.filter((m) => m.role === "assistant").at(-1)?.id !==
          operation.anchorMessageId),
  );
  if (!operation) throw new Error("过程投影缺少操作记录。");
  const latestState = useAppStore(
    (state) =>
      state.operations
        .filter((o) => o.kind === "state_update")
        .sort(
          (a, b) =>
            (state.messages.find((m) => m.id === a.anchorMessageId)?.seq ?? 0) -
            (state.messages.find((m) => m.id === b.anchorMessageId)?.seq ?? 0),
        )
        .at(-1)?.id,
  );
  const retryable =
    operation.kind !== "state_update" ||
    (operation.id === latestState && operation.status !== "stale");
  const active =
    ["pending", "running", "computed"].includes(operation.status) &&
    !operation.error;
  const updated =
    operation.kind === "state_update" &&
    operation.status === "committed" &&
    (operation.result as StateResult).storyChanges.length +
      (operation.result as StateResult).memoryChanges.length +
      (operation.result as StateResult).goalChanges.length >
      0;
  const operationSummary = summary(operation);
  return (
    <ToolGroupRoot variant="ghost" data-operation={operation.kind}>
      <ToolGroupTrigger
        count={1}
        active={active}
        label={operationSummary}
        aria-label={operationSummary}
        icon={<OperationIcon operation={operation} />}
        className="max-w-full rounded-md px-1 text-left hover:bg-primary/5 [&_[data-slot=tool-group-trigger-label]]:min-w-0 [&_[data-slot=tool-group-trigger-label]]:leading-5"
      >
        {updated ? (
          <UpdatedSummary result={operation.result as StateResult} />
        ) : (
          operationSummary
        )}
      </ToolGroupTrigger>
      <ToolGroupContent>
        <div className="space-y-3 break-words py-3 text-sm leading-6">
          {operation.error && (
            <p role="alert" className="text-destructive">
              {operation.error}
            </p>
          )}
          {operation.result &&
            (operation.kind === "selection" ? (
              <SelectionDetails result={operation.result as SelectionResult} />
            ) : operation.kind === "compaction" ? (
              <div className="space-y-2">
                <p>
                  摘要覆盖至消息{" "}
                  {(operation.result as CompactionResult).throughSeq}
                  ；原始聊天记录继续保存在本地。
                </p>
                <p className="whitespace-pre-wrap">
                  {(operation.result as CompactionResult).summary.text}
                </p>
                <SourceLinks
                  ids={(operation.result as CompactionResult).sourceMessageIds}
                />
              </div>
            ) : (
              <StateDetails result={operation.result as StateResult} />
            ))}
          {!active && operation.status !== "committed" && retryable && (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() =>
                void (
                  operation.kind === "compaction"
                    ? recoverCompactionTasks(operation.id)
                    : operation.kind === "state_update"
                      ? recoverStateTasks(operation.id)
                      : retryLastMessage()
                ).catch(report)
              }
            >
              重试此步骤
            </Button>
          )}
        </div>
      </ToolGroupContent>
    </ToolGroupRoot>
  );
};
export const OperationTool: ToolCallMessagePartComponent = (props) =>
  ["selection", "state_update", "compaction"].includes(props.toolName) ? (
    <AppOperation {...props} />
  ) : (
    <ToolFallback {...props} />
  );
