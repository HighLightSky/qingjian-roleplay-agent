"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ImageIcon,
  ImagesIcon,
  Loader2Icon,
  XIcon,
  UploadIcon,
  FolderOpenIcon,
  SparklesIcon,
  SquareIcon,
  DownloadIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { ImagePreviewDialog } from "@/components/image-preview-dialog";
import { ResourcePicker } from "@/components/chat/resource-picker";
import {
  GenerationSettings,
  ImageDimensions,
} from "@/components/images/generation-settings";
import { PoseControls } from "@/components/images/pose-controls";
import { CharacterReference } from "@/components/images/character-reference";
import {
  capabilities,
  getOriginal,
  validateImageBlob,
} from "@/lib/images/repository";
import { discardLibraryImage, saveLibraryImage } from "@/lib/images/library";
import {
  generateDirectImage,
  orderedDirectReferences,
  type DirectReference,
} from "@/lib/images/direct-generation";
import { stopSceneGeneration } from "@/lib/scene-images/coordinator";
import {
  emptyPoseSearch,
  poseGenerationError,
  selectedScenePose,
} from "@/lib/scene-images/draft";
import { requestPoseSearch } from "@/lib/scene-images/pose-search";
import { validatePoseJson } from "@/lib/scene-images/pose-json";
import { POSE_RUNTIME_REVISION } from "@/lib/pose-editor/version";
import type { Capabilities } from "@/lib/images/types";
import type {
  SceneTaskSnapshot,
  SceneDraft,
  JsonObject,
} from "@/lib/scene-images/types";
import { id } from "@/lib/domain";
import { initialize, useAppStore, write } from "@/stores/use-app-store";

const PoseEditorDialog = dynamic(
  () => import("@/components/chat/pose-editor-dialog"),
  { ssr: false },
);

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
  if (!url) return null;
  return (
    <div className="grid min-w-0 gap-2">
      <ImagePreviewDialog src={url} name={file.name}>
        <button
          type="button"
          aria-label={generated ? "预览生成结果" : `预览 ${file.name}`}
          className={
            generated
              ? "flex w-full justify-center overflow-hidden rounded-lg bg-muted/30"
              : "shrink-0"
          }
        >
          <img
            src={url}
            alt={generated ? "生成结果" : file.name}
            className={
              generated
                ? "max-h-[65dvh] max-w-full object-contain"
                : "size-16 rounded-md bg-muted/40 object-contain"
            }
          />
        </button>
      </ImagePreviewDialog>
      {generated && (
        <Button variant="ghost" size="sm" asChild className="justify-self-end">
          <a href={url} download={file.name}>
            <DownloadIcon />
            下载到本地
          </a>
        </Button>
      )}
    </div>
  );
}

