"use client";

import { useEffect, useState } from "react";
import { ChevronRightIcon, MessageSquareQuoteIcon } from "lucide-react";
import { database } from "@/lib/db";
import {
  errorText,
  plainText,
  visibleCharacters,
  type Message,
} from "@/lib/domain";
import {
  loadEarlier,
  report,
  selectSession,
  useAppStore,
} from "@/stores/use-app-store";

async function showSource(message: Message) {
  useAppStore.setState({ memoryOpen: false });
  if (useAppStore.getState().sessionId !== message.sessionId)
    await selectSession(message.sessionId);
  while (
    useAppStore.getState().hasEarlier &&
    !useAppStore.getState().messages.some((entry) => entry.id === message.id)
  )
    await loadEarlier();
  requestAnimationFrame(() =>
    document
      .getElementById(`message:${message.id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" }),
  );
}

function preview(message: Message) {
  const text = plainText(message).replace(/\s+/g, " ").trim();
  if (!text) return "图片消息";
  const chars = visibleCharacters(text);
  return chars.slice(0, 24).join("") + (chars.length > 24 ? "…" : "");
}

export function SourceLinks({ ids }: { ids: string[] }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{
    key: string;
    messages: (Message | undefined)[];
  }>();
  const [error, setError] = useState("");
  const key = JSON.stringify(ids);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError("");
    void (async () => {
      const tx = (await database()).transaction("messages");
      const messages = await Promise.all(
        (JSON.parse(key) as string[]).map((id) => tx.store.get(id)),
      );
      await tx.done;
      if (!cancelled) setLoaded({ key, messages });
    })().catch((cause: unknown) => {
      if (!cancelled) setError(errorText(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [key, open]);

  if (!ids.length) return null;
  return (
    <details
      className="group/sources text-xs text-muted-foreground"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1.5 rounded px-1 text-xs outline-offset-2 transition-colors hover:bg-primary/5 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        <MessageSquareQuoteIcon
          aria-hidden="true"
          className="size-3.5 text-primary/80"
        />
        <span>参考消息 · {ids.length}</span>
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3 transition-transform group-open/sources:rotate-90 motion-reduce:transition-none"
        />
      </summary>
      <div className="mt-1 grid gap-1 border-l border-primary/20 pl-3">
        {error ? (
          <p role="alert">{error}</p>
        ) : loaded?.key !== key ? (
          <p role="status">正在读取消息…</p>
        ) : (
          loaded.messages.map((message, index) =>
            message ? (
              <button
                key={ids[index]}
                type="button"
                className="min-h-8 rounded py-1 text-left leading-5 underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2"
                onClick={() => void showSource(message).catch(report)}
              >
                消息{index + 1}：{preview(message)}
              </button>
            ) : (
              <p key={ids[index]} className="py-1">
                消息{index + 1}：已删除
              </p>
            ),
          )
        )}
      </div>
    </details>
  );
}
