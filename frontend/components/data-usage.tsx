"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScoreBreakdown } from "@/components/assistant-ui/elements/score-breakdown";
import {
  formatBytes,
  localDataUsage,
  type LocalDataUsage,
} from "@/lib/data-usage";
import {
  browserStorageStatus,
  type BrowserStorageStatus,
} from "@/lib/browser-storage";
import {
  imageCacheRequest,
  type ImageCacheStats,
  type ImageCacheClearResult,
} from "@/lib/image-cache";
import { errorText } from "@/lib/domain";
import { useAppStore } from "@/stores/use-app-store";

function LocalDataCard({
  revision,
  clearing,
  refresh,
}: {
  revision: number;
  clearing: boolean;
  refresh: () => void;
}) {
  const [usage, setUsage] = useState<LocalDataUsage>();
  const [error, setError] = useState("");
  const [storage, setStorage] = useState<BrowserStorageStatus>();
  useEffect(() => {
    let disposed = false;
    setUsage(undefined);
    setError("");
    setStorage(undefined);
    void localDataUsage().then(
      (value) => {
        if (!disposed) setUsage(value);
      },
      (reason) => {
        if (!disposed) setError(errorText(reason));
      },
    );
    void browserStorageStatus().then((value) => {
      if (!disposed) setStorage(value);
    });
    return () => {
      disposed = true;
    };
  }, [revision]);

  return (
    <section aria-label="本地数据明细" className="border-t pt-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">本地数据明细</h3>
        <Button variant="ghost" size="sm" disabled={clearing} onClick={refresh}>
          <RefreshCwIcon />
          刷新数据
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !usage ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在统计已保存的本地数据…
        </p>
      ) : (
        <>
          <ScoreBreakdown
            total={usage.bytes}
            label="应用数据估算容量"
            summary={`${usage.characters.length} 个角色 · ${usage.sessionCount} 段对话 · ${usage.messageCount} 条消息 · ${usage.imageCount} 张图片`}
            criteria={[
              ...usage.characters.map((character) => ({
                id: `character:${character.id}`,
                label: `${character.name}${character.archived ? "（已归档）" : ""}`,
                bytes: character.bytes,
                note: `${character.sessionCount} 段对话 · ${character.messageCount} 条消息 · ${character.imageCount} 张图片；归属容量，不含共享图片`,
              })),
              {
                id: "shared",
                label: "共享图片",
                bytes: usage.sharedImages.bytes,
                note: `${usage.sharedImages.imageCount} 张跨角色共用图片，容量只计一次`,
              },
              {
                id: "public",
                label: "公共数据",
                bytes: usage.publicData.bytes,
                note: `设置、角色编辑草稿及其独有图片（${usage.publicData.imageCount} 张）`,
              },
            ]}
          />
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            按已保存记录的 UTF-8
            大小及原图、缩略图大小估算，不含浏览器内部索引和压缩开销。共用图片计入各角色的图片数量，角色图片数量不能直接相加。
          </p>
        </>
      )}
      <div className="mt-4 space-y-1 text-xs leading-5 text-muted-foreground">
        {!storage ? (
          <p>正在查询浏览器存储状态…</p>
        ) : (
          <>
            {storage.usage !== undefined && (
              <p>
                浏览器报告本站约占用 {formatBytes(storage.usage)}
                ，与应用数据估算分别计量。
              </p>
            )}
            {storage.errors.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function ImageCacheCard({
  revision,
  clearing,
  onClearing,
}: {
  revision: number;
  clearing: boolean;
  onClearing: (value: boolean) => void;
}) {
  const busy = useAppStore(
    (state) =>
      state.busy || state.activeSessionId !== null || state.preparingInput,
  );
  const readOnly = useAppStore((state) => state.readOnly);
  const [stats, setStats] = useState<ImageCacheStats>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    setStats(undefined);
    setError("");
    setNotice("");
    void imageCacheRequest<ImageCacheStats>("stats", request.signal).then(
      (value) => {
        if (!request.signal.aborted) setStats(value);
      },
      (reason) => {
        if (!request.signal.aborted)
          setError(`无法读取后端图片缓存：${errorText(reason)}`);
      },
    );
    return () => request.abort();
  }, [revision]);

  async function clear() {
    if (pending.current) return;
    pending.current = true;
    onClearing(true);
    setError("");
    setNotice("");
    const signal = controller.current!.signal;
    try {
      const released = await imageCacheRequest<ImageCacheClearResult>(
        "clear",
        signal,
      );
      if (signal.aborted) return;
      setNotice(
        `已释放 ${released.releasedImageCount} 张图片缓存，原图数据容量 ${formatBytes(released.releasedBytes)}。`,
      );
      setStats(undefined);
      const value = await imageCacheRequest<ImageCacheStats>("stats", signal);
      if (!signal.aborted) setStats(value);
    } catch (reason) {
      if (!signal.aborted) {
        setStats(undefined);
        setError(errorText(reason));
      }
    } finally {
      pending.current = false;
      if (!signal.aborted) onClearing(false);
    }
  }

  return (
    <section aria-label="后端图片缓存" className="border-t pt-5">
      <h3 className="mb-4 text-sm font-medium">后端图片缓存</h3>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !stats ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在查询后端图片缓存…
        </p>
      ) : (
        <ScoreBreakdown
          total={stats.bytes}
          label="原图数据容量"
          summary={`当前浏览器图片对应的缓存 · ${stats.imageCount} 张`}
          criteria={[
            {
              id: "idle",
              label: "未被任务使用",
              bytes: stats.bytes - stats.inUseBytes,
              note: `${stats.imageCount - stats.inUseImageCount} 张图片`,
            },
            {
              id: "in-use",
              label: "任务使用中",
              bytes: stats.inUseBytes,
              note: `${stats.inUseImageCount} 张图片，任务结束后可释放`,
            },
          ]}
        />
      )}
      <Button
        className="mt-4"
        variant="outline"
        size="sm"
        disabled={
          readOnly || busy || clearing || !stats || stats.imageCount === 0
        }
        onClick={() => void clear()}
      >
        {clearing ? "正在释放…" : "释放图片缓存"}
      </Button>
      {busy && (
        <p className="mt-2 text-xs text-muted-foreground">
          请在当前任务完成后释放缓存。
        </p>
      )}
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        释放后，下次对话会按需从本地自动上传原图。本地图片和对话记录保留。
      </p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        这里只统计本地图片哈希命中的后端原图数据。释放相同图片的共享缓存后，其他浏览器也可能需要重新上传。
      </p>
      {notice && (
        <p role="status" className="mt-3 text-sm leading-6">
          {notice}
        </p>
      )}
    </section>
  );
}

export function DataUsage() {
  const [revision, setRevision] = useState(0);
  const [clearing, setClearing] = useState(false);
  return (
    <div className="space-y-5">
      <LocalDataCard
        revision={revision}
        clearing={clearing}
        refresh={() => setRevision((value) => value + 1)}
      />
      <ImageCacheCard
        revision={revision}
        clearing={clearing}
        onClearing={setClearing}
      />
    </div>
  );
}
