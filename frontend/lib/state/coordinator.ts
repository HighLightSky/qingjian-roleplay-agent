import { database, allMessages, atomic } from "../db";
import { now, plainText, errorText, type Message } from "../domain";
import { stateSnapshot, type ChatContext } from "../chat/context";
import { apiJson, buildCatalog, loadPayloads } from "../images/coordinator";
import type { Commit } from "../images/types";
import { validateStateResult } from "./validation";
import type {
  StateTask,
  Operation,
  StateResult,
  Memory,
  Goal,
  SourceMessage,
} from "./types";

export async function saveCompletedStateTask(
  context: ChatContext,
  assistant: Message,
) {
  const db = await database();
  const tx = db.transaction(
    ["messages", "stateTasks", "operations", "imageUsages"],
    "readwrite",
  );
  return atomic(tx, async () => {
    const frozen = structuredClone(context);
    if (frozen.visual) frozen.visual.imagePayloads = [];
    const task: StateTask = {
      id: `state:${assistant.id}`,
      sessionId: assistant.sessionId,
      assistantMessageId: assistant.id,
      throughSeq: assistant.seq,
      context: frozen,
      automaticAttempts: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    const operation: Operation = {
      id: task.id,
      sessionId: task.sessionId,
      runId: assistant.id,
      anchorMessageId: assistant.id,
      kind: "state_update",
      placement: "after",
      status: "pending",
      createdAt: now(),
      updatedAt: now(),
    };
    await tx.objectStore("messages").put(assistant);
    await tx.objectStore("stateTasks").put(task);
    await tx.objectStore("operations").put(operation);
    for (const p of context.visual?.imagePayloads ?? []) {
      await tx.objectStore("imageUsages").put({
        id: `${assistant.id}:${p.assetId}`,
        assetId: p.assetId,
        sessionId: assistant.sessionId,
        messageId: assistant.id,
        purpose:
          context.visual?.plan?.selectedHistoricalImages.find(
            (s) => s.assetId === p.assetId,
          )?.purpose ??
          (context.character.appearancePhotoAssetId === p.assetId
            ? "角色形象参考"
            : "本轮用户图片"),
        createdAt: now(),
      });
    }
    return task;
  });
}

class StaleResult extends Error {}

export async function runStateTask(
  task: StateTask,
  signal: AbortSignal,
  commit: Commit,
  changed: () => Promise<void>,
  manual = false,
) {
  const db = await database();
  let operation = await db.get("operations", task.id);
  if (!operation) throw new Error("整理任务缺少操作记录。");
  if (operation.status === "committed") return;
  const storedTask = await db.get("stateTasks", task.id);
  if (!storedTask) throw new Error("整理操作缺少待办任务。需要恢复完整备份。");
  task = storedTask;
  try {
    signal.throwIfAborted();
    const [session, messages] = await Promise.all([
      db.get("sessions", task.sessionId),
      allMessages(task.sessionId),
    ]);
    if (!session) throw new Error("整理会话不存在。");
    const character = await db.get("characters", session.characterId);
    if (!character) throw new Error("整理角色不存在。");
    const [memories, goals] = await Promise.all([
      db.getAllFromIndex("memories", "character", character.id),
      db.getAllFromIndex("goals", "session", session.id),
    ]);
    const state = stateSnapshot(character, session, memories, goals);
    let result =
      operation.status === "computed"
        ? (operation.result as StateResult)
        : undefined;
    const cachedSourcesChanged =
      result &&
      operation.sourceVersions!.some(
        (source) =>
          messages.find((m) => m.id === source.id)?.checkpointVersion !==
          source.checkpointVersion,
      );
    if (
      result &&
      (cachedSourcesChanged ||
        result.sessionVersion !== state.sessionVersion ||
        result.memoryVersion !== state.memoryVersion ||
        result.fromExclusiveSeq !== state.processedThroughSeq)
    ) {
      operation = {
        ...operation,
        status: "stale",
        error: "结果已过期，等待重新整理。",
        updatedAt: now(),
      };
      await commit(() => db.put("operations", operation!));
      await changed();
      result = undefined;
    }
    if (!result) {
      if (!manual && task.automaticAttempts >= 2)
        throw new Error("自动整理已尝试两次，请在失败步骤中重试。");
      const assistant = messages.find((m) => m.id === task.assistantMessageId);
      if (
        !assistant ||
        assistant.status !== "complete" ||
        !plainText(assistant)
      )
        throw new Error("整理正文未完整保存。");
      const pending: SourceMessage[] = messages
        .filter(
          (m) =>
            m.seq > state.processedThroughSeq &&
            m.seq <= task.throughSeq &&
            m.status === "complete",
        )
        .map((m) => ({
          id: m.id,
          seq: m.seq,
          role: m.role,
          text:
            plainText(m) ||
            `图片输入：${m
              .parts!.filter((p) => p.type === "image")
              .map((p) => p.assetId)
              .join("、")}`,
          status: "complete",
          createdAt: m.createdAt,
        }));
      const context = { ...task.context, state, operationId: task.id };
      if (context.visual) {
        const user = messages.find((m) => m.id === assistant.replyToMessageId)!;
        context.visual = {
          ...context.visual,
          assetCatalog: await buildCatalog(
            session.id,
            messages.filter((m) => m.seq < user.seq),
          ),
        };
        context.visual.imagePayloads = await loadPayloads(context, signal);
      }
      operation = {
        ...operation,
        status: "running",
        error: undefined,
        result: undefined,
        updatedAt: now(),
      };
      task = {
        ...task,
        automaticAttempts: task.automaticAttempts + (manual ? 0 : 1),
        updatedAt: now(),
      };
      await commit(async () => {
        signal.throwIfAborted();
        const tx = db.transaction(["operations", "stateTasks"], "readwrite");
        await atomic(tx, async () => {
          await tx.objectStore("operations").put(operation!);
          await tx.objectStore("stateTasks").put(task);
        });
      });
      await changed();
      result = await apiJson<StateResult>(
        "/api/state/update",
        {
          operationId: task.id,
          context,
          fromExclusiveSeq: state.processedThroughSeq,
          throughSeq: task.throughSeq,
          messages: pending,
        },
        signal,
      );
      signal.throwIfAborted();
      validateStateResult(result);
      if (
        result.operationId !== task.id ||
        result.sessionVersion !== state.sessionVersion ||
        result.memoryVersion !== state.memoryVersion ||
        result.fromExclusiveSeq !== state.processedThroughSeq ||
        result.throughSeq !== task.throughSeq
      )
        throw new Error("服务端整理结果与操作快照不一致。");
      operation = {
        ...operation,
        status: "computed",
        result,
        sourceVersions: messages
          .filter(
            (m) =>
              m.seq > state.processedThroughSeq && m.seq <= task.throughSeq,
          )
          .map((m) => ({ id: m.id, checkpointVersion: m.checkpointVersion })),
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
          "characters",
          "sessions",
          "messages",
          "memories",
          "goals",
          "visualObservations",
          "operations",
          "stateTasks",
        ],
        "readwrite",
      );
      await atomic(tx, async () => {
        const currentOperation = await tx
          .objectStore("operations")
          .get(task.id);
        if (currentOperation?.status === "committed") return;
        const currentSession = await tx.objectStore("sessions").get(session.id);
        const currentCharacter = await tx
          .objectStore("characters")
          .get(character.id);
        if (!currentSession || !currentCharacter)
          throw new Error("整理目标已删除。");
        if (
          currentSession.stateVersion !== result!.sessionVersion ||
          currentCharacter.memoryVersion !== result!.memoryVersion ||
          currentSession.stateProcessedThroughSeq !== result!.fromExclusiveSeq
        ) {
          throw new StaleResult("结果已过期，等待重新整理。");
        }
        for (const source of operation!.sourceVersions!) {
          const current = await tx.objectStore("messages").get(source.id);
          if (
            !current ||
            current.checkpointVersion !== source.checkpointVersion
          ) {
            throw new StaleResult("整理消息来源已变化。");
          }
        }
        const updatedStory = { ...currentSession.story };
        const storySources = { ...currentSession.storySources };
        for (const change of result!.storyChanges) {
          Object.assign(updatedStory, { [change.id]: change.value });
          Object.assign(storySources, {
            [change.id]: {
              origin: "automatic",
              updatedAt: now(),
              sourceMessageIds: change.sourceMessageIds,
            },
          });
        }
        for (const change of result!.memoryChanges) {
          const previous = await tx.objectStore("memories").get(change.id);
          if ((previous?.version ?? 0) !== change.expectedVersion)
            throw new Error("整理记忆版本无效。");
          const memory: Memory = {
            id: change.id,
            characterId: character.id,
            sessionId: change.value.scope === "session" ? session.id : null,
            value: change.value,
            version: change.expectedVersion + 1,
            origin: "automatic",
            sourceSessionId: session.id,
            sourceMessageIds: [
              ...new Set([
                ...(previous?.sourceMessageIds ?? []),
                ...change.sourceMessageIds,
              ]),
            ],
            createdAt: previous?.createdAt ?? now(),
            updatedAt: now(),
          };
          await tx.objectStore("memories").put(memory);
        }
        for (const change of result!.goalChanges) {
          const previous = await tx.objectStore("goals").get(change.id);
          if ((previous?.version ?? 0) !== change.expectedVersion)
            throw new Error("整理目标版本无效。");
          const goal: Goal = {
            id: change.id,
            sessionId: session.id,
            value: change.value,
            version: change.expectedVersion + 1,
            origin: "automatic",
            sourceMessageIds: [
              ...new Set([
                ...(previous?.sourceMessageIds ?? []),
                ...change.sourceMessageIds,
              ]),
            ],
            createdAt: previous?.createdAt ?? now(),
            updatedAt: now(),
          };
          await tx.objectStore("goals").put(goal);
        }
        for (const observation of result!.visualObservations) {
          const key = `${session.id}:${observation.assetId}`;
          const previous = await tx.objectStore("visualObservations").get(key);
          if ((previous?.version ?? 0) + 1 !== observation.version)
            throw new Error("视觉观察版本无效。");
          await tx.objectStore("visualObservations").put({
            ...observation,
            id: key,
            sessionId: session.id,
            createdAt: previous?.createdAt ?? now(),
            updatedAt: now(),
          });
        }
        const domainChanged =
          result!.storyChanges.length +
            result!.memoryChanges.length +
            result!.goalChanges.length >
          0;
        await tx.objectStore("sessions").put({
          ...currentSession,
          story: updatedStory,
          storySources,
          stateProcessedThroughSeq: task.throughSeq,
          stateVersion: currentSession.stateVersion + (domainChanged ? 1 : 0),
          ...(domainChanged ? { updatedAt: now() } : {}),
        });
        if (result!.memoryChanges.some((c) => c.value.scope === "character"))
          await tx.objectStore("characters").put({
            ...currentCharacter,
            memoryVersion: currentCharacter.memoryVersion + 1,
          });
        await tx.objectStore("operations").put({
          ...operation!,
          status: "committed",
          error: undefined,
          updatedAt: now(),
        });
        await tx.objectStore("stateTasks").delete(task.id);
      });
    });
    await changed();
  } catch (error) {
    const computed =
      operation.status === "computed" &&
      !(error instanceof StaleResult) &&
      !signal.aborted;
    await commit(() =>
      db.put("operations", {
        ...operation!,
        status: computed
          ? "computed"
          : signal.aborted
            ? "cancelled"
            : error instanceof StaleResult
              ? "stale"
              : "failed",
        error: errorText(error),
        updatedAt: now(),
      }),
    );
    await changed();
    if (
      error instanceof StaleResult &&
      !signal.aborted &&
      !manual &&
      task.automaticAttempts < 2
    )
      return runStateTask(task, signal, commit, changed);
    throw error;
  }
}

export async function resumePendingTasks(
  sessionId: string,
  signal: AbortSignal,
  commit: Commit,
  changed: () => Promise<void>,
) {
  const tasks = await (
    await database()
  ).getAllFromIndex("stateTasks", "session", sessionId);
  for (const task of tasks.sort((a, b) => a.throughSeq - b.throughSeq))
    await runStateTask(task, signal, commit, changed);
}
