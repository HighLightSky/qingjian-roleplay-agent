"use client";

import dynamic from "next/dynamic";
import {
  ImageIcon,
  ImagesIcon,
  UploadIcon,
  FolderOpenIcon,
  SparklesIcon,
  SquareIcon,
  Loader2Icon,
  Trash2Icon,
  DownloadIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  GenerationSettings,
  ImageDimensions,
} from "@/components/images/generation-settings";
import { PoseControls } from "@/components/images/pose-controls";
import { CharacterReference } from "@/components/images/character-reference";
import { useEffect, useRef, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ImagePreviewDialog } from "@/components/image-preview-dialog";
import { ResourcePicker } from "./resource-picker";
import { saveLibraryImage } from "@/lib/images/library";
import { capabilities } from "@/lib/images/repository";
import type { Capabilities } from "@/lib/images/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { database } from "@/lib/db";
import {
  applyPoseEdit,
  resetPoseEdit,
  type EditBinding,
} from "@/lib/pose-editor/repository";
import type { JsonObject } from "@/lib/scene-images/types";
import { searchScenePoses } from "@/lib/scene-images/poses";
import {
  orderedSceneReferences,
  poseGenerationError,
  selectedScenePose,
} from "@/lib/scene-images/draft";
import { useImageUrl } from "@/hooks/use-image-url";
import { useAppStore, write } from "@/stores/use-app-store";
import {
  startSceneGeneration,
  stopSceneGeneration,
  rejectSceneGeneration,
  followSceneGeneration,
  initialSceneDraft,
  saveSceneDraft,
  addSceneReferences,
} from "@/lib/scene-images/coordinator";
import {
  isActiveGeneration,
  type SceneImagePlan,
  type SceneGeneration,
  type SceneDraft,
} from "@/lib/scene-images/types";

const PoseEditorDialog = dynamic(() => import("./pose-editor-dialog"), {
  ssr: false,
});

function AssetPreview({
  assetId,
  disabled,
  onDiscard,
}: {
  assetId: string;
  disabled: boolean;
  onDiscard(): void;
}) {
  const { url, missing } = useImageUrl(assetId);
  if (missing)
    return (
      <p role="alert" className="text-sm text-destructive">
        图片原件缺失。
      </p>
    );
  if (!url) return null;
  return (
    <div className="grid min-w-0 gap-2">
      <ImagePreviewDialog src={url} name="剧情图.png">
        <button
          type="button"
          aria-label="预览剧情图"
          className="flex w-full justify-center overflow-hidden rounded-lg bg-muted/30"
        >
          <img
            src={url}
            alt="剧情图"
            className="max-h-[65dvh] max-w-full object-contain"
          />
        </button>
      </ImagePreviewDialog>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button variant="ghost" size="sm" asChild>
          <a href={url} download="剧情图.png">
            <DownloadIcon />
            下载图片
          </a>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onDiscard}
          className="text-muted-foreground"
        >
          <Trash2Icon />
          放弃这张
        </Button>
      </div>
    </div>
  );
}
function ReferencePreview({
  assetId,
  number,
  scope,
  character,
}: {
  assetId: string;
  number?: number;
  scope: string;
  character: boolean;
}) {
  const { url, missing } = useImageUrl(assetId, true);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      {url && (
        <img
          src={url}
          alt={number === undefined ? "未使用参考图" : `参考图 ${number}`}
          className="size-14 shrink-0 rounded-md bg-muted/40 object-contain"
        />
      )}
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">
            {number === undefined ? "未使用" : `image${number}`}
          </span>
          <span>{assetId}</span>
          {character && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
              人物
            </span>
          )}
        </div>
        <span
          className="line-clamp-2 break-words text-xs text-muted-foreground"
          title={scope}
        >
          {scope}
        </span>
        {missing && (
          <span className="text-xs text-destructive">图片原件缺失。</span>
        )}
      </div>
    </div>
  );
}
const labels = {
  pending: "准备参考图",
  running: "生成中",
  cancelling: "取消中",
  succeeded: "已生成",
  failed: "生成失败",
  cancelled: "已取消",
  unknown: "结果未知",
};

