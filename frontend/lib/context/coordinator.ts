import { database, allMessages, atomic } from "../db";
import { chatContext, type ChatContext } from "../chat/context";
import { apiJson, buildCatalog } from "../images/coordinator";
import { capabilities } from "../images/repository";
import { imageIds, type Commit } from "../images/types";
import { id, now, errorText } from "../domain";
import type { Operation } from "../state/types";
import type { CompactionResult, CompactionTask, ContextBudget } from "./types";
import { validateBudget, validateCompaction } from "./validation";

export async function imageMetadata(context: ChatContext) {
  const db = await database();
  return Promise.all(
    imageIds(context.input.parts).map(async (assetId) => {
      const asset = await db.get("assets", assetId);
      if (!asset) throw new Error("上下文预算缺少本轮图片原件。");
      return { assetId, width: asset.width, height: asset.height };
    }),
  );
}

export async function inspectBudget(
  context: ChatContext,
  mode: "preview" | "required" | "final",
  signal: AbortSignal,
) {
  const result = await apiJson<ContextBudget>(
    "/api/context/budget",
    {
      context,
      mode,
      images: await imageMetadata(context),
    },
    signal,
  );
  validateBudget(result);
  return result;
}

async function refreshContext(task: CompactionTask): Promise<ChatContext> {
  const db = await database();
  const session = await db.get("sessions", task.sessionId);
  const assistant = await db.get("messages", task.assistantMessageId);
  if (!session || !assistant) throw new Error("压缩任务的会话或锚点消息缺失。");
  const user = await db.get("messages", assistant.replyToMessageId!);
  const character = await db.get("characters", session.characterId);
  if (!user || !character) throw new Error("压缩任务的用户消息或角色缺失。");
  const [memories, goals, rows] = await Promise.all([
    db.getAllFromIndex("memories", "character", character.id),
    db.getAllFromIndex("goals", "session", session.id),
    allMessages(session.id),
  ]);
  const history = rows.filter((m) => m.seq < user.seq);
  const context: ChatContext = chatContext(
    character,
    session,
    memories,
    history,
    task.context.input.text,
    task.context.interactionSettings,
    task.context.input.parts,
    goals,
    task.context.operationId,
  );
  context.visual = {
    sessionId: session.id,
    assetCatalog: await buildCatalog(session.id, history),
    plan: null,
    imagePayloads: [],
  };
  return context;
}

class StaleCompaction extends Error {}

export async function runCompactionTask(
  task: CompactionTask,
  signal: AbortSignal,
  commit: Commit,
  changed: () => Promise<void>,
  manual = false,
): Promise<void> {
  const db = await database();
  let operation = await db.get("operations", task.id);
  if (!operation) throw new Error("压缩任务缺少操作记录。");
  if (operation.status === "committed") return;
  try {
    signal.throwIfAborted();
    let result =
      operation.status === "computed"
        ? (operation.result as CompactionResult)
        : undefined;
    if (!result) {
      if (!manual && task.automaticAttempts >= 2)
        throw new Error("压缩自动重试次数已用完，请点击失败步骤重试。");
      const context = await refreshContext(task);
      task = {
        ...task,
        context,
        automaticAttempts: task.automaticAttempts + (manual ? 0 : 1),
        updatedAt: now(),
      };
      operation = {
        ...operation,
        status: "running",
        result: undefined,
        error: undefined,
        updatedAt: now(),
      };
      await commit(async () => {
        signal.throwIfAborted();
        const tx = db.transaction(
          ["operations", "compactionTasks"],
          "readwrite",
        );
        await atomic(tx, async () => {
          await tx.objectStore("operations").put(operation!);
          await tx.objectStore("compactionTasks").put(task);
        });
      });
      await changed();
      result = await apiJson<CompactionResult>(
        "/api/context/compact",
        { operationId: task.id, context },
        signal,
      );
      signal.throwIfAborted();
      validateCompaction(result);
      const sources = context.history.filter(
        (m) => m.seq > result!.fromExclusiveSeq && m.seq <= result!.throughSeq,
      );
      if (
        result.operationId !== task.id ||
        result.sessionId !== task.sessionId ||
        result.baseSessionVersion !== context.state.sessionVersion ||
        result.baseMemoryVersion !== context.state.memoryVersion ||
        result.baseSummaryVersion !== context.summary.version ||
        result.fromExclusiveSeq !== context.summary.throughSeq ||
        sources.at(-1)?.seq !== result.throughSeq ||
        JSON.stringify(sources.map((m) => m.id)) !==
          JSON.stringify(result.sourceMessageIds)
      )
        throw new Error("压缩结果与请求快照或消息来源不一致。");
      operation = {
        ...operation,
        status: "computed",
        result,
        sourceVersions: context.history.map((m) => ({
          id: m.id,
          checkpointVersion: m.checkpointVersion,
        })),
        updatedAt: now(),
      };
      await commit(() => db.put("operations", operation!));
      await changed();
    }
    signal.throwIfAborted();
    await commit(async () => {
      signal.throwIfAborted();
      const tx = db.transaction(
        [
          "sessions",
          "characters",
          "messages",
          "visualObservations",
          "operations",
          "compactionTasks",
        ],
        "readwrite",
      );
      await atomic(tx, async () => {
        if (
          (await tx.objectStore("operations").get(task.id))?.status ===
          "committed"
        )
          return;
        const session = await tx.objectStore("sessions").get(task.sessionId);
        if (!session) throw new Error("压缩会话已删除。");
        const character = await tx
          .objectStore("characters")
          .get(session.characterId);
        if (!character) throw new Error("压缩角色已删除。");
        if (
          session.summary.version !== result!.baseSummaryVersion ||
          session.summary.throughSeq !== result!.fromExclusiveSeq ||
          session.stateVersion !== result!.baseSessionVersion ||
          character.memoryVersion !== result!.baseMemoryVersion
        )
          throw new StaleCompaction("压缩期间上下文版本已变化，需要重新计算。");
        for (const source of operation!.sourceVersions!) {
          const message = await tx.objectStore("messages").get(source.id);
          if (
            !message ||
            message.checkpointVersion !== source.checkpointVersion
          )
            throw new StaleCompaction("压缩消息来源已变化。");
        }
        for (const asset of task.context.visual?.assetCatalog ?? []) {
          const observation = await tx
            .objectStore("visualObservations")
            .get(`${session.id}:${asset.assetId}`);
          if ((observation?.version ?? 0) !== (asset.observation?.version ?? 0))
            throw new StaleCompaction("压缩图片观察版本已变化。");
        }
        await tx
          .objectStore("sessions")
          .put({ ...session, summary: result!.summary });
        await tx
          .objectStore("operations")
          .put({
            ...operation!,
            status: "committed",
            error: undefined,
            updatedAt: now(),
          });
        await tx.objectStore("compactionTasks").delete(task.id);
      });
    });
    await changed();
  } catch (error) {
    const computed =
      operation.status === "computed" &&
      !(error instanceof StaleCompaction) &&
      !signal.aborted;
    await commit(() =>
      db.put("operations", {
        ...operation!,
        status: computed
          ? "computed"
          : signal.aborted
            ? "cancelled"
            : error instanceof StaleCompaction
              ? "stale"
              : "failed",
        error: errorText(error),
        updatedAt: now(),
      }),
    );
    await changed();
    if (
      error instanceof StaleCompaction &&
      !signal.aborted &&
      !manual &&
      task.automaticAttempts < 2
    )
      return runCompactionTask(task, signal, commit, changed);
    throw error;
  }
}

