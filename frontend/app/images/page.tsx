"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, ImagePlusIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImagePreviewDialog } from "@/components/image-preview-dialog";
import { ResourcePicker } from "@/components/chat/resource-picker";
import {
  capabilities,
  getOriginal,
  validateImageBlob,
} from "@/lib/images/repository";
import { discardLibraryImage, saveLibraryImage } from "@/lib/images/library";
import { generateDirectImage } from "@/lib/images/direct-generation";
import { stopSceneGeneration } from "@/lib/scene-images/coordinator";
import type { Capabilities } from "@/lib/images/types";
import type { SceneTaskSnapshot } from "@/lib/scene-images/types";
import { id } from "@/lib/domain";
import { initialize, useAppStore, write } from "@/stores/use-app-store";

type Reference = { key: string; file: File; assetId?: string };
function FilePreview({
  file,
  generated = false,
}: {
  file: File;
  generated?: boolean;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return (
    url && (
      <div className="grid gap-2">
        <ImagePreviewDialog src={url} name={file.name}>
          <button
            type="button"
            aria-label={generated ? "预览生成结果" : `预览 ${file.name}`}
          >
            <img
              src={url}
              alt={generated ? "生成结果" : file.name}
              className={
                generated
                  ? "max-h-[60dvh] w-full rounded object-contain"
                  : "h-28 w-full rounded object-contain"
              }
            />
          </button>
        </ImagePreviewDialog>
        {generated && (
          <a href={url} download={file.name} className="text-sm text-primary">
            下载到本地
          </a>
        )}
      </div>
    )
  );
}

export default function ImagesPage() {
  const ready = useAppStore((s) => s.ready);
  const bootError = useAppStore((s) => s.bootError);
  const readOnly = useAppStore((s) => s.readOnly);
  const [caps, setCaps] = useState<Capabilities>();
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState<Reference[]>([]);
  const [result, setResult] = useState<File>();
  const [savedAssetId, setSavedAssetId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<SceneTaskSnapshot>();
  const [error, setError] = useState("");
  const [picker, setPicker] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const generation = useRef<AbortController | null>(null);
  useEffect(() => {
    void initialize();
    const controller = new AbortController();
    void capabilities(controller.signal)
      .then(setCaps)
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => {
      controller.abort();
      generation.current?.abort();
    };
  }, []);
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function generate() {
    setResult(undefined);
    setSavedAssetId(undefined);
    setSnapshot(undefined);
    const controller = new AbortController();
    generation.current = controller;
    await action(async () => {
      const blob = await generateDirectImage(
        prompt,
        references.map((ref) => ref.file),
        id(),
        controller.signal,
        setSnapshot,
      );
      setResult(
        new File([blob], `生成图片-${Date.now()}.png`, { type: "image/png" }),
      );
    });
    generation.current = null;
  }
  const disabled = !ready || readOnly || busy || !caps;
  return (
    <main className="mx-auto h-dvh w-full max-w-5xl overflow-y-auto p-4 sm:p-8">
      <header className="mb-8 flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/" aria-label="返回对话">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <ImagePlusIcon className="text-primary" />
        <h1 className="text-xl font-semibold">直接生图</h1>
      </header>
      <div className="grid gap-8 md:grid-cols-2">
        <section className="grid content-start gap-4">
          <p className="text-sm text-muted-foreground">
            第一张图片作为编辑目标，其余作为参考。提示词可使用
            &lt;image1&gt;、&lt;image2&gt; 指定图片。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={disabled || references.length >= caps!.maxImages}
              onClick={() => upload.current?.click()}
            >
              直接上传参考图
            </Button>
            <Button
              variant="outline"
              disabled={disabled || references.length >= caps!.maxImages}
              onClick={() => setPicker(true)}
            >
              从浏览器资源库选择
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            直接上传的参考图仅用于本页，不自动保存。最多 {caps?.maxImages} 张。
          </p>
          <input
            ref={upload}
            type="file"
            accept="image/png,image/jpeg"
            multiple
            hidden
            aria-label="上传生图参考图"
            onChange={(event) => {
              const files = Array.from(event.target.files!);
              event.target.value = "";
              void action(async () => {
                if (references.length + files.length > caps!.maxImages)
                  throw new Error(`最多选择 ${caps!.maxImages} 张参考图。`);
                for (const file of files)
                  await validateImageBlob(file, { ...caps!.imageGeneration });
                setReferences((current) => [
                  ...current,
                  ...files.map((file) => ({ key: id(), file })),
                ]);
              });
            }}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {references.map((ref, index) => (
              <div key={ref.key} className="min-w-0 rounded border p-2">
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span>&lt;image{index + 1}&gt;</span>
                  <button
                    aria-label={`移除参考图 ${index + 1}`}
                    disabled={disabled}
                    onClick={() =>
                      setReferences((current) =>
                        current.filter((item) => item.key !== ref.key),
                      )
                    }
                  >
                    <XIcon className="size-4" />
                  </button>
                </div>
                <FilePreview file={ref.file} />
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {ref.file.name}
                </p>
              </div>
            ))}
          </div>
          <label className="grid gap-2 text-sm">
            生图提示词
            <textarea
              aria-label="直接生图提示词"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={disabled}
              maxLength={caps?.imageGeneration.maxPromptCharacters}
              placeholder="描述希望如何修改图片…"
              className="min-h-40 w-full rounded border bg-background p-3"
            />
          </label>
          {caps && !caps.imageGeneration.enabled && (
            <p className="text-sm text-destructive">服务端尚未配置生图服务。</p>
          )}
          {readOnly && (
            <p className="text-sm text-muted-foreground">
              此标签页为只读，请关闭另一标签页后刷新。
            </p>
          )}
          {(error || bootError) && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error || bootError}
            </p>
          )}
          <div className="flex gap-3">
            <Button
              disabled={
                disabled ||
                !caps!.imageGeneration.enabled ||
                !prompt.trim() ||
                !references.length
              }
              onClick={() => void generate()}
            >
              {busy && <Loader2Icon className="animate-spin" />}
              {busy
                ? snapshot?.status === "cancelling"
                  ? "取消中…"
                  : "处理中…"
                : "生成图片"}
            </Button>
            {busy && snapshot && !snapshot.terminal && (
              <Button
                variant="outline"
                disabled={snapshot.status === "cancelling"}
                onClick={async () => {
                  try {
                    await stopSceneGeneration(snapshot.runId);
                    setSnapshot((current) =>
                      current?.terminal
                        ? current
                        : { ...snapshot, status: "cancelling" },
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                停止生成
              </Button>
            )}
          </div>
        </section>
        <section className="grid content-start gap-4">
          <h2 className="font-medium">生成结果</h2>
          <p className="text-sm text-muted-foreground">
            结果默认临时保留，离开页面、刷新或再次生成会丢失。需要留存时，请保存到浏览器资源库或下载到本地。
          </p>
          {result ? (
            <>
              <FilePreview file={result} generated />
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  disabled={disabled || !!savedAssetId}
                  onClick={() =>
                    void action(async () => {
                      const asset = await saveLibraryImage(
                        result,
                        "generated",
                        write,
                      );
                      setSavedAssetId(asset.id);
                    })
                  }
                >
                  {savedAssetId ? "已保存到资源库" : "保存到浏览器资源库"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    void action(async () => {
                      if (savedAssetId)
                        await discardLibraryImage(savedAssetId, write);
                      setResult(undefined);
                      setSavedAssetId(undefined);
                    })
                  }
                >
                  放弃这张
                </Button>
              </div>
            </>
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {busy ? "正在处理图片，请稍候…" : "生成的图片会显示在这里"}
            </p>
          )}
        </section>
      </div>
      <ResourcePicker
        open={picker}
        onOpenChange={setPicker}
        excluded={references.flatMap((ref) =>
          ref.assetId ? [ref.assetId] : [],
        )}
        limit={(caps?.maxImages ?? 0) - references.length}
        onSelect={async (ids) => {
          const selected = await Promise.all(ids.map(getOriginal));
          setReferences((current) => [
            ...current,
            ...selected.map((asset) => ({
              key: id(),
              assetId: asset.id,
              file: new File([asset.originalBlob], asset.displayName, {
                type: asset.mimeType,
              }),
            })),
          ]);
        }}
      />
    </main>
  );
}
