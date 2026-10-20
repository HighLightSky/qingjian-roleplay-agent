"use client";

import {
  AssistantRuntimeProvider,
  useAssistantDataUI,
  useExternalStoreRuntime,
  type AssistantRuntime,
  type DataMessagePartComponent,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useEffect, useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
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
  useAppStore,
} from "@/stores/use-app-store";

const mapped = new WeakMap<Message, ThreadMessageLike>();
function convertMessage(message: Message): ThreadMessageLike {
  const previous = mapped.get(message);
  if (previous) return previous;
  const text = plainText(message);
  const note =
    message.error ||
    (["pending", "streaming"].includes(message.status) ? "正在回复…" : "");
  const value: ThreadMessageLike = {
    id: message.id,
    role: message.role,
    createdAt: new Date(message.createdAt),
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

function RuntimeBindings({ runtime }: { runtime: AssistantRuntime }) {
  useAssistantDataUI({ name: "dialogue", render: Dialogue });
  useAssistantDataUI({ name: "narration", render: Narration });
  useAssistantDataUI({ name: "note", render: Note });
  const loading = useAppStore((state) => state.loadingMessages);
  const sessionId = useAppStore((state) => state.sessionId);
  useEffect(() => {
    if (!sessionId || loading) return;
    // Restore only when a session finishes loading, never after a draft save.
    runtime.thread.composer.setText(useAppStore.getState().draft);
    let previousText = runtime.thread.composer.getState().text;
    let composing = false;
    let disposed = false;
    const syncDraft = (force = false) => {
      if (disposed || composing) return;
      const composer = runtime.thread.composer.getState();
      if (!composer.text && composer.submission) return;
      if (!force && composer.text === previousText) return;
      previousText = composer.text;
      scheduleDraft(sessionId, composer.text);
    };
    const unsubscribe = runtime.thread.composer.subscribe(syncDraft);
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
  const state = useAppStore(
    useShallow((state) => ({
      messages: state.messages,
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
  const runtime = useExternalStoreRuntime<Message>({
    messages: state.messages,
    convertMessage,
    isLoading: state.loadingMessages,
    isDisabled: state.readOnly || !state.sessionId || state.archived,
    isSendDisabled:
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
        await sendMessage(text);
      } catch (error) {
        report(error);
        throw error;
      }
    },
    onCancel: cancelGeneration,
    adapters: {
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
      <RuntimeBindings runtime={runtime} />
      {children}
    </AssistantRuntimeProvider>
  );
}