export async function resumeCompactionTasks(
  sessionId: string,
  signal: AbortSignal,
  commit: Commit,
  changed: () => Promise<void>,
  manualId?: string,
) {
  const tasks = await (
    await database()
  ).getAllFromIndex("compactionTasks", "session", sessionId);
  for (const task of tasks.sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )) {
    await runCompactionTask(
      task,
      signal,
      commit,
      changed,
      task.id === manualId,
    );
    if (task.id === manualId) break;
  }
}

export async function ensureContextBudget(
  context: ChatContext,
  mode: "required" | "final",
  anchorMessageId: string,
  signal: AbortSignal,
  commit: Commit,
  changed: () => Promise<void>,
  run: { batches: number },
) {
  const limits = await capabilities(signal);
  let budget = await inspectBudget(context, mode, signal);
  if (!budget.needsCompaction) return { context, budget, compacted: false };
  let compacted = false;
  while (budget.compactThroughSeq > context.summary.throughSeq) {
    if (run.batches >= limits.compactionMaxBatches)
      throw new Error("本次压缩已达到批次数上限，已保存中间摘要，可重试继续。");
    const task: CompactionTask = {
      id: `compact:${id()}`,
      sessionId: context.state.sessionId,
      assistantMessageId: anchorMessageId,
      context: structuredClone(context),
      automaticAttempts: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    if (task.context.visual) task.context.visual.imagePayloads = [];
    const operation: Operation = {
      id: task.id,
      sessionId: task.sessionId,
      runId: anchorMessageId,
      anchorMessageId,
      placement: "before",
      kind: "compaction",
      status: "pending",
      createdAt: now(),
      updatedAt: now(),
    };
    const db = await database();
    await commit(async () => {
      signal.throwIfAborted();
      const tx = db.transaction(["compactionTasks", "operations"], "readwrite");
      await atomic(tx, async () => {
        await tx.objectStore("compactionTasks").put(task);
        await tx.objectStore("operations").put(operation);
      });
    });
    await runCompactionTask(task, signal, commit, changed);
    run.batches++;
    compacted = true;
    context = await refreshContext(task);
    // 摘要使选图指纹失效，后续按必需图片预算检查，再重新选图。
    budget = await inspectBudget(context, "required", signal);
  }
  if (budget.needsCompaction)
    throw new Error(
      `最近 ${limits.retainedTurns} 轮及必需设定、图片占用 ${(budget.usageRatio * 100).toFixed(1)}%，仍达到压缩阈值或容量上限，请减少必需输入。`,
    );
  return { context, budget, compacted };
}
