"use client";

import dynamic from "next/dynamic";
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
  withPoseQuery,
  selectedScenePose,
  selectScenePose,
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

function AssetPreview({ assetId }: { assetId: string }) {
  const { url, missing } = useImageUrl(assetId);
  return missing ? (
    <p>图片原件缺失。</p>
  ) : url ? (
    <ImagePreviewDialog src={url} name="剧情图.png">
      <button type="button" aria-label="预览剧情图">
        <img
          src={url}
          alt="剧情图"
          className="mt-2 max-h-[32rem] rounded-lg object-contain"
        />
      </button>
    </ImagePreviewDialog>
  ) : null;
}
function ReferencePreview({
  assetId,
  number,
  scope,
}: {
  assetId: string;
  number?: number;
  scope: string;
}) {
  const { url, missing } = useImageUrl(assetId, true);
  return (
    <li className="flex items-center gap-2 py-1">
      {url && (
        <img
          src={url}
          alt={number === undefined ? "未使用参考图" : `参考图 ${number}`}
          className="h-12 w-12 rounded object-contain"
        />
      )}
      <span>
        {number === undefined ? "未使用参考" : `参考图 ${number}`}：{assetId} ·{" "}
        {scope}
        {missing ? "（原件缺失）" : ""}
      </span>
    </li>
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
  const disabled = readOnly || busy || active;
  const poseError = draft ? poseGenerationError(draft) : null;
  const orderedReferences = draft ? orderedSceneReferences(plan, draft) : [];
  return (
    <div
      className="mt-3 rounded-lg border p-3 text-sm"
      data-testid="scene-image-card"
    >
      <details>
        <summary className="cursor-pointer">
          剧情图 · {latest ? labels[latest.status] : "待生成"}
        </summary>
        {draft ? (
          <div className="mt-3 grid gap-3">
            <label className="grid gap-1">
              生图提示词
              <textarea
                aria-label="生图提示词"
                className="min-h-40 w-full rounded border bg-background p-2 text-xs"
                value={draft.prompt}
                disabled={disabled}
                onChange={(e) =>
                  updateDraft({ ...draft, prompt: e.target.value })
                }
              />
            </label>
            <fieldset className="grid gap-3 rounded border p-3">
              <legend>姿势参考</legend>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label="使用姿势参考"
                  checked={draft.poseEnabled}
                  disabled={disabled}
                  onChange={(e) =>
                    updateDraft({ ...draft, poseEnabled: e.target.checked })
                  }
                />
                使用姿势参考
              </label>
              <label className="grid gap-1">
                姿态检索描述
                <textarea
                  aria-label="姿态检索描述"
                  value={draft.poseQuery}
                  disabled={disabled}
                  className="min-h-24 w-full rounded border bg-background p-2 text-xs"
                  onChange={(e) =>
                    updateDraft(withPoseQuery(draft, e.target.value))
                  }
                />
              </label>
              <p className="text-xs text-muted-foreground">
                描述动作、朝向、四肢、支撑关系和观察角度。关闭姿势参考后，此描述仍会加入普通生图提示词。
              </p>
              <button
                type="button"
                className="justify-self-start"
                disabled={
                  disabled ||
                  !draft.poseEnabled ||
                  !draft.poseQuery.trim() ||
                  draft.poseSearch.status === "searching"
                }
                onClick={() =>
                  void action(async () => {
                    await writes.current;
                    await searchScenePoses(plan!.id, write);
                  })
                }
              >
                重新检索
              </button>
              <div aria-live="polite">
                {draft.poseSearch.status === "searching" && (
                  <p>正在检索姿势…</p>
                )}
                {draft.poseSearch.status === "failed" && (
                  <p role="alert" className="text-destructive">
                    {draft.poseSearch.error}
                  </p>
                )}
                {draft.poseSearch.status === "succeeded" &&
                  !draft.poseSearch.matches.length && (
                    <p>没有姿势候选，请修改描述后重新检索。</p>
                  )}
              </div>
              {draft.poseSearch.matches.map((match) => (
                <label
                  key={match.poseId}
                  className="flex items-start gap-2 rounded border p-2"
                >
                  <input
                    type="radio"
                    name={`pose-${plan.id}`}
                    aria-label={`选择姿势 ${match.description.zh}`}
                    disabled={disabled || !draft.poseEnabled}
                    checked={draft.poseSearch.selectedPoseId === match.poseId}
                    onChange={() =>
                      updateDraft(selectScenePose(draft, match.poseId))
                    }
                  />
                  <span className="grid min-w-0 gap-1 break-words">
                    <span>{match.description.zh}</span>
                    <span className="text-xs text-muted-foreground">
                      {match.description.en}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      相似度：{match.score.toFixed(3)}（非置信概率）
                    </span>
                  </span>
                </label>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={
                    disabled ||
                    !draft.poseEnabled ||
                    !draft.poseSearch.selectedPoseId ||
                    !sizeValid ||
                    !caps
                  }
                  onClick={() =>
                    void action(async () => {
                      await writes.current;
                      const stored = await (
                        await database()
                      ).get("sceneImagePlans", plan!.id);
                      if (!stored)
                        throw new Error("姿势编辑对应的草稿不存在。");
                      const next = initialSceneDraft(stored, caps!);
                      const original = next.poseSearch.matches.find(
                        (match) =>
                          match.poseId === next.poseSearch.selectedPoseId,
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
                    })
                  }
                >
                  编辑姿势
                </button>
                <button
                  type="button"
                  disabled={disabled || !draft.poseEdit}
                  onClick={() =>
                    void action(async () => {
                      await writes.current;
                      await resetPoseEdit(plan!.id, write);
                    })
                  }
                >
                  恢复检索姿势
                </button>
                {draft.poseEdit && <span className="text-xs">已编辑</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                只保留当前候选的编辑，切换候选或重新检索会清除修改。
              </p>
              <label className="grid gap-1">
                人物参考图（image2）
                <select
                  aria-label="人物参考图"
                  value={draft.characterReferenceAssetId ?? ""}
                  disabled={disabled || !draft.poseEnabled}
                  className="min-w-0 rounded border bg-background p-2"
                  onChange={(e) =>
                    updateDraft({
                      ...draft,
                      characterReferenceAssetId: e.target.value || null,
                    })
                  }
                >
                  <option value="">请选择人物参考图</option>
                  {plan.referenceImages
                    .filter((ref) =>
                      draft.referenceAssetIds.includes(ref.assetId),
                    )
                    .map((ref) => (
                      <option key={ref.assetId} value={ref.assetId}>
                        {ref.assetId} · {ref.scope}
                      </option>
                    ))}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">
                候选按描述展示，选择后用于生成图片。
              </p>
            </fieldset>
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1">
                宽度
                <input
                  aria-label="画面宽度"
                  type="number"
                  min="1"
                  className="w-28 rounded border bg-background p-2"
                  value={widthText}
                  disabled={disabled}
                  onChange={(e) => {
                    setWidthText(e.target.value);
                    const value = Number(e.target.value);
                    if (Number.isSafeInteger(value) && value > 0)
                      updateDraft({ ...draft, width: value });
                  }}
                />
              </label>
              <label className="grid gap-1">
                高度
                <input
                  aria-label="画面高度"
                  type="number"
                  min="1"
                  className="w-28 rounded border bg-background p-2"
                  value={heightText}
                  disabled={disabled}
                  onChange={(e) => {
                    setHeightText(e.target.value);
                    const value = Number(e.target.value);
                    if (Number.isSafeInteger(value) && value > 0)
                      updateDraft({ ...draft, height: value });
                  }}
                />
              </label>
              {sizeValid && (
                <span>
                  实际画幅：{width} × {height}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {draft.poseEnabled
                ? "image1 为指定画幅的人偶姿势图，image2 必须为人物参考。"
                : "第一张为指定画幅的黑色画布，普通生图可不选参考。"}
              最多 {caps?.imageGeneration.maxReferenceImages} 张参考图。
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                disabled={
                  disabled ||
                  !caps ||
                  draft.referenceAssetIds.length >=
                    caps.imageGeneration.maxReferenceImages
                }
                onClick={() => setPicker(true)}
              >
                从资源库添加
              </button>
              <button
                disabled={
                  disabled ||
                  !caps ||
                  draft.referenceAssetIds.length >=
                    caps.imageGeneration.maxReferenceImages
                }
                onClick={() => upload.current?.click()}
              >
                上传参考图
              </button>
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
                      caps!.imageGeneration.maxReferenceImages
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
            </div>
            {!!plan?.referenceImages.length && (
              <ul className="text-xs">
                {plan.referenceImages.map((ref) => {
                  const related = generations.find(
                    (g) => g.id === ref.sourceGenerationId,
                  );
                  const selectedIndex = orderedReferences.findIndex(
                    (item) => item.assetId === ref.assetId,
                  );
                  return (
                    <li key={ref.assetId} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label={`使用参考图 ${ref.assetId}`}
                        disabled={disabled}
                        checked={draft.referenceAssetIds.includes(ref.assetId)}
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
                      <ul>
                        <ReferencePreview
                          assetId={ref.assetId}
                          number={
                            selectedIndex < 0 ? undefined : selectedIndex + 2
                          }
                          scope={ref.scope}
                        />
                      </ul>
                      {related?.referenceStatus === "rejected" && (
                        <span>已放弃，请移除参考</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </details>
      {(error || latest?.error) && (
        <p role="alert" className="mt-2 text-destructive">
          {error || latest?.error}
        </p>
      )}
      {plan?.error && (
        <p className="mt-2 text-xs text-muted-foreground">
          {plan.error}。可调整提示词和参考后生成。
        </p>
      )}
      {poseError && (
        <p className="mt-2 text-xs text-muted-foreground">{poseError}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-3">
        {plan && draft && (
          <button
            disabled={
              disabled || !sizeValid || !draft.prompt.trim() || !!poseError
            }
            onClick={() =>
              draft.prompt !== plan.prompt ? setConfirmEdit(true) : generate()
            }
          >
            {latest ? "再次生成" : "生成图片"}
          </button>
        )}
        {latest && ["running", "cancelling"].includes(latest.status) && (
          <button
            disabled={readOnly || busy || latest.status === "cancelling"}
            onClick={() => void action(() => stopSceneGeneration(latest.id))}
          >
            {latest.status === "cancelling" ? "取消中…" : "停止生成"}
          </button>
        )}
        {latest?.error && (active || latest.status === "succeeded") && (
          <button
            disabled={readOnly || busy}
            onClick={() =>
              void action(() => followSceneGeneration(latest.id, write))
            }
          >
            重试取回
          </button>
        )}
      </div>
      {generations
        .filter((g) => g.assetId && g.referenceStatus !== "rejected")
        .map((g) => (
          <div key={g.id}>
            <AssetPreview assetId={g.assetId!} />
            <span className="text-xs text-muted-foreground">
              生成要求，未经图像核实
            </span>
            <button
              className="ml-3 text-xs"
              disabled={readOnly || busy || active}
              onClick={() =>
                void action(() => rejectSceneGeneration(g.id, write))
              }
            >
              放弃这张
            </button>
          </div>
        ))}
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
            <button onClick={() => setConfirmEdit(false)}>返回修改</button>
            <button disabled={disabled} onClick={generate}>
              继续生成
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
