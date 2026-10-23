"use client";

import { useEffect, useRef, useState } from "react";
import {
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { ArrowUpIcon, XIcon } from "lucide-react";
import {
  ComposerAttachments,
  ComposerAddAttachment,
} from "@/components/assistant-ui/elements/attachment.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { ContextBudgetIndicator } from "./context-budget";
import {
  startMessageEdit,
  cancelMessageEdit,
  scheduleDraft,
  flushDrafts,
  pauseDraft,
  report,
  useAppStore,
} from "@/stores/use-app-store";

export function MessageEditComposer() {
  const aui = useAui();
  const messageId = useAuiState((s) => s.message.id);
  const sessionId = useAppStore((s) => s.sessionId)!;
  const [ready, setReady] = useState(false);
  const composing = useRef(false);
  const text = useAuiState((s) => s.message.composer.text);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  const attachments = useAuiState((s) => s.message.composer.attachments);
  const preparing = attachments.some((a) =>
    ["running", "incomplete"].includes(a.status.type),
  );
  useEffect(() => {
    let disposed = false;
    void startMessageEdit(messageId)
      .then(() => {
        if (disposed) return;
        setReady(true);
      })
      .catch(report);
    const flush = () => {
      void flushDrafts().catch(report);
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      disposed = true;
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [messageId, sessionId]);
  useEffect(() => {
    if (
      ready &&
      isEditing &&
      !composing.current &&
      !useAppStore.getState().editSubmitting
    )
      scheduleDraft(sessionId, text, messageId);
  }, [ready, isEditing, text, sessionId, messageId]);
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2"
    >
      <ComposerPrimitive.Root
        className="aui-edit-composer-root border-foreground/10 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border p-2"
        onSubmitCapture={(event) => {
          if (!ready || preparing) {
            event.preventDefault();
            return;
          }
          // native 编辑发送会立即关闭输入框，附件清理需要知道引用正在转交。
          useAppStore.setState({ editSubmitting: true });
        }}
      >
        <fieldset disabled={!ready} className="contents">
          <ComposerAttachments />
          <ComposerPrimitive.Input
            aria-label="编辑消息内容"
            autoFocus
            rows={2}
            className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent px-2 py-2 text-base outline-none"
            addAttachmentOnPaste
            onCompositionStart={() => {
              composing.current = true;
              pauseDraft(sessionId, messageId);
            }}
            onCompositionEnd={(event) => {
              composing.current = false;
              scheduleDraft(sessionId, event.currentTarget.value, messageId);
            }}
            onBlur={() => {
              void flushDrafts().catch(report);
            }}
          />
        </fieldset>
        <div className="flex items-center justify-between gap-2">
          <fieldset disabled={!ready} className="contents">
            <ComposerAddAttachment />
          </fieldset>
          <div className="flex items-center gap-1">
            <ContextBudgetIndicator editUserId={messageId} />
            <ComposerPrimitive.Cancel
              asChild
              onClick={(event) => {
                event.preventDefault();
                void cancelMessageEdit(messageId)
                  .then(() => aui.composer.cancel())
                  .catch(report);
              }}
            >
              <TooltipIconButton tooltip="取消编辑" aria-label="取消编辑">
                <XIcon />
              </TooltipIconButton>
            </ComposerPrimitive.Cancel>
            <ComposerPrimitive.Send asChild disabled={!ready || preparing}>
              <TooltipIconButton
                tooltip="重新发送"
                aria-label="重新发送"
                disabled={!ready || preparing}
                variant="default"
              >
                <ArrowUpIcon />
              </TooltipIconButton>
            </ComposerPrimitive.Send>
          </div>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}
