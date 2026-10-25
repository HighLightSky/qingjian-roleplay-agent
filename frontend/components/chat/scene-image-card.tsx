"use client";

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
      if (selected.draft && loaded.current !== selected.id)
        showDraft(selected, selected.draft);
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
              第一张为指定画幅的黑色画布。参考图可不选，最多{" "}
              {caps?.imageGeneration.maxReferenceImages} 张。
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
                  const selectedIndex = plan.referenceImages
                    .filter((item) =>
                      draft.referenceAssetIds.includes(item.assetId),
                    )
                    .findIndex((item) => item.assetId === ref.assetId);
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
      <div className="mt-2 flex flex-wrap gap-3">
        {plan && draft && (
          <button
            disabled={disabled || !sizeValid || !draft.prompt.trim()}
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
