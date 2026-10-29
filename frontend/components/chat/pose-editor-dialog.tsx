"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { JsonObject } from "@/lib/scene-images/types";
import { loadPoseRuntime, type PoseRuntime } from "@/lib/pose-editor/runtime";
import { POSE_ASSET_BASE } from "@/lib/pose-editor/version";
import {
  SceneHistory,
  sceneCharacter,
  normalizePoseScene,
  writeEditedPose,
  writeOutputCamera,
  type PoseScene,
  type OutputCamera,
} from "@/lib/pose-editor/scene";

const bodyNames: Record<string, string> = {
  Root: "身体根部",
  pelvis: "骨盆",
  spine_01: "下脊柱",
  spine_02: "中脊柱",
  spine_03: "上脊柱",
  neck_01: "颈部",
  head: "头部",
  thigh_l: "左大腿",
  thigh_r: "右大腿",
  calf_l: "左小腿",
  calf_r: "右小腿",
  clavicle_l: "左肩",
  clavicle_r: "右肩",
  upperarm_l: "左上臂",
  upperarm_r: "右上臂",
  lowerarm_l: "左前臂",
  lowerarm_r: "右前臂",
  hand_l: "左手",
  hand_r: "右手",
  foot_l: "左脚",
  foot_r: "右脚",
  ball_l: "左脚掌",
  ball_r: "右脚掌",
};
function boneName(name: string) {
  if (bodyNames[name]) return bodyNames[name];
  const fingers: Record<string, string> = {
    thumb: "拇指",
    index: "食指",
    middle: "中指",
    ring: "无名指",
    pinky: "小指",
  };
  const [finger, joint, side] = name.split("_");
  return `${side === "l" ? "左" : "右"}${fingers[finger]}第${Number(joint)}关节`;
}
function NumberField({
  label,
  value,
  disabled,
  min,
  max,
  change,
  validity,
}: {
  label: string;
  value: number;
  disabled: boolean;
  min: number;
  max: number;
  change(value: number): void;
  validity(label: string, valid: boolean): void;
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState("");
  useEffect(() => {
    setText(String(value));
    setError("");
    validity(label, true);
  }, [value, label]);
  useEffect(() => () => validity(label, true), [label]);
  function apply() {
    const n = Number(text);
    if (!text.trim() || !Number.isFinite(n) || n < min || n > max) {
      setError(`${label}需要在 ${min} 至 ${max} 之间。`);
      validity(label, false);
      return;
    }
    setError("");
    validity(label, true);
    if (n !== value) change(n);
  }
  return (
    <label className="grid min-w-0 gap-1 text-xs">
      {label}
      <input
        aria-label={label}
        type="number"
        step="0.1"
        min={min}
        max={max}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const n = Number(next);
          validity(
            label,
            !!next.trim() && Number.isFinite(n) && n >= min && n <= max,
          );
        }}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="w-full min-w-0 rounded border bg-background p-2"
      />
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </label>
  );
}

