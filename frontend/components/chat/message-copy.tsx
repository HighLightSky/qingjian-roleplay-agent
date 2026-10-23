"use client";

import { useAuiState } from "@assistant-ui/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export function MessageCopyAction({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  const text = useAuiState((s) =>
    s.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  );
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  return (
    <TooltipIconButton
      tooltip={isCopied ? "已复制" : label}
      aria-label={label}
      className={className}
      disabled={!text}
      data-copied={isCopied || undefined}
      onClick={() => copyToClipboard(text)}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </TooltipIconButton>
  );
}
