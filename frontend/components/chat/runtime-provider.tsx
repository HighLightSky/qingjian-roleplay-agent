"use client";

import {
  AssistantRuntimeProvider,
  MessageNotSentError,
  useAssistantDataUI,
  useExternalStoreRuntime,
  type AssistantRuntime,
  type DataMessagePartComponent,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { database, TABLES, collectUnreferenced } from "@/lib/db";
import { imageIds, type ContentPart } from "@/lib/images/types";
import {
  attachmentAssetId,
  createImageAttachmentAdapter,
} from "@/lib/images/attachment-adapter";
import { plainText, now, type Message } from "@/lib/domain";
import {
  cancelGeneration,
  flushDrafts,
  loadEarlier,
  newSession,
  pauseDraft,
  renameSession,
  report,
  scheduleDraft,
  selectSession,
  sendMessage,
  write,
  retryLastMessage,
  useAppStore,
} from "@/stores/use-app-store";

import { projectMessages, type RuntimeEntry } from "@/lib/state/projection";
const mapped = new WeakMap<RuntimeEntry, ThreadMessageLike>();
function convertMessage(message: RuntimeEntry): ThreadMessageLike {
  const previous = mapped.get(message);
  if (previous) return previous;
  if ("kind" in message) {
    const failed =
      ["failed", "cancelled", "stale"].includes(message.status) ||
      !!message.error;
    const complete = message.status === "committed";
    const value: ThreadMessageLike = {
      id: `activity:${message.id}`,
      role: "assistant",
      createdAt: new Date(message.createdAt),
      content: [
        {
          type: "tool-call",
          toolCallId: message.id,
          toolName: message.kind,
          args: { operationId: message.id, origin: "orchestrator" },
          ...(complete || failed
            ? {
                result: message.result ?? { error: message.error },
                isError: failed,
              }
            : {}),
        },
      ],
      status: complete
        ? { type: "complete", reason: "stop" }
        : failed
          ? {
              type: "incomplete",
              reason: message.status === "cancelled" ? "cancelled" : "other",
            }
          : { type: "running" },
      metadata: { custom: { activity: true, segmented: true } },
    };
    mapped.set(message, value);
    return value;
  }
  const text = plainText(message);
  const note =
    message.error ||
    (message.status === "pending"
      ? "等待生成正文…"
      : message.status === "streaming"
        ? "正在回复…"
        : "");
  const value: ThreadMessageLike = {
    id: message.id,
    role: message.role,
    createdAt: new Date(message.createdAt),
    ...(message.role === "user"
      ? {
          attachments: imageIds(message.parts).map((assetId, index) => ({
            id: `${message.id}:image:${index}`,
            type: "image",
            name: `图片 ${index + 1}`,
            contentType: "image/png",
            status: { type: "complete" as const },
            content: [{ type: "image" as const, image: `asset:${assetId}` }],
          })),
        }
      : {}),
    content:
      message.role === "user"
        ? [{ type: "text", text }]
        : [
            // The standard copy action reads text parts. Rendering uses only data parts.
            { type: "text", text },
            ...(message.segments ?? []).map((segment, index) => ({
              type: `data-${segment.kind}` as const,
              id: `${message.id}:${index}`,
              data: { text: segment.text },
            })),
            ...(note
              ? [{ type: "data-note" as const, data: { text: note } }]
              : []),
          ],
    status:
      message.role === "user"
        ? undefined
        : ["pending", "streaming"].includes(message.status)
          ? { type: "running" }
          : message.status === "complete"
            ? { type: "complete", reason: "stop" }
            : {
                type: "incomplete",
                reason: message.status === "cancelled" ? "cancelled" : "other",
              },
    metadata: {
      custom: {
        segmented: message.role === "assistant",
        sessionId: message.sessionId,
        plainText: text,
      },
    },
  };
  mapped.set(message, value);
  return value;
}
const Dialogue: DataMessagePartComponent<{ text: string }> = ({ data }) => (
  <p className="my-3 w-fit max-w-full whitespace-pre-wrap break-words rounded-md bg-accent px-3 py-2 text-base leading-7">
    {data.text}
  </p>
);
const Narration: DataMessagePartComponent<{ text: string }> = ({ data }) => (
  <p className="my-3 whitespace-pre-wrap break-words text-base leading-7">
    {data.text}
  </p>
);
const Note: DataMessagePartComponent<{ text: string }> = ({ data }) => (
  <p role="status" className="my-2 text-xs leading-5 text-muted-foreground">
    {data.text}
  </p>
);

function RuntimeBindings({
  runtime,
  onPreparing,
}: {
  runtime: AssistantRuntime;
  onPreparing: (value: boolean) => void;
}) {
  useAssistantDataUI({ name: "dialogue", render: Dialogue });
  useAssistantDataUI({ name: "narration", render: Narration });
  useAssistantDataUI({ name: "note", render: Note });
  const loading = useAppStore((state) => state.loadingMessages);
  const sessionId = useAppStore((state) => state.sessionId);
  useEffect(() => {
    const update = () =>
      onPreparing(
        runtime.thread.composer
          .getState()
          .attachments.some(
            (a) =>
              a.status.type === "running" || a.status.type === "incomplete",
          ),
      );
    update();
    return runtime.thread.composer.subscribe(update);
  }, [runtime, onPreparing]);
  useEffect(() => {
    if (!sessionId || loading) return;
    // Restore only when a session finishes loading, never after a draft save.
    runtime.thread.composer.setText(useAppStore.getState().draft);
    let restoring = true;
    let previousAttachmentIds = "";
    void database()
      .then(async (db) => {
        const draft = await db.get("drafts", sessionId);
        for (const assetId of imageIds(draft?.parts)) {
          if (disposed) return;
          const asset = await db.get("assets", assetId);
          if (disposed) return;
          if (!asset)
            report(new Error("草稿图片原件缺失，可以移除附件或恢复备份。"));
          await runtime.thread.composer.addAttachment({
            id: assetId,
            type: "image",
            name: asset?.displayName ?? "图片原件缺失",
            contentType: asset?.mimeType ?? "image/png",
            content: [{ type: "image", image: `asset:${assetId}` }],
          });
        }
        previousAttachmentIds = imageIds(draft?.parts).join(",");
        restoring = false;
      })
      .catch(report);
    let previousText = runtime.thread.composer.getState().text;
    let composing = false;
    let disposed = false;
    const syncDraft = (force = false) => {
      if (disposed || composing) return;
      const composer = runtime.thread.composer.getState();
      if (
        composer.submission ||
        composer.inTransit?.length ||
        restoring ||
        useAppStore.getState().preparingInput
      )
        return;
      const assetIds = composer.attachments
        .map(attachmentAssetId)
        .filter((value): value is string => !!value);
      const nextAttachmentIds = assetIds.join(",");
      if (nextAttachmentIds !== previousAttachmentIds) {
        previousAttachmentIds = nextAttachmentIds;
        void write(async () => {
          const db = await database();
          const tx = db.transaction(TABLES, "readwrite");
          const draft = await tx.objectStore("drafts").get(sessionId);
          if (draft)
            await tx.objectStore("drafts").put({
              ...draft,
              parts: assetIds.map((assetId) => ({ type: "image", assetId })),
              updatedAt: now(),
            });
          await collectUnreferenced(tx);
          await tx.done;
        }).catch(report);
      }
      if (!force && composer.text === previousText) return;
      previousText = composer.text;
      scheduleDraft(sessionId, composer.text);
    };
    // assistant-ui detaches a ready draft just before calling onNew. Defer reading
    // until that synchronous handoff completes, so assets cannot be collected mid-send.
    const unsubscribe = runtime.thread.composer.subscribe(() =>
      queueMicrotask(() => syncDraft()),
    );
    // 预检和压缩期间暂停草稿写入，结束后补存期间输入的下一条草稿。
    const unsubscribePreparation = useAppStore.subscribe((state, previous) => {
      if (previous.preparingInput && !state.preparingInput)
        queueMicrotask(() => syncDraft());
    });
    const unsubscribeError = runtime.thread.composer.unstable_on(
      "attachmentAddError",
      (event) => report(new Error(event.message)),
    );
    const isComposer = (event: Event) =>
      event.target instanceof HTMLTextAreaElement &&
      event.target.hasAttribute("data-roleplay-composer");
    const compositionStart = (event: Event) => {
      if (!isComposer(event)) return;
      composing = true;
      pauseDraft(sessionId);
    };
    const compositionEnd = (event: Event) => {
      if (!isComposer(event)) return;
      composing = false;
      // Let assistant-ui apply the final committed text before reading it.
      queueMicrotask(() => syncDraft(true));
    };
    const flush = () => {
      syncDraft();
      void flushDrafts().catch(report);
    };
    const blur = (event: Event) => {
      if (isComposer(event)) flush();
    };
    document.addEventListener("compositionstart", compositionStart, true);
    document.addEventListener("compositionend", compositionEnd, true);
    document.addEventListener("focusout", blur, true);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      unsubscribe();
      unsubscribePreparation();
      unsubscribeError();
      disposed = true;
      void flushDrafts().catch(report);
      document.removeEventListener("compositionstart", compositionStart, true);
      document.removeEventListener("compositionend", compositionEnd, true);
      document.removeEventListener("focusout", blur, true);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [runtime, loading, sessionId]);
  return null;
}
export function ChatRuntimeProvider({ children }: { children: ReactNode }) {
  const sessionId = useAppStore((state) => state.sessionId);
  return <SessionRuntime key={sessionId ?? "empty"}>{children}</SessionRuntime>;
}
function SessionRuntime({ children }: { children: ReactNode }) {
  const state = useAppStore(
    useShallow((state) => ({
      messages: state.messages,
      operations: state.operations,
      sessions: state.sessions,
      loadingMessages: state.loadingMessages,
      readOnly: state.readOnly,
      sessionId: state.sessionId,
      archived: !!state.characters.find(
        (character) => character.id === state.characterId,
      )?.archived,
      busy: state.busy,
      activeSessionId: state.activeSessionId,
      hasEarlier: state.hasEarlier,
    })),
  );
  const threads = useMemo(
    () =>
      state.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        status: "regular" as const,
      })),
    [state.sessions],
  );
  const [preparingImages, setPreparingImages] = useState(false);
  const attachmentAdapter = useMemo(
    () => createImageAttachmentAdapter(state.sessionId ?? "", write),
    [state.sessionId],
  );
  const entries = useMemo(
    () => projectMessages(state.messages, state.operations),
    [state.messages, state.operations],
  );
  const runtime = useExternalStoreRuntime<RuntimeEntry>({
    messages: entries,
    convertMessage,
    isLoading: state.loadingMessages,
    isDisabled:
      state.loadingMessages ||
      state.busy ||
      state.readOnly ||
      !state.sessionId ||
      state.archived,
    isSendDisabled:
      preparingImages ||
      state.busy ||
      (!!state.activeSessionId && state.activeSessionId !== state.sessionId),
    isRunning:
      !!state.activeSessionId && state.activeSessionId === state.sessionId,
    hasEarlier: state.hasEarlier,
    onLoadEarlier: loadEarlier,
    onNew: async (message) => {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      try {
        const assetIds = (message.attachments ?? []).map(attachmentAssetId);
        if (assetIds.some((assetId) => !assetId))
          throw new Error("附件尚未准备完成。");
        const parts: ContentPart[] | undefined = assetIds.length
          ? [
              ...(text ? [{ type: "text" as const, text }] : []),
              ...assetIds.map((assetId) => ({
                type: "image" as const,
                assetId: assetId!,
              })),
            ]
          : undefined;
        await sendMessage(text, parts);
      } catch (error) {
        report(error);
        throw new MessageNotSentError(
          error instanceof Error ? error.message : "发送前准备失败。",
        );
      }
    },
    onCancel: cancelGeneration,
    onReload: async () => {
      await retryLastMessage();
    },
    adapters: {
      attachments: attachmentAdapter,
      threadList: {
        threadId: state.sessionId ?? undefined,
        threads,
        onSwitchToNewThread: () => newSession().catch(report),
        onSwitchToThread: (sessionId) => selectSession(sessionId).catch(report),
        onRename: (sessionId, title) => {
          const session = useAppStore
            .getState()
            .sessions.find((item) => item.id === sessionId);
          return session ? renameSession(session, title) : Promise.resolve();
        },
      },
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RuntimeBindings runtime={runtime} onPreparing={setPreparingImages} />
      {children}
    </AssistantRuntimeProvider>
  );
}
