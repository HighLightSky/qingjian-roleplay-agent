"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
} from "@/components/assistant-ui/elements/reasoning.aui";
import type { ReasoningTrace } from "@/lib/domain";

export function ThinkingIndicator() {
  const reasoning = useAuiState(
    (state) =>
      state.message.metadata.custom.reasoning as ReasoningTrace | undefined,
  );
  const pending = useAuiState(
    (state) => state.message.metadata.custom.pending === true,
  );
  const active = reasoning?.status === "streaming";
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);

  const waiting = !reasoning && pending;
  if (!waiting && !reasoning?.text) return null;
  const title = waiting
    ? "等待模型响应"
    : {
        streaming: "正在思考",
        complete: "思考完成",
        cancelled: "思考已停止",
        error: "思考中断",
      }[reasoning!.status];
  const seconds = reasoning
    ? Math.max(
        0,
        Math.floor(((reasoning.endedAt ?? tick) - reasoning.startedAt) / 1000),
      )
    : undefined;

  return (
    <ReasoningRoot
      variant="ghost"
      open={open}
      onOpenChange={setOpen}
      streaming={active}
      className="mb-0"
      role="status"
      aria-live="polite"
    >
      <ReasoningTrigger
        active={waiting || active}
        disabled={waiting}
        className={
          waiting
            ? "max-w-full cursor-default [&_[data-slot=reasoning-trigger-chevron]]:hidden"
            : "max-w-full"
        }
      >
        {title}
        {seconds !== undefined ? ` · ${seconds} 秒` : ""}
      </ReasoningTrigger>
      {reasoning && (
        <ReasoningContent aria-busy={active}>
          <ReasoningText className="whitespace-pre-wrap break-words">
            {reasoning.text}
          </ReasoningText>
        </ReasoningContent>
      )}
    </ReasoningRoot>
  );
}