export function SceneImageCard() {
  const messageId = useAuiState((s) => s.message.id);
  const readOnly = useAppStore((s) => s.readOnly);
  const [plan, setPlan] = useState<SceneImagePlan>();
  const [draft, setDraft] = useState<SceneDraft>();
  const [caps, setCaps] = useState<Capabilities>();
  const [generations, setGenerations] = useState<SceneGeneration[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmEdit, setConfirmEdit] = useState(false);
  const [picker, setPicker] = useState(false);
  const [editing, setEditing] = useState<{
    binding: EditBinding;
    scene: JsonObject;
    original: JsonObject;
    width: number;
    height: number;
  } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const [widthText, setWidthText] = useState("");
  const [heightText, setHeightText] = useState("");
  const loaded = useRef("");
  const writes = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let live = true;
    loaded.current = "";
    let capabilityLoad: Promise<Capabilities> | undefined;
    function showDraft(selected: SceneImagePlan, next: SceneDraft) {
      loaded.current = selected.id;
      setDraft(next);
      setWidthText(String(next.width));
      setHeightText(String(next.height));
    }
    async function load() {
      const db = await database();
      const [plans, generated] = await Promise.all([
        db.getAllFromIndex("sceneImagePlans", "message", messageId),
        db.getAllFromIndex("sceneGenerations", "message", messageId),
      ]);
      if (!live) return;
      const selected = plans
        .sort((a, b) => a.sourceCheckpointVersion - b.sourceCheckpointVersion)
        .at(-1);
      setPlan(selected);
      setGenerations(
        generated.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
      if (!selected) return;
      if (selected.draft) {
        if (loaded.current !== selected.id) showDraft(selected, selected.draft);
        else
          setDraft((current) =>
            current &&
            current.poseQuery === selected.draft!.poseQuery &&
            current.poseLibrary === selected.draft!.poseLibrary &&
            current.poseSearch.revision <= selected.draft!.poseSearch.revision
              ? {
                  ...current,
                  poseSearch: selected.draft!.poseSearch,
                  poseEdit: selected.draft!.poseEdit,
                }
              : current,
          );
      }
      const capabilitiesValue = await (capabilityLoad ??= capabilities());
      if (!live) return;
      setCaps(capabilitiesValue);
      if (loaded.current !== selected.id)
        showDraft(selected, initialSceneDraft(selected, capabilitiesValue));
    }
    const refresh = () => {
      void load().catch((e) => setError((e as Error).message));
    };
    refresh();
    window.addEventListener("scene-images-changed", refresh);
    return () => {
      live = false;
      window.removeEventListener("scene-images-changed", refresh);
    };
  }, [messageId]);
  const latest = generations.at(-1);
  const active = generations.some((g) => isActiveGeneration(g.status));
  if (!plan) return null;
  const sizeValid = [widthText, heightText].every(
    (text) => Number.isSafeInteger(Number(text)) && Number(text) > 0,
  );
  const alignment = caps?.imageGeneration.dimensionAlignment;
  const width = alignment
    ? Math.ceil(Number(widthText) / alignment) * alignment
    : undefined;
  const height = alignment
    ? Math.ceil(Number(heightText) / alignment) * alignment
    : undefined;

  function updateDraft(next: SceneDraft) {
    setDraft(next);
    writes.current = writes.current
      .catch(() => {})
      .then(() => saveSceneDraft(plan!.id, next, write));
    void writes.current.catch((e) => setError((e as Error).message));
  }
  async function action(run: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function generate() {
    setConfirmEdit(false);
    void action(async () => {
      await writes.current;
      await startSceneGeneration(plan!.id, write);
    });
  }
  async function addReferences(ids: string[]) {
    await writes.current;
    await addSceneReferences(plan!.id, ids, write);
    const updated = await (await database()).get("sceneImagePlans", plan!.id);
    setPlan(updated!);
    setDraft(updated!.draft!);
  }
  async function editPose() {
    await writes.current;
    const stored = await (await database()).get("sceneImagePlans", plan!.id);
    if (!stored) throw new Error("姿势编辑对应的草稿不存在。");
    const next = initialSceneDraft(stored, caps!);
    const original = next.poseSearch.matches.find(
      (match) => match.poseId === next.poseSearch.selectedPoseId,
    );
    if (!original) throw new Error("请先选择姿势候选。");
    const unit = caps!.imageGeneration.dimensionAlignment;
    setEditing({
      binding: {
        sourcePoseId: original.poseId,
        searchRevision: next.poseSearch.revision,
      },
      scene: structuredClone(selectedScenePose(next).pose),
      original: structuredClone(original.pose),
      width: Math.ceil(next.width / unit) * unit,
      height: Math.ceil(next.height / unit) * unit,
    });
  }
  const disabled = readOnly || busy || active;
  const poseError = draft ? poseGenerationError(draft) : null;
  const showPoseError =
    draft?.poseSearch.status !== "failed" &&
    draft?.poseSearch.status !== "searching";
  const orderedReferences = draft ? orderedSceneReferences(plan, draft) : [];
  const results = generations.filter(
    (g) => g.assetId && g.referenceStatus !== "rejected",
  );
  const currentResult = results.at(-1);
  function renderResult(g: SceneGeneration) {
    return (
      <AssetPreview
        key={g.id}
        assetId={g.assetId!}
        disabled={disabled}
        onDiscard={() => void action(() => rejectSceneGeneration(g.id, write))}
      />
    );
  }
  return (
    <div
      className="mt-4 grid min-w-0 gap-3 rounded-xl border border-border/70 bg-card/40 p-3 text-sm sm:p-4"
      data-testid="scene-image-card"
    >
      <header className="flex flex-wrap items-center gap-2">
        <ImageIcon className="size-4 text-primary" />
        <span className="font-medium">剧情图</span>
        <span
          role="status"
          className={`rounded-full px-2 py-0.5 text-xs ${active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
        >
          {latest ? labels[latest.status] : "待生成"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {active ? (
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly || busy || latest?.status === "cancelling"}
              onClick={() => void action(() => stopSceneGeneration(latest!.id))}
            >
              <SquareIcon />
              {latest?.status === "cancelling" ? "取消中…" : "停止生成"}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={
                disabled ||
                !draft ||
                !sizeValid ||
                !draft.prompt.trim() ||
                !!poseError
              }
              onClick={() =>
                draft!.prompt !== plan.prompt
                  ? setConfirmEdit(true)
                  : generate()
              }
            >
              <SparklesIcon />
              {latest ? "再次生成" : "生成图片"}
            </Button>
          )}
          {busy && (
            <Loader2Icon
              aria-label="正在处理"
              className="size-4 animate-spin"
            />
          )}
          {latest?.error && (active || latest.status === "succeeded") && (
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly || busy}
              onClick={() =>
                void action(() => followSceneGeneration(latest.id, write))
              }
            >
              <RefreshCwIcon />
              重试取回
            </Button>
          )}
        </div>
      </header>
      {(error || latest?.error) && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error || latest?.error}
        </p>
      )}
      {plan.error && (
        <p className="break-words text-xs text-muted-foreground">
          {plan.error}
        </p>
      )}
      {showPoseError && poseError && (
        <p className="text-xs text-muted-foreground">{poseError}</p>
      )}
      {currentResult && renderResult(currentResult)}
      {results.length > 1 && (
        <details className="group/history">
          <summary className="flex min-h-9 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <ImagesIcon className="size-3.5" />
            历史图片 · {results.length - 1}
          </summary>
          <div className="grid gap-4 pt-2">
            {results.slice(0, -1).reverse().map(renderResult)}
          </div>
        </details>
      )}
      {draft && caps && (
        <GenerationSettings
          resultKey={currentResult?.id}
          summary={`${width ?? draft.width} × ${height ?? draft.height} · ${draft.referenceAssetIds.length} 张参考`}
        >
          <label className="grid min-w-0 gap-2 text-sm font-medium">
            画面描述
            <textarea
              aria-label="生图提示词"
              rows={4}
              value={draft.prompt}
              disabled={disabled}
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
            onSearch={() =>
              void action(async () => {
                await writes.current;
                await searchScenePoses(plan!.id, write);
              })
            }
            onEdit={() => void action(editPose)}
            onReset={() =>
              void action(async () => {
                await writes.current;
                await resetPoseEdit(plan!.id, write);
              })
            }
          />
          <section
            aria-label="参考图片"
            className="grid min-w-0 gap-3 border-t border-border/60 pt-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="mr-auto flex items-center gap-2 text-sm font-medium">
                <ImagesIcon className="size-4 text-muted-foreground" />
                参考图片
                <span className="text-xs font-normal text-muted-foreground">
                  {draft.referenceAssetIds.length}/
                  {caps.imageGeneration.maxReferenceImages}
                </span>
              </h3>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  disabled ||
                  draft.referenceAssetIds.length >=
                    caps.imageGeneration.maxReferenceImages
                }
                aria-label="从资源库添加"
                onClick={() => setPicker(true)}
              >
                <FolderOpenIcon />
                资源库
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  disabled ||
                  draft.referenceAssetIds.length >=
                    caps.imageGeneration.maxReferenceImages
                }
                aria-label="上传参考图"
                onClick={() => upload.current?.click()}
              >
                <UploadIcon />
                上传
              </Button>
            </div>
            <input
              ref={upload}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              hidden
              aria-label="上传剧情参考图"
              onChange={(e) => {
                const files = Array.from(e.target.files!);
                e.target.value = "";
                void action(async () => {
                  if (
                    draft.referenceAssetIds.length + files.length >
                    caps.imageGeneration.maxReferenceImages
                  )
                    throw new Error("参考图数量超限，请减少图片。");
                  const ids = [];
                  for (const file of files)
                    ids.push(
                      (await saveLibraryImage(file, "uploaded", write)).id,
                    );
                  await addReferences(ids);
                });
              }}
            />
            {!!plan.referenceImages.length && (
              <ul className="grid min-w-0 gap-2">
                {plan.referenceImages.map((ref) => {
                  const selectedIndex = orderedReferences.findIndex(
                    (item) => item.assetId === ref.assetId,
                  );
                  const related = generations.find(
                    (g) => g.id === ref.sourceGenerationId,
                  );
                  return (
                    <li
                      key={ref.assetId}
                      className="flex min-w-0 items-center gap-3 rounded-md bg-muted/20 p-2"
                    >
                      <input
                        type="checkbox"
                        aria-label={`使用参考图 ${ref.assetId}`}
                        disabled={disabled}
                        checked={draft.referenceAssetIds.includes(ref.assetId)}
                        className="accent-primary"
                        onChange={(e) =>
                          updateDraft({
                            ...draft,
                            characterReferenceAssetId:
                              !e.target.checked &&
                              draft.characterReferenceAssetId === ref.assetId
                                ? null
                                : draft.characterReferenceAssetId,
                            referenceAssetIds: e.target.checked
                              ? [...draft.referenceAssetIds, ref.assetId]
                              : draft.referenceAssetIds.filter(
                                  (id) => id !== ref.assetId,
                                ),
                          })
                        }
                      />
                      <ReferencePreview
                        assetId={ref.assetId}
                        number={
                          selectedIndex < 0 ? undefined : selectedIndex + 2
                        }
                        scope={ref.scope}
                        character={
                          draft.poseEnabled &&
                          draft.characterReferenceAssetId === ref.assetId
                        }
                      />
                      {related?.referenceStatus === "rejected" && (
                        <span className="text-xs text-destructive">
                          已放弃，请移除参考
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {draft.poseEnabled && (
              <CharacterReference
                value={draft.characterReferenceAssetId}
                disabled={disabled}
                options={orderedReferences.map((ref) => ({
                  id: ref.assetId,
                  label: `${ref.assetId} · ${ref.scope}`,
                }))}
                onChange={(value) =>
                  updateDraft({ ...draft, characterReferenceAssetId: value })
                }
              />
            )}
          </section>
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
          onClose={() => setEditing(null)}
          onApply={async (scene) => {
            await writes.current;
            await applyPoseEdit(plan.id, editing.binding, scene, write);
          }}
        />
      )}
      <ResourcePicker
        open={picker}
        onOpenChange={setPicker}
        excluded={draft?.referenceAssetIds ?? []}
        limit={
          (caps?.imageGeneration.maxReferenceImages ?? 0) -
          (draft?.referenceAssetIds.length ?? 0)
        }
        onSelect={addReferences}
      />
      <Dialog open={confirmEdit} onOpenChange={setConfirmEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认修改后的提示词</DialogTitle>
            <DialogDescription>
              修改提示词可能导致视觉上下文不连贯，是否要继续？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmEdit(false)}>
              返回修改
            </Button>
            <Button disabled={disabled} onClick={generate}>
              继续生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
