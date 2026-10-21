"use client";
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
  retryLastMessage,
  report,
  loadEarlier,
  selectSession,
} from "@/stores/use-app-store";
import { database } from "@/lib/db";
import {
  STORY_LABELS,
  GOAL_LABELS,
  type StateResult,
  type SelectionResult,
  type Operation,
  type MemoryValue,
  type GoalValue,
} from "@/lib/state/types";
import { useImageUrl } from "@/hooks/use-image-url";
import { Button } from "@/components/ui/button";

async function showSource(messageId: string) {
  const message = await (await database()).get("messages", messageId);
  if (!message) throw new Error("来源消息已删除。");
  if (useAppStore.getState().sessionId !== message.sessionId)
    await selectSession(message.sessionId);
  while (
    useAppStore.getState().hasEarlier &&
    !useAppStore.getState().messages.some((m) => m.id === messageId)
  )
    await loadEarlier();
  requestAnimationFrame(() =>
    document
      .getElementById(`message:${messageId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" }),
  );
}
export function SourceLinks({ ids }: { ids: string[] }) {
  return (
    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
      {ids.map((id, i) => (
        <button
          key={id}
          type="button"
          className="underline underline-offset-2"
          onClick={() => void showSource(id).catch(report)}
        >
          来源消息 {i + 1}
        </button>
      ))}
    </div>
  );
}
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
function describe(value: unknown): string {
  if (value === null) return "无";
  if (typeof value === "string") return value || "未记录";
  if (Array.isArray(value)) return value.join("；") || "无";
  if (value && typeof value === "object") {
    if ("content" in value) {
      const m = value as MemoryValue;
      const kind = {
        fact: "事实",
        preference: "偏好",
        agreement: "约定",
        event: "关键经历",
      }[m.kind];
      const epistemic = {
        established: "已确认",
        claim: "陈述",
        hypothesis: "推测",
      }[m.epistemicStatus];
      const status = {
        active: "有效",
        superseded: "已替代",
        dismissed: "已删除",
      }[m.status];
      return `${m.content}\n使用范围：${m.scope === "character" ? "角色共享" : "当前会话"}；类型：${kind}；事实类别：${epistemic}；状态：${status}`;
    }
    const g = value as GoalValue;
    const phases = {
      discovered: "已发现",
      in_progress: "进行中",
      completed: "已完成",
      discarded: "已排除",
    };
    return `${g.description}\n状态：${GOAL_LABELS[g.status]}；当前关注：${g.currentFocus || "无"}\n线索：${g.clues.join("；") || "无"}\n阶段：${g.milestones.map((m) => `${m.description}（${phases[m.status]}）`).join("；") || "无"}\n阻碍：${g.blockers.join("；") || "无"}`;
  }
  throw new Error("整理结果包含无效的领域值。");
}
function summary(op: Operation) {
  const label =
    op.kind === "selection" ? "选择历史图片" : "整理视觉、剧情、记忆与目标";
  if (op.status === "pending") return `${label}：等待执行`;
  if (op.status === "running") return `${label}：正在请求`;
  if (op.status === "computed")
    return `${label}：${op.error ? "保存失败，待重试" : "正在保存"}`;
  if (op.status === "cancelled") return `${label}：已停止`;
  if (op.status === "stale") return `${label}：结果已过期`;
  if (op.status === "failed")
    return op.kind === "state_update" ? "正文已保存，整理待重试" : "选图未完成";
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
            <SourceLinks ids={asset.sources.map((s) => s.messageId)} />
          </article>
        ))}
    </div>
  );
}
function StateDetails({ result }: { result: StateResult }) {
  const groups = [
    ["剧情", result.storyChanges],
    ["记忆", result.memoryChanges],
    ["目标", result.goalChanges],
  ] as const;
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        已检查消息范围：{result.fromExclusiveSeq + 1}—{result.throughSeq}
      </p>
      <section>
        <h4 className="font-medium">视觉观察</h4>
        {!result.visualObservations.length && <p>本轮未使用原图。</p>}
        {result.visualObservations.map((o) => (
          <article key={o.assetId} className="mt-2 space-y-1">
            <Picture id={o.assetId} />
            <p>{o.summary}</p>
            <p>可见细节：{o.visibleDetails.join("；") || "无新增"}</p>
            <p>图片文字：{o.extractedText.join("；") || "无"}</p>
            <p>不确定项：{o.uncertainDetails.join("；") || "无"}</p>
            <SourceLinks ids={o.sourceMessageIds} />
          </article>
        ))}
      </section>
      {groups.map(([label, changes]) => (
        <section key={label}>
          <h4 className="font-medium">{label}</h4>
          {!changes.length && <p>无需更新。</p>}
          {changes.map((c) => (
            <article key={c.id} className="mt-2 space-y-1 rounded border p-2">
              {label === "剧情" && (
                <p>{STORY_LABELS[c.id as keyof typeof STORY_LABELS]}</p>
              )}
              <p className="whitespace-pre-wrap text-muted-foreground">
                原内容：{describe(c.before)}
              </p>
              <p className="whitespace-pre-wrap">新内容：{describe(c.value)}</p>

              <p>依据：{c.reason}</p>
              <SourceLinks ids={c.sourceMessageIds} />
            </article>
          ))}
        </section>
      ))}
    </div>
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
  const active =
    ["pending", "running", "computed"].includes(operation.status) &&
    !operation.error;
  return (
    <ToolGroupRoot variant="ghost" data-operation={operation.kind}>
      <ToolGroupTrigger count={1} active={active} label={summary(operation)} />
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
            ) : (
              <StateDetails result={operation.result as StateResult} />
            ))}
          {!active && operation.status !== "committed" && (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() =>
                void (
                  operation.kind === "state_update"
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
  props.toolName === "selection" || props.toolName === "state_update" ? (
    <AppOperation {...props} />
  ) : (
    <ToolFallback {...props} />
  );
