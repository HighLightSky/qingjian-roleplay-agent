"use client";
import { useAuiState } from "@assistant-ui/react";
import { useAppStore } from "@/stores/use-app-store";

export function TurnTokenUsage() {
  const id = useAuiState((s) => s.message.id);
  const message = useAppStore((s) => s.messages.find((m) => m.id === id));
  if (!message || ["pending", "streaming"].includes(message.status))
    return null;
  const usage = message.usage;
  return (
    <span
      data-slot="turn-token-usage"
      className="ml-2 text-[11px] text-muted-foreground tabular-nums"
    >
      {usage?.status === "reported"
        ? `输入 ${usage.inputTokens.toLocaleString()} · 输出 ${usage.outputTokens.toLocaleString()} · 合计 ${usage.totalTokens.toLocaleString()} token`
        : "用量未知"}
    </span>
  );
}
