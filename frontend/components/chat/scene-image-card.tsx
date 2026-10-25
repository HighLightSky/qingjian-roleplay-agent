"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { database } from "@/lib/db";
import { useImageUrl } from "@/hooks/use-image-url";
import { useAppStore, write } from "@/stores/use-app-store";
import {
  startSceneGeneration,
  stopSceneGeneration,
  rejectSceneGeneration,
  followSceneGeneration,
} from "@/lib/scene-images/coordinator";
import {
  isActiveGeneration,
  type SceneImagePlan,
  type SceneGeneration,
} from "@/lib/scene-images/types";

function AssetPreview({ assetId }: { assetId: string }) {
  const { url, missing } = useImageUrl(assetId);
  return missing ? (
    <p>图片原件缺失。</p>
  ) : url ? (
    <a href={url} target="_blank" rel="noreferrer">
      <img
        src={url}
        alt="剧情图"
        className="mt-2 max-h-[32rem] rounded-lg object-contain"
      />
    </a>
  ) : null;
}
function ReferencePreview({
  assetId,
  number,
  scope,
}: {
  assetId: string;
  number: number;
  scope: string;
}) {
  const { url, missing } = useImageUrl(assetId, true);
  return (
    <li className="flex items-center gap-2 py-1">
      {url && (
        <img
          src={url}
          alt={`参考图 ${number}`}
          className="h-12 w-12 rounded object-contain"
        />
      )}
      <span>
        参考图 {number}：{assetId} · {scope}
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
  const draft = useAppStore((s) => s.imageDrafts[messageId]);
  const [plan, setPlan] = useState<SceneImagePlan>();
  const [generations, setGenerations] = useState<SceneGeneration[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    async function load() {
      const db = await database();
      const [plans, generated] = await Promise.all([
        db.getAllFromIndex("sceneImagePlans", "message", messageId),
        db.getAllFromIndex("sceneGenerations", "message", messageId),
      ]);
      const selectedPlan = plans
        .sort((a, b) => a.sourceCheckpointVersion - b.sourceCheckpointVersion)
        .at(-1);
      const displayed =
        selectedPlan?.status === "reuse"
          ? [
              ...generated,
              ...(
                await db.getAllFromIndex(
                  "sceneGenerations",
                  "session",
                  selectedPlan.sessionId,
                )
              ).filter(
                (g) =>
                  g.planId === selectedPlan.previousPlanId &&
                  g.status === "succeeded" &&
                  g.referenceStatus === "eligible",
              ),
            ]
          : generated;
      if (live) {
        setPlan(selectedPlan);
        setGenerations(
          displayed.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        );
      }
    }
    void load().catch((e) => setError((e as Error).message));
    const refresh = () => {
      void load().catch((e) => setError((e as Error).message));
    };
    window.addEventListener("scene-images-changed", refresh);
    return () => {
      live = false;
      window.removeEventListener("scene-images-changed", refresh);
    };
  }, [messageId]);
  const latest = generations.at(-1);
  const active = latest && isActiveGeneration(latest.status);
  if (!plan && !draft) return null;
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
  const prompt =
    plan?.prompt ||
    (draft?.raw ? draft.raw.replace(/^\[画面计划][^\n]*(?:\n|$)/, "") : "");
  return (
    <div
      className="mt-3 rounded-lg border p-3 text-sm"
      data-testid="scene-image-card"
    >
      <details>
        <summary className="cursor-pointer">
          剧情图 ·{" "}
          {latest
            ? labels[latest.status]
            : plan?.status === "ready"
              ? "待生成"
              : draft?.error || plan?.error
                ? "暂不可生成"
                : "整理画面中"}
        </summary>
        <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
          {prompt}
        </pre>
        {!!plan?.referenceImages.length && (
          <ul className="mt-2 text-xs">
            {plan.referenceImages.map((ref, index) => (
              <ReferencePreview
                key={ref.assetId}
                assetId={ref.assetId}
                number={index + 1}
                scope={ref.scope}
              />
            ))}
          </ul>
        )}
      </details>
      {(error || latest?.error || draft?.error || plan?.error) && (
        <p role="alert" className="mt-2 text-destructive">
          {error || latest?.error || draft?.error || plan?.error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-3">
        {plan?.status === "ready" && !active && (
          <button
            disabled={readOnly || busy}
            onClick={() =>
              void action(() => startSceneGeneration(plan.id, write))
            }
          >
            {latest ? "重新生成" : "生成图片"}
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
        .filter((g) => g.assetId)
        .map((g) => (
          <div key={g.id}>
            <AssetPreview assetId={g.assetId!} />
            <span className="text-xs text-muted-foreground">
              {g.referenceStatus === "rejected"
                ? "已排除参考"
                : "生成要求摘要，未经图像核实"}
            </span>
            {g.referenceStatus === "eligible" && (
              <button
                className="ml-3 text-xs"
                disabled={readOnly || busy}
                onClick={() =>
                  void action(() => rejectSceneGeneration(g.id, write))
                }
              >
                此图有误
              </button>
            )}
          </div>
        ))}
    </div>
  );
}
