"use client";

import { useAuiState } from "@assistant-ui/react";
import {
  ReasoningRoot,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning";
import { useAppStore } from "@/stores/use-app-store";

export function ThinkingIndicator() {
  const sessionId = useAuiState(
    (state) => state.message.metadata.custom.sessionId,
  );
  const characterName = useAppStore(
    (state) =>
      state.sessions.find((session) => session.id === sessionId)!
        .characterSnapshot.name,
  );

  return (
    <ReasoningRoot
      variant="ghost"
      open={false}
      className="mb-0"
      role="status"
      aria-live="polite"
    >
      <ReasoningTrigger
        active
        disabled
        className="max-w-full cursor-default hover:text-muted-foreground [&_[data-slot=reasoning-trigger-chevron]]:hidden"
      >
        {characterName}正在思考中
      </ReasoningTrigger>
    </ReasoningRoot>
  );
}