export default function ImagesPage() {
  const ready = useAppStore((s) => s.ready);
  const bootError = useAppStore((s) => s.bootError);
  const readOnly = useAppStore((s) => s.readOnly);
  const [caps, setCaps] = useState<Capabilities>();
  const [draft, setDraft] = useState<SceneDraft>();
  const currentDraft = useRef<SceneDraft | undefined>(undefined);
  const [references, setReferences] = useState<DirectReference[]>([]);
  const nextReference = useRef(1);
  const [widthText, setWidthText] = useState("");
  const [heightText, setHeightText] = useState("");
  const [result, setResult] = useState<File>();
  const [savedAssetId, setSavedAssetId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [snapshot, setSnapshot] = useState<SceneTaskSnapshot>();
  const [error, setError] = useState("");
  const [picker, setPicker] = useState(false);
  const [editing, setEditing] = useState<{
    poseId: string;
    revision: number;
    scene: JsonObject;
    original: JsonObject;
    width: number;
    height: number;
  }>();
  const upload = useRef<HTMLInputElement>(null);
  const generation = useRef<AbortController | null>(null);
  const searchRequest = useRef<AbortController | null>(null);

  function updateDraft(next: SceneDraft) {
    currentDraft.current = next;
    setDraft(next);
  }
  useEffect(() => {
    void initialize();
    const controller = new AbortController();
    void capabilities(controller.signal)
      .then((value) => {
        setCaps(value);
        const initial: SceneDraft = {
          prompt: "",
          width: value.imageGeneration.defaultWidth,
          height: value.imageGeneration.defaultHeight,
          referenceAssetIds: [],
          poseEnabled: false,
          poseQuery: "",
          poseLibrary: "default",
          characterReferenceAssetId: null,
          poseSearch: emptyPoseSearch(),
          poseEdit: null,
        };
        updateDraft(initial);
        setWidthText(String(initial.width));
        setHeightText(String(initial.height));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => {
      controller.abort();
      generation.current?.abort();
      searchRequest.current?.abort();
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
  function addReferences(added: { file: File; libraryAssetId?: string }[]) {
    const next = [
      ...references,
      ...added.map((ref) => ({
        ...ref,
        assetId: `img${nextReference.current++}`,
      })),
    ];
    setReferences(next);
    updateDraft({
      ...currentDraft.current!,
      referenceAssetIds: next.map((ref) => ref.assetId),
    });
  }
  function removeReference(assetId: string) {
    setReferences(references.filter((ref) => ref.assetId !== assetId));
    const current = currentDraft.current!;
    updateDraft({
      ...current,
      referenceAssetIds: current.referenceAssetIds.filter(
        (key) => key !== assetId,
      ),
      characterReferenceAssetId:
        current.characterReferenceAssetId === assetId
          ? null
          : current.characterReferenceAssetId,
    });
  }
  async function searchPoses() {
    searchRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    const current = currentDraft.current!;
    const revision = current.poseSearch.revision + 1;
    updateDraft({
      ...current,
      poseEdit: null,
      poseSearch: {
        ...emptyPoseSearch(revision),
        status: "searching",
        query: current.poseQuery,
      },
    });
    try {
      const matches = await requestPoseSearch(
        current.poseQuery,
        current.poseLibrary,
        caps!.imageGeneration,
        controller.signal,
      );
      const next = currentDraft.current!;
      if (next.poseSearch.revision !== revision || controller.signal.aborted)
        return;
      updateDraft({
        ...next,
        poseSearch: {
          status: "succeeded",
          revision,
          query: current.poseQuery,
          matches,
          selectedPoseId: null,
          error: null,
        },
      });
    } catch (reason) {
      if (
        controller.signal.aborted ||
        currentDraft.current!.poseSearch.revision !== revision
      )
        return;
      updateDraft({
        ...currentDraft.current!,
        poseSearch: {
          ...emptyPoseSearch(revision),
          status: "failed",
          query: current.poseQuery,
          error: (reason as Error).message,
        },
      });
    }
  }
  function openEditor() {
    const current = currentDraft.current!;
    const original = current.poseSearch.matches.find(
      (match) => match.poseId === current.poseSearch.selectedPoseId,
    )!;
    const unit = caps!.imageGeneration.dimensionAlignment;
    setEditing({
      poseId: original.poseId,
      revision: current.poseSearch.revision,
      original: structuredClone(original.pose),
      scene: structuredClone(selectedScenePose(current).pose),
      width: Math.ceil(current.width / unit) * unit,
      height: Math.ceil(current.height / unit) * unit,
    });
  }
  async function generate() {
    const current = currentDraft.current!;
    const input = {
      prompt: current.prompt,
      references: [...references],
      pose: current.poseEnabled
        ? {
            width: current.width,
            height: current.height,
            query: current.poseQuery,
            characterReferenceAssetId: current.characterReferenceAssetId!,
            selection: structuredClone(selectedScenePose(current)),
          }
        : null,
    };
    setResult(undefined);
    setSavedAssetId(undefined);
    setSnapshot(undefined);
    const controller = new AbortController();
    generation.current = controller;
    setGenerating(true);
    await action(async () => {
      const blob = await generateDirectImage(
        input,
        caps!,
        id(),
        controller.signal,
        setSnapshot,
      );
      setResult(
        new File([blob], `生成图片-${Date.now()}.png`, { type: "image/png" }),
      );
    });
    generation.current = null;
    setGenerating(false);
  }
  const disabled = !ready || readOnly || busy || !caps;
  const sizeValid = [widthText, heightText].every(
    (text) =>
      text.trim() && Number.isSafeInteger(Number(text)) && Number(text) > 0,
  );
  const poseError = draft ? poseGenerationError(draft) : null;
  const showPoseError =
    draft?.poseSearch.status !== "failed" &&
    draft?.poseSearch.status !== "searching";
  const limit = caps
    ? draft?.poseEnabled
      ? caps.imageGeneration.maxReferenceImages
      : caps.maxImages
    : 0;
  const ordered = orderedDirectReferences(
    references,
    draft?.poseEnabled ? draft.characterReferenceAssetId : null,
  );
  return (
    <main className="mx-auto h-dvh w-full max-w-4xl overflow-y-auto px-4 py-5 sm:px-8 sm:py-8">
      <header className="mb-5 flex flex-wrap items-center gap-2 sm:gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/" aria-label="返回对话">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <ImageIcon className="size-5 text-primary" />
        <h1 className="text-lg font-semibold">直接生图</h1>
        {generating && (
          <span
            role="status"
            className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary"
          >
            {snapshot?.status === "cancelling" ? "取消中…" : "生成中"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {generating && snapshot && !snapshot.terminal ? (
            <Button
              variant="outline"
              disabled={snapshot.status === "cancelling"}
              onClick={async () => {
                try {
                  await stopSceneGeneration(snapshot.runId);
                  setSnapshot((value) =>
                    value?.terminal
                      ? value
                      : { ...snapshot, status: "cancelling" },
                  );
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <SquareIcon />
              停止生成
            </Button>
          ) : (
            <Button
              disabled={
                disabled ||
                !draft ||
                !caps!.imageGeneration.enabled ||
                !draft.prompt.trim() ||
                !references.length ||
                references.length > limit ||
                !!poseError ||
                (draft.poseEnabled && !sizeValid)
              }
              onClick={() => void generate()}
            >
              {generating ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <SparklesIcon />
              )}
              生成图片
            </Button>
          )}
        </div>
      </header>
      {(error || bootError) && (
        <p role="alert" className="mb-4 break-words text-sm text-destructive">
          {error || bootError}
        </p>
      )}
      {caps && !caps.imageGeneration.enabled && (
        <p className="mb-4 text-sm text-destructive">
          服务端尚未配置生图服务。
        </p>
      )}
      {readOnly && (
        <p className="mb-4 text-sm text-muted-foreground">
          此标签页为只读，请关闭另一标签页后刷新。
        </p>
      )}
      {showPoseError && poseError && (
        <p className="mb-4 text-xs text-muted-foreground">{poseError}</p>
      )}
      {result && (
        <section aria-label="生成结果" className="mb-5 grid gap-2">
          <FilePreview file={result} generated />
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-xs text-muted-foreground">
              {savedAssetId ? "已保存到资源库" : "临时结果，保存后可保留"}
            </span>
            <Button
              variant="outline"
              size="sm"
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
              <SaveIcon />
              {savedAssetId ? "已保存到资源库" : "保存到浏览器资源库"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
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
              <Trash2Icon />
              放弃这张
            </Button>
          </div>
        </section>
      )}
      {generating && !result && (
        <div
          role="status"
          className="mb-5 flex items-center justify-center gap-2 rounded-lg bg-muted/30 py-12 text-sm text-muted-foreground"
        >
          <Loader2Icon className="size-4 animate-spin" />
          正在处理图片，请稍候…
        </div>
      )}
      {draft && caps && (
        <GenerationSettings
          resultKey={result?.name}
          summary={
            draft.poseEnabled
              ? `${draft.width} × ${draft.height} · 姿势参考 · ${references.length} 张参考`
              : `图片编辑 · ${references.length} 张参考`
          }
        >
          <label className="grid min-w-0 gap-2 text-sm font-medium">
            画面描述
            <textarea
              aria-label="直接生图提示词"
              rows={4}
              value={draft.prompt}
              disabled={disabled}
              maxLength={caps.imageGeneration.maxPromptCharacters}
              placeholder="描述希望生成的画面或如何修改图片…"
              onChange={(e) =>
                updateDraft({ ...draft, prompt: e.target.value })
              }
              className="min-h-24 w-full resize-y rounded-md border border-input bg-background p-3 text-sm font-normal leading-relaxed focus-visible:outline-ring"
            />
          </label>
          <PoseControls
            draft={draft}
            disabled={disabled}
            canEdit={sizeValid}
            onChange={updateDraft}
            onSearch={() => void searchPoses()}
            onEdit={openEditor}
            onReset={() => updateDraft({ ...draft, poseEdit: null })}
          />
          <section
            aria-label="参考图片"
            className="grid min-w-0 gap-3 border-t border-border/60 pt-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-auto flex items-center gap-2 text-sm font-medium">
                <ImagesIcon className="size-4 text-muted-foreground" />
                参考图片
                <span className="text-xs font-normal text-muted-foreground">
                  {references.length}/{limit}
                </span>
              </h2>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || references.length >= limit}
                aria-label="直接上传参考图"
                onClick={() => upload.current?.click()}
              >
                <UploadIcon />
                上传
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || references.length >= limit}
                aria-label="从浏览器资源库选择"
                onClick={() => setPicker(true)}
              >
                <FolderOpenIcon />
                资源库
              </Button>
            </div>
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
                  if (references.length + files.length > limit)
                    throw new Error(`最多选择 ${limit} 张参考图。`);
                  for (const file of files)
                    await validateImageBlob(file, { ...caps.imageGeneration });
                  addReferences(files.map((file) => ({ file })));
                });
              }}
            />
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              {references.map((ref, index) => (
                <div
                  key={ref.assetId}
                  className="flex min-w-0 items-center gap-3 rounded-md bg-muted/20 p-2"
                >
                  <FilePreview file={ref.file} />
                  <div className="grid min-w-0 flex-1 gap-1.5">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">
                        image
                        {ordered.findIndex(
                          (item) => item.assetId === ref.assetId,
                        ) + (draft.poseEnabled ? 2 : 1)}
                      </span>
                      {draft.poseEnabled &&
                        draft.characterReferenceAssetId === ref.assetId && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                            人物
                          </span>
                        )}
                      {!draft.poseEnabled && index === 0 && (
                        <span className="text-muted-foreground">编辑目标</span>
                      )}
                    </div>
                    <span
                      className="truncate text-xs text-muted-foreground"
                      title={ref.file.name}
                    >
                      {ref.file.name}
                    </span>
                  </div>
                  <TooltipIconButton
                    tooltip={`移除参考图 ${index + 1}`}
                    aria-label={`移除参考图 ${index + 1}`}
                    disabled={disabled}
                    onClick={() => removeReference(ref.assetId)}
                    className="size-9 shrink-0"
                  >
                    <XIcon />
                  </TooltipIconButton>
                </div>
              ))}
            </div>
            {references.length > limit && (
              <p role="alert" className="text-sm text-destructive">
                姿势模式最多使用 {limit} 张参考图，请移除多余图片。
              </p>
            )}
            {draft.poseEnabled && (
              <CharacterReference
                value={draft.characterReferenceAssetId}
                options={references.map((ref) => ({
                  id: ref.assetId,
                  label: ref.file.name,
                }))}
                disabled={disabled}
                onChange={(value) =>
                  updateDraft({ ...draft, characterReferenceAssetId: value })
                }
              />
            )}
          </section>
          {draft.poseEnabled && (
            <ImageDimensions
              width={widthText}
              height={heightText}
              alignment={caps.imageGeneration.dimensionAlignment}
              disabled={disabled}
              onWidthChange={(text) => {
                setWidthText(text);
                const value = Number(text);
                if (Number.isSafeInteger(value) && value > 0)
                  updateDraft({ ...draft, width: value });
              }}
              onHeightChange={(text) => {
                setHeightText(text);
                const value = Number(text);
                if (Number.isSafeInteger(value) && value > 0)
                  updateDraft({ ...draft, height: value });
              }}
            />
          )}
        </GenerationSettings>
      )}
      {editing && caps && (
        <PoseEditorDialog
          scene={editing.scene}
          originalScene={editing.original}
          width={editing.width}
          height={editing.height}
          maxPixels={caps.imageGeneration.maxPixels}
          maxEdge={caps.imageGeneration.maxEdge}
          onClose={() => setEditing(undefined)}
          onApply={async (scene) => {
            validatePoseJson(scene, caps.imageGeneration.poseMaxBytes);
            const current = currentDraft.current!;
            if (
              current.poseSearch.selectedPoseId !== editing.poseId ||
              current.poseSearch.revision !== editing.revision
            )
              throw new Error("姿势候选或检索版本已变化，请重新打开编辑器。");
            updateDraft({
              ...current,
              poseEdit: {
                sourcePoseId: editing.poseId,
                searchRevision: editing.revision,
                runtimeRevision: POSE_RUNTIME_REVISION,
                scene: structuredClone(scene),
              },
            });
          }}
        />
      )}
      <ResourcePicker
        open={picker}
        onOpenChange={setPicker}
        excluded={references.flatMap((ref) =>
          ref.libraryAssetId ? [ref.libraryAssetId] : [],
        )}
        limit={Math.max(0, limit - references.length)}
        onSelect={async (ids) => {
          const selected = await Promise.all(ids.map(getOriginal));
          addReferences(
            selected.map((asset) => ({
              libraryAssetId: asset.id,
              file: new File([asset.originalBlob], asset.displayName, {
                type: asset.mimeType,
              }),
            })),
          );
        }}
      />
    </main>
  );
}
