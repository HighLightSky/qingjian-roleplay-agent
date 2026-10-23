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
import { removeDraftImage } from "@/lib/images/repository";
import { database } from "@/lib/db";
import { imageIds, type ContentPart } from "@/lib/images/types";
import {
  attachmentAssetId,
  createImageAttachmentAdapter,
} from "@/lib/images/attachment-adapter";
import { plainText, type Message } from "@/lib/domain";
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
    message.error || (message.status === "streaming" ? "正在回复…" : "");
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
            // 文字复制读取 text，界面按分段数据展示正文。
            { type: "text", text },
            ...(message.segments ?? []).map((segment, index) => ({
              type: `data-${segment.kind}` as const,
              id: `${message.id}:${index}`,
              data: { text: segment.text },
            })),
            ...(note
              ? [
                  {
                    type: "data-note" as const,
                    data: { text: note, failed: message.status === "error" },
                  },
                ]
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
        pending: message.status === "pending",
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
const Note: DataMessagePartComponent<{ text: string; failed: boolean }> = ({
  data,
}) => (
  <p
    role={data.failed ? "alert" : "status"}
    className={`my-2 whitespace-pre-wrap break-words text-sm leading-6 ${data.failed ? "text-destructive" : "text-muted-foreground"}`}
  >
    {data.text}
  </p>
);

function RuntimeBindings({
  runtime,
  onPreparing,
  onMissing,
  restoreVersion,
}: {
  runtime: AssistantRuntime;
  onPreparing: (value: boolean) => void;
  onMissing: (ids: string[]) => void;
  restoreVersion: number;
}) {
  useAssistantDataUI({ name: "dialogue", render: Dialogue });
  useAssistantDataUI({ name: "narration", render: Narration });
  useAssistantDataUI({ name: "note", render: Note });
  const loading = useAppStore((state) => state.loadingMessages);
  const sessionId = useAppStore((state) => state.sessionId);
  const editDraft = useAppStore((state) => state.editDraft);
  const editSubmitting = useAppStore((state) => state.editSubmitting);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  useEffect(() => {
    if (!loading && editDraft && !editSubmitting && !activeSessionId) {
      const composer = runtime.thread.getMessageById(
        editDraft.userMessageId,
      ).composer;
      if (!composer.getState().isEditing) composer.beginEdit();
    }
  }, [runtime, loading, editDraft, editSubmitting, activeSessionId]);
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
    // 只在切换会话或移除缺失引用后恢复，普通草稿保存不重置输入框。
    let restoring = true;
    void database()
      .then(async (db) => {
        const draft = await db.get("drafts", sessionId);
        if (disposed) return;
        runtime.thread.composer.setText(draft?.text ?? "");
        const ids = imageIds(draft?.parts);
        const originals = await Promise.all(
          ids.map((assetId) => db.get("assets", assetId)),
        );
        if (disposed) return;
        const missing = ids.filter((_, index) => !originals[index]);
        onMissing(missing);
        if (missing.length)
          throw new Error(
            `草稿图片原件缺失：${missing.join("、")}，请移除后重新选择或恢复备份。`,
          );
        for (const asset of originals) {
          if (disposed) return;
          await runtime.thread.composer.addAttachment({
            id: asset!.id,
            type: "image",
            name: asset!.displayName,
            contentType: asset!.mimeType,
            content: [{ type: "image", image: `asset:${asset!.id}` }],
          });
        }
        restoring = false;
      })
      .catch((error) => {
        restoring = false;
        if (!disposed) report(error);
      });
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
  }, [runtime, loading, sessionId, restoreVersion, onMissing]);
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
      editDraft: state.editDraft,
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
  const [missingImages, setMissingImages] = useState<string[]>([]);
  const [restoreVersion, setRestoreVersion] = useState(0);
  const attachmentAdapter = useMemo(
    () =>
      createImageAttachmentAdapter(state.sessionId ?? "", write, () => ({
        userMessageId: useAppStore.getState().editDraft?.userMessageId,
        submitting: useAppStore.getState().editSubmitting,
      })),
    [state.sessionId],
  );
  const entries = useMemo(
    () =>
      projectMessages(
        state.messages.map((message) =>
          state.editDraft?.userMessageId === message.id
            ? {
                ...message,
                text: state.editDraft.text,
                parts: state.editDraft.parts,
              }
            : message,
        ),
        state.operations,
      ),
    [state.messages, state.operations, state.editDraft],
  );
  const append = async (
    message: import("@assistant-ui/react").AppendMessage,
  ) => {
    const sessionAtSend = state.sessionId;
    if (message.sourceId) useAppStore.setState({ editSubmitting: true });
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
      await sendMessage(text, parts, message.sourceId ?? undefined);
    } catch (error) {
      report(error);
      throw new MessageNotSentError(
        error instanceof Error ? error.message : "发送前准备失败。",
      );
    } finally {
      if (message.sourceId) {
        const draft = await (await database()).get("drafts", sessionAtSend!);
        useAppStore.setState({
          editSubmitting: false,
          ...(useAppStore.getState().sessionId === sessionAtSend
            ? { editDraft: draft?.edit ?? null }
            : {}),
        });
      }
    }
  };
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
      missingImages.length > 0 ||
      !!state.editDraft ||
      state.busy ||
      (!!state.activeSessionId && state.activeSessionId !== state.sessionId),
    isRunning:
      !!state.activeSessionId && state.activeSessionId === state.sessionId,
    hasEarlier: state.hasEarlier,
    onLoadEarlier: loadEarlier,
    onNew: append,
    onEdit: append,
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
      <RuntimeBindings
        runtime={runtime}
        onPreparing={setPreparingImages}
        onMissing={setMissingImages}
        restoreVersion={restoreVersion}
      />
      {missingImages.length > 0 && (
        <div role="alert" className="text-destructive p-2 text-sm">
          草稿原图缺失，请移除后重新选择：
          {missingImages.map((assetId) => (
            <button
              key={assetId}
              className="mx-1 underline"
              onClick={() => {
                void (async () => {
                  await flushDrafts();
                  await write(() =>
                    removeDraftImage(state.sessionId!, assetId),
                  );
                  setRestoreVersion((version) => version + 1);
                })().catch(report);
              }}
            >
              移除缺失图片 {assetId}
            </button>
          ))}
        </div>
      )}
      {children}
    </AssistantRuntimeProvider>
  );
}