export default function PoseEditorDialog({
  scene,
  originalScene,
  width,
  height,
  maxPixels,
  maxEdge,
  onApply,
  onClose,
}: {
  scene: JsonObject;
  originalScene: JsonObject;
  width: number;
  height: number;
  maxPixels: number;
  maxEdge: number;
  onApply(scene: JsonObject): Promise<void>;
  onClose(): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<PoseRuntime | null>(null);
  const current = useRef<PoseScene | null>(null);
  const history = useRef<SceneHistory | null>(null);
  const generation = useRef(0);
  const previewUrl = useRef("");
  const [preview, setPreview] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingPreview, setPendingPreview] = useState(true);
  const [error, setError] = useState("");
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>(
    {},
  );
  const validity = (label: string, valid: boolean) =>
    setInvalidFields((fields) => ({ ...fields, [label]: !valid }));
  const [editingId, setEditingId] = useState("");
  const [selectedBone, setSelectedBone] = useState("");
  const [bones, setBones] = useState<string[]>([]);
  const [camera, setCamera] = useState<OutputCamera | null>(null);
  const [ikMode, setIkMode] = useState(true);
  const [, refresh] = useState(0);
  const live = useRef(true);

  async function updatePreview() {
    const id = ++generation.current;
    setPendingPreview(true);
    try {
      const blob = await runtime.current!.capturePreview();
      if (!live.current || id !== generation.current) return;
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = URL.createObjectURL(blob);
      setPreview(previewUrl.current);
      setError("");
    } catch (reason) {
      if (live.current && id === generation.current)
        setError((reason as Error).message);
    } finally {
      if (live.current && id === generation.current) setPendingPreview(false);
    }
  }
  function changed() {
    runtime.current!.updateScene(current.current!);
    history.current!.checkpoint(current.current!);
    refresh((value) => value + 1);
    void updatePreview();
  }
  useEffect(() => {
    live.current = true;
    let observer: ResizeObserver | undefined;
    let disposed = false;
    let ownedRuntime: PoseRuntime | null = null;
    async function initialize() {
      try {
        const input = normalizePoseScene(scene);
        if (
          width < 1 ||
          height < 1 ||
          width > maxEdge ||
          height > maxEdge ||
          width * height > maxPixels
        )
          throw new Error("画幅超出人体预览的尺寸或像素限制。");
        current.current = input;
        history.current = new SceneHistory(input);
        const module = await loadPoseRuntime();
        if (disposed) return;
        const renderer = new module.PoseSceneRuntime(canvas.current!, {
          assetBase: POSE_ASSET_BASE,
          onPoseChange: (pose) => {
            if (disposed) return;
            writeEditedPose(
              current.current!,
              renderer.editingId ?? current.current!.active_character_id,
              pose,
            );
            changed();
          },
          onBoneSelection: (name) => {
            if (!disposed) setSelectedBone(name ?? "");
          },
        });
        ownedRuntime = renderer;
        runtime.current = renderer;
        await renderer.initialize(input, width, height);
        if (disposed) return;
        setEditingId(input.active_character_id);
        setBones(renderer.boneNames());
        setCamera(renderer.cameraParams());
        observer = new ResizeObserver(([entry]) =>
          renderer.resize(
            Math.round(entry.contentRect.width),
            Math.round(entry.contentRect.height),
          ),
        );
        observer.observe(host.current!);
        setReady(true);
        await updatePreview();
      } catch (reason) {
        if (!disposed) setError((reason as Error).message);
      }
    }
    void initialize();
    return () => {
      disposed = true;
      live.current = false;
      generation.current++;
      observer?.disconnect();
      ownedRuntime?.dispose();
      if (runtime.current === ownedRuntime) runtime.current = null;
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    };
  }, [scene, width, height, maxPixels, maxEdge]);

  async function action(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function restore(next: PoseScene, characterId = editingId) {
    await runtime.current!.loadScene(next, characterId);
    current.current = next;
    runtime.current!.setIKMode(ikMode);
    setEditingId(characterId);
    setSelectedBone("");
    setBones(runtime.current!.boneNames());
    setCamera(runtime.current!.cameraParams());
    refresh((value) => value + 1);
    await updatePreview();
  }
  const disabled = !ready || busy;
  const character =
    current.current && editingId
      ? sceneCharacter(current.current, editingId)
      : null;
  const rotation =
    character && selectedBone
      ? (character.poses[current.current!.activeTab].bones[selectedBone] ?? [
          0, 0, 0,
        ])
      : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="max-h-[94dvh] overflow-y-auto sm:max-w-6xl"
        aria-busy={!ready || busy}
      >
        <DialogHeader>
          <DialogTitle>编辑姿势</DialogTitle>
          <DialogDescription>
            拖动关节调整姿势。浏览视角不会改变输出机位，应用后才保存修改。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-3 text-sm">
          <button
            disabled={disabled || !history.current?.canUndo}
            onClick={() => void action(() => restore(history.current!.undo()))}
          >
            撤销
          </button>
          <button
            disabled={disabled || !history.current?.canRedo}
            onClick={() => void action(() => restore(history.current!.redo()))}
          >
            重做
          </button>
          <button
            disabled={disabled}
            onClick={() =>
              void action(async () => {
                const source = normalizePoseScene(originalScene);
                history.current!.checkpoint(source);
                await restore(source, source.active_character_id);
              })
            }
          >
            恢复检索姿势
          </button>
          <button
            disabled={disabled}
            onClick={() => runtime.current!.snapToOutput()}
          >
            回到输出机位
          </button>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label="关节 IK 拖动"
              checked={ikMode}
              disabled={disabled}
              onChange={(event) => {
                setIkMode(event.target.checked);
                runtime.current!.setIKMode(event.target.checked);
              }}
            />
            关节 IK 拖动
          </label>
        </div>
        <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <div
              ref={host}
              className="h-80 w-full overflow-hidden rounded border bg-white md:h-[28rem]"
            >
              <canvas
                ref={canvas}
                width={640}
                height={448}
                aria-label="人体姿态编辑画布"
                className="h-full w-full touch-none"
              />
            </div>
            {!ready && !error && (
              <p role="status" className="mt-2 text-sm">
                正在加载人体资源和三维视口…
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              拖动关节移动肢体；右键拖动观察视角。也可选择骨骼后调整旋转。
            </p>
          </div>
          <div className="grid min-w-0 content-start gap-3">
            <p className="text-sm">
              生成构图预览 · {width} × {height}
            </p>
            {preview && (
              <img
                src={preview}
                alt="人偶生成构图预览"
                className="max-h-72 w-full rounded border bg-white object-contain"
              />
            )}
            {pendingPreview && ready && (
              <p role="status" className="text-xs">
                正在更新生成预览…
              </p>
            )}
            <label className="grid gap-1 text-xs">
              编辑人物
              <select
                aria-label="编辑人物"
                disabled={disabled}
                value={editingId}
                className="min-w-0 rounded border bg-background p-2"
                onChange={(event) =>
                  void action(() =>
                    restore(
                      structuredClone(current.current!),
                      event.target.value,
                    ),
                  )
                }
              >
                {current.current?.characters.map((row) => (
                  <option key={row.id} value={row.id}>
                    {String(row.name ?? row.id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              旋转骨骼
              <select
                aria-label="旋转骨骼"
                disabled={disabled}
                value={selectedBone}
                className="min-w-0 rounded border bg-background p-2"
                onChange={(event) => {
                  setSelectedBone(event.target.value);
                  if (event.target.value)
                    runtime.current!.selectBone(event.target.value);
                }}
              >
                <option value="">请选择骨骼或点击人体关节</option>
                {bones.map((name) => (
                  <option key={name} value={name}>
                    {boneName(name)}
                  </option>
                ))}
              </select>
            </label>
            {rotation && (
              <div className="grid grid-cols-3 gap-2">
                {["X", "Y", "Z"].map((axis, index) => (
                  <NumberField
                    validity={validity}
                    key={`${selectedBone}-${axis}`}
                    label={`骨骼旋转 ${axis}`}
                    value={rotation[index]}
                    min={-180}
                    max={180}
                    disabled={disabled}
                    change={(value) =>
                      runtime.current!.rotateBone(selectedBone, index, value)
                    }
                  />
                ))}
              </div>
            )}
            {character && (
              <fieldset className="grid grid-cols-2 gap-2">
                <legend className="mb-2 text-xs">人物位置与比例</legend>
                {(["x", "y", "z", "zoom"] as const).map((key) => (
                  <NumberField
                    validity={validity}
                    key={`${editingId}-${key}`}
                    label={
                      {
                        x: "人物 X",
                        y: "人物 Y",
                        z: "人物 Z",
                        zoom: "人物缩放",
                      }[key]
                    }
                    value={character.transform[key]}
                    min={key === "zoom" ? 0.1 : key === "z" ? -40 : -50}
                    max={key === "zoom" ? 7 : key === "z" ? 40 : 50}
                    disabled={disabled}
                    change={(value) => {
                      character.transform = {
                        ...character.transform,
                        [key]: value,
                      };
                      runtime.current!.transformCharacter(character.transform);
                      changed();
                    }}
                  />
                ))}
              </fieldset>
            )}
            {camera && (
              <fieldset className="grid grid-cols-2 gap-2">
                <legend className="mb-2 text-xs">输出机位</legend>
                {(
                  [
                    "offset_x",
                    "offset_y",
                    "zoom",
                    "yaw_deg",
                    "pitch_deg",
                  ] as const
                ).map((key) => (
                  <NumberField
                    validity={validity}
                    key={key}
                    label={
                      {
                        offset_x: "画面水平偏移",
                        offset_y: "画面垂直偏移",
                        zoom: "画面缩放",
                        yaw_deg: "机位水平角",
                        pitch_deg: "机位俯仰角",
                      }[key]
                    }
                    value={camera[key]}
                    min={
                      key === "zoom" ? 0.1 : key.includes("deg") ? -180 : -50
                    }
                    max={key === "zoom" ? 7 : key.includes("deg") ? 180 : 50}
                    disabled={disabled}
                    change={(value) => {
                      const next = { ...camera, [key]: value };
                      setCamera(next);
                      writeOutputCamera(current.current!, next);
                      changed();
                      runtime.current!.snapToOutput();
                    }}
                  />
                ))}
              </fieldset>
            )}
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            disabled={
              disabled || !!error || Object.values(invalidFields).some(Boolean)
            }
            onClick={() =>
              void action(async () => {
                // 数值输入的 blur 可能刚提交最后一次修改，应用前确认最新场景仍能截图。
                await runtime.current!.capturePreview();
                await onApply(structuredClone(current.current!));
                onClose();
              })
            }
          >
            应用修改
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
