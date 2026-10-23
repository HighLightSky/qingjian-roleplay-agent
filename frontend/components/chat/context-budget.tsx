"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import { ContextDisplayRing } from "@/components/assistant-ui/elements/context-display";
import { useAppStore } from "@/stores/use-app-store";
import { database, allMessages } from "@/lib/db";
import { chatContext, type ChatContext } from "@/lib/chat/context";
import { buildCatalog } from "@/lib/images/coordinator";
import { inspectBudget } from "@/lib/context/coordinator";
import type { ContextBudget } from "@/lib/context/types";
import { errorText } from "@/lib/domain";

export function ContextBudgetIndicator({
  editUserId,
}: { editUserId?: string } = {}) {
  const text = useAuiState((s) => s.composer.text);
  const attachments = useAuiState((s) =>
    JSON.stringify(
      s.composer.attachments.map((a) => [a.id, a.status.type, a.content]),
    ),
  );
  const state = useAppStore(
    useShallow((s) => ({
      sessionId: s.sessionId,
      sessions: s.sessions,
      memories: s.memories,
      goals: s.goals,
      messages: s.messages,
      settings: s.interactionSettings,
      operations: s.operations,
      activeSessionId: s.activeSessionId,
      loading: s.loadingMessages,
      liveBudget: s.contextBudget,
    })),
  );
  const [value, setValue] = useState<{
    sessionId: string;
    budget: ContextBudget;
  } | null>(null);
  const [error, setError] = useState("");
  const [composing, setComposing] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const start = (event: Event) => {
      if ((event.target as HTMLElement)?.matches("[data-roleplay-composer]"))
        setComposing(true);
    };
    const end = (event: Event) => {
      if ((event.target as HTMLElement)?.matches("[data-roleplay-composer]"))
        setComposing(false);
    };
    document.addEventListener("compositionstart", start, true);
    document.addEventListener("compositionend", end, true);
    return () => {
      document.removeEventListener("compositionstart", start, true);
      document.removeEventListener("compositionend", end, true);
    };
  }, []);
  useEffect(() => {
    if (!state.sessionId || state.loading || state.activeSessionId || composing)
      return;
    const sessionId = state.sessionId;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPending(true);
      void (async () => {
        const db = await database();
        const session = await db.get("sessions", sessionId);
        if (!session) throw new Error("上下文预览的会话不存在。");
        const character = await db.get("characters", session.characterId);
        if (!character) throw new Error("上下文预览的角色不存在。");
        const [messages, memories, goals, draft] = await Promise.all([
          allMessages(sessionId),
          db.getAllFromIndex("memories", "character", character.id),
          db.getAllFromIndex("goals", "session", sessionId),
          db.get("drafts", sessionId),
        ]);
        const inputDraft = editUserId ? draft?.edit : draft;
        const history = editUserId
          ? messages.filter(
              (m) => m.seq < messages.find((m) => m.id === editUserId)!.seq,
            )
          : messages;
        const imageParts =
          inputDraft?.parts?.filter((p) => p.type === "image") ?? [];
        const parts = imageParts.length
          ? [...(text ? [{ type: "text" as const, text }] : []), ...imageParts]
          : undefined;
        const context: ChatContext = chatContext(
          character,
          session,
          memories,
          history,
          text,
          state.settings,
          parts,
          goals,
          `preview:${sessionId}`,
        );
        context.visual = {
          sessionId,
          ...(await buildCatalog(sessionId, history)),
          plan: null,
          imagePayloads: [],
        };
        const budget = await inspectBudget(
          context,
          "preview",
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setValue({ sessionId, budget });
          setError("");
        }
      })()
        .catch((failure) => {
          if (!controller.signal.aborted) {
            setValue(null);
            setError(errorText(failure));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setPending(false);
        });
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    state.sessionId,
    state.sessions,
    state.memories,
    state.goals,
    state.messages,
    state.settings,
    state.operations,
    state.activeSessionId,
    state.loading,
    text,
    attachments,
    editUserId,
    composing,
  ]);
  const live =
    state.activeSessionId === state.sessionId ? state.liveBudget : null;
  const current =
    live?.sessionId === state.sessionId
      ? live
      : value?.sessionId === state.sessionId
        ? value
        : null;
  if (!current)
    return (
      <span
        className="px-1 text-xs text-muted-foreground"
        role="status"
        title={error}
      >
        {error ? "上下文不可用" : "统计中…"}
      </span>
    );
  const budget = current.budget;
  return (
    <ContextDisplayRing
      key={`${current.sessionId}:${budget.requestFingerprint}`}
      modelContextWindow={budget.contextWindowTokens}
      resetKey={`${current.sessionId}:${budget.requestFingerprint}`}
      usage={{
        totalTokens: budget.inputTokens,
        inputTokens: budget.inputTokens,
      }}
      className="h-8 shrink-0"
      details={
        <div className="mb-2 space-y-1 border-b pb-2 text-muted-foreground">
          <p>
            {pending ? "正在更新预览" : "下一次正文输入"} ·{" "}
            {budget.accuracy === "exact" ? "精确计数" : "保守估算"}
          </p>
          <p>输出预留：{budget.outputReserveTokens.toLocaleString()} token</p>
          <p>安全余量：{budget.safetyTokens.toLocaleString()} token</p>
          {budget.needsCompaction && <p>发送前将自动压缩较早剧情</p>}
        </div>
      }
    />
  );
}
