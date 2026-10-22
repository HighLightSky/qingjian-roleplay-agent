"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useImageUrl } from "@/hooks/use-image-url";
import { prepareCharacterPhoto } from "@/lib/images/repository";
import { ImageGallery } from "@/components/chat/image-gallery";
import {
  CheckIcon,
  DownloadIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  UploadIcon,
} from "lucide-react";
import { CharacterThumbnail } from "@/components/character-thumbnail";
import { THEME_COLORS } from "@/lib/theme";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  database,
  setting,
  saveCharacterDraft,
  discardCharacterDraft,
  TABLES,
} from "@/lib/db";
import { validateBackup, type Backup } from "@/lib/backup";
import {
  EMPTY_PROFILE,
  parseCharacterProfile,
  errorText,
  now,
  profileOf,
  type Character,
  type CharacterProfile,
  type Session,
  type ThemeMode,
} from "@/lib/domain";
import {
  archiveCharacter,
  changeTheme,
  changeThemeColor,
  clearData,
  exportBackup,
  importBackup,
  removeSession,
  renameSession,
  report,
  saveProfile,
  selectCharacter,
  useAppStore,
  write,
} from "@/stores/use-app-store";

export type DialogState =
  | { kind: "characters" }
  | { kind: "character"; character?: Character; copy?: boolean }
  | {
      kind: "rename" | "delete-session" | "session-details";
      session: Session;
    }
  | { kind: "settings" }
  | { kind: "import"; backup: Backup }
  | { kind: "clear" };

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && (
        <span className="text-xs leading-5 text-muted-foreground">{hint}</span>
      )}
    </label>
  );
}
function ProfileForm({
  state,
  close,
}: {
  state: Extract<DialogState, { kind: "character" }>;
  close: () => void;
}) {
  const character = state.copy ? undefined : state.character;
  const key = `characterDraft:${state.copy ? `copy-${state.character?.id}` : (character?.id ?? "new")}`;
  const [profile, setProfile] = useState<CharacterProfile>(
    state.character
      ? {
          ...profileOf(state.character),
          ...(state.copy ? { name: `${state.character.name}（副本）` } : {}),
        }
      : EMPTY_PROFILE,
  );
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const draft = useRef(profile);
  const preparation = useRef<AbortController | null>(null);
  useEffect(() => () => preparation.current?.abort(), []);
  const photoUrl = useImageUrl(profile.appearancePhotoAssetId);
  useEffect(() => {
    let active = true;
    void write(async () => {
      const db = await database();
      const saved = await db.get("settings", key);
      const initial = saved
        ? parseCharacterProfile(JSON.parse(saved.value), true)
        : draft.current;
      if (!saved) await saveCharacterDraft(key, initial);
      if (active) {
        draft.current = initial;
        setProfile(initial);
        setLoaded(true);
      }
    }).catch((error) => {
      if (active) setError(errorText(error));
    });
    return () => {
      active = false;
    };
  }, [key]);
  function updateProfile(next: CharacterProfile) {
    draft.current = next;
    setProfile(next);
    void write(() => saveCharacterDraft(key, next)).catch((error) =>
      setError(errorText(error)),
    );
  }
  async function uploadPhoto(file: File) {
    setPreparing(true);
    setError("");
    try {
      const controller = new AbortController();
      preparation.current = controller;
      const next = await prepareCharacterPhoto(
        file,
        key,
        write,
        controller.signal,
      );
      draft.current = next;
      setProfile(next);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPreparing(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await saveProfile(profile, character, key);
      close();
    } catch (error) {
      setError(errorText(error));
      setSaving(false);
    }
  }
  const fields: ["name" | "identity" | "description", string, string][] = [
    ["name", "角色名称", "你想如何称呼这个角色？"],
    ["identity", "身份（与我的关系）", "角色是谁，以及与我的关系？"],
    ["description", "角色描述", "自由描述经历、性格、说话方式和世界背景"],
  ];
  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>
          {state.copy ? "复制为新角色" : character ? "编辑角色" : "创建角色"}
        </DialogTitle>
        <DialogDescription>
          {character
            ? "修改影响之后的新对话，已有对话保留原设定。角色记忆仍然共享。"
            : state.copy
              ? "只复制设定，新角色拥有独立的记忆与对话。"
              : "只需填写名字，身份与角色描述可以慢慢补充。"}
        </DialogDescription>
      </DialogHeader>
      {fields.map(([field, label, placeholder]) => (
        <Field key={field} label={`${label}${field === "name" ? " *" : ""}`}>
          {field === "name" ? (
            <input
              className="app-input"
              disabled={!loaded || preparing || saving}
              value={profile[field]}
              required
              placeholder={placeholder}
              onChange={(event) =>
                updateProfile({ ...profile, [field]: event.target.value })
              }
            />
          ) : (
            <Textarea
              disabled={!loaded || preparing || saving}
              value={profile[field]}
              rows={field === "description" ? 6 : 2}
              placeholder={placeholder}
              onChange={(event) =>
                updateProfile({ ...profile, [field]: event.target.value })
              }
            />
          )}
        </Field>
      ))}
      <section className="grid gap-3 border-t pt-4">
        <h3 className="text-sm font-medium">形象照片（可选）</h3>
        <p className="text-xs leading-5 text-muted-foreground">
          选择一张静态 JPEG 或 PNG
          作为外观参考。原图保存在当前浏览器，保存角色不会调用模型或改写角色描述。
        </p>
        {profile.appearancePhotoAssetId && (
          <a
            href={photoUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="查看角色形象原图"
          >
            <img
              src={photoUrl}
              alt="角色形象照片"
              className="max-h-56 max-w-full rounded-md border object-contain"
            />
          </a>
        )}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <label
              className={
                !loaded || preparing || saving
                  ? "pointer-events-none opacity-50"
                  : "cursor-pointer"
              }
            >
              {preparing
                ? "正在准备照片…"
                : profile.appearancePhotoAssetId
                  ? "替换照片"
                  : "选择照片"}
              <input
                type="file"
                accept="image/jpeg,image/png"
                aria-label="选择角色形象照片"
                className="sr-only"
                disabled={!loaded || preparing || saving}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void uploadPhoto(file);
                }}
              />
            </label>
          </Button>
          {profile.appearancePhotoAssetId && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!loaded || preparing || saving}
              onClick={() => {
                const { appearancePhotoAssetId, ...text } = profile;
                updateProfile(text);
              }}
            >
              移除照片
            </Button>
          )}
        </div>
      </section>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={saving || preparing || !loaded}
          onClick={() => {
            void write(() => discardCharacterDraft(key))
              .then(close)
              .catch((error) => setError(errorText(error)));
          }}
        >
          丢弃草稿
        </Button>
        <Button type="button" variant="ghost" onClick={close}>
          暂时关闭
        </Button>
        <Button disabled={saving || preparing || !loaded}>
          {saving ? "保存中…" : "保存角色"}
        </Button>
      </DialogFooter>
    </form>
  );
}
function SnapshotPhoto({ assetId }: { assetId: string }) {
  const src = useImageUrl(assetId);
  return (
    <div>
      <dt className="text-muted-foreground">创建时的形象照片</dt>
      <dd className="mt-2">
        <a href={src} target="_blank" rel="noreferrer">
          <img
            src={src}
            alt="会话角色形象照片"
            className="max-h-56 rounded border object-contain"
          />
        </a>
      </dd>
    </div>
  );
}
function DataSettings({ open }: { open: (state: DialogState) => void }) {
  const { themeMode, themeColor, readOnly, characters } = useAppStore();
  const [working, setWorking] = useState(false);
  const [storage, setStorage] = useState<{
    usage?: number;
    quota?: number;
    persistent?: boolean;
  }>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [lastExport, setLastExport] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    void database()
      .then(async (db) => {
        const values = await Promise.all(
          TABLES.map((table) => db.count(table)),
        );
        setCounts(
          Object.fromEntries(
            TABLES.map((table, index) => [table, values[index]]),
          ),
        );
        setLastExport((await db.get("settings", "lastExport"))?.value ?? "");
      })
      .catch(report);
    if (navigator.storage)
      void Promise.all([
        navigator.storage.estimate(),
        navigator.storage.persisted(),
      ])
        .then(([estimate, persistent]) =>
          setStorage({ ...estimate, persistent }),
        )
        .catch(() => {});
  }, []);
  async function download() {
    setWorking(true);
    try {
      const backup = await exportBackup();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(backup)], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      const stamp = new Intl.DateTimeFormat("sv-SE", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .format(new Date())
        .replace(/[-: ]/g, "");
      anchor.download = `roleplay-backup-${stamp}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (!readOnly) await write(() => setting("lastExport", now()));
      setLastExport(now());
      setNotice("已发起备份下载，请确认文件已保存在设备上。");
    } catch (error) {
      report(error);
    } finally {
      setWorking(false);
    }
  }
  async function readFile(file?: File) {
    if (!file) return;
    setWorking(true);
    try {
      if (file.size > 50 * 1024 * 1024)
        throw new Error("第一版支持导入不超过 50MiB 的备份。");
      open({
        kind: "import",
        backup: validateBackup(JSON.parse(await file.text())),
      });
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="grid gap-6">
      <DialogHeader>
        <DialogTitle>设置与数据</DialogTitle>
        <DialogDescription>
          故事保存在当前浏览器，备份让它们可以迁移。
        </DialogDescription>
      </DialogHeader>
      <section className="grid gap-5" aria-label="外观设置">
        <fieldset disabled={readOnly}>
          <legend className="mb-3 text-sm font-medium">外观</legend>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { value: "system", label: "跟随系统", Icon: MonitorIcon },
                { value: "light", label: "浅色", Icon: SunIcon },
                { value: "dark", label: "深色", Icon: MoonIcon },
              ] satisfies {
                value: ThemeMode;
                label: string;
                Icon: typeof SunIcon;
              }[]
            ).map(({ value, label, Icon }) => (
              <label
                key={value}
                className="cursor-pointer has-disabled:cursor-default has-disabled:opacity-50"
              >
                <input
                  type="radio"
                  name="themeMode"
                  value={value}
                  checked={themeMode === value}
                  onChange={() => void changeTheme(value).catch(report)}
                  className="peer sr-only"
                />
                <span className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-lg border text-sm text-muted-foreground transition-colors hover:bg-accent/50 peer-checked:border-primary peer-checked:bg-accent peer-checked:text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background">
                  <Icon className="size-5" aria-hidden />
                  {label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={readOnly} aria-describedby="theme-color-hint">
          <legend className="mb-3 text-sm font-medium">主题色</legend>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {THEME_COLORS.map(({ value, label }) => (
              <label
                key={value}
                className="cursor-pointer has-disabled:cursor-default has-disabled:opacity-50"
              >
                <input
                  type="radio"
                  name="themeColor"
                  value={value}
                  checked={themeColor === value}
                  onChange={() => void changeThemeColor(value).catch(report)}
                  className="peer sr-only"
                />
                <span className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-lg border border-transparent text-xs text-muted-foreground transition-colors hover:bg-accent/50 peer-checked:border-primary peer-checked:bg-accent peer-checked:text-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background">
                  <span
                    data-theme-color={value}
                    className="flex size-7 items-center justify-center rounded-full bg-(--theme-swatch)"
                  >
                    {themeColor === value && (
                      <CheckIcon
                        className="size-4 text-[#09090b]"
                        strokeWidth={3}
                        aria-hidden
                      />
                    )}
                  </span>
                  {label}
                </span>
              </label>
            ))}
          </div>
          <p
            id="theme-color-hint"
            className="mt-3 text-xs leading-5 text-muted-foreground"
          >
            主题色用于按钮、气泡与聚焦光晕。浅色侧栏轻染色，深色背景保持纯净黑灰。
          </p>
        </fieldset>
      </section>
      <section className="border-t pt-5">
        <h3 className="text-sm font-medium">本地数据</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {characters.length} 个角色 · {counts.sessions ?? 0} 段对话 ·{" "}
          {counts.messages ?? 0} 条消息
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {storage.usage !== undefined
            ? `已使用约 ${(storage.usage / 1024 / 1024).toFixed(2)} MiB。`
            : "存储用量暂不可用。"}{" "}
          {storage.persistent
            ? "浏览器已允许持久存储。"
            : "使用浏览器默认存储策略。"}
        </p>
        <Button
          className="mt-3"
          variant="outline"
          size="sm"
          disabled={
            readOnly || storage.persistent || !navigator.storage?.persist
          }
          onClick={() => {
            void navigator.storage
              .persist()
              .then((persistent) => {
                setStorage({ ...storage, persistent });
                setNotice(
                  persistent
                    ? "已开启持久存储。"
                    : "浏览器未批准持久存储，仍可继续使用并导出备份。",
                );
              })
              .catch(report);
          }}
        >
          开启持久存储
        </Button>
      </section>
      <ImageGallery />
      <section className="border-t pt-5">
        <h3 className="text-sm font-medium">完整备份</h3>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          包含角色、对话、图片原件、视觉记录、记忆、草稿与外观设置。导出会先停止正在生成的回复。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void download()}
            disabled={working}
          >
            <DownloadIcon />
            导出全部
          </Button>
          <Button variant="outline" asChild>
            <label
              className={
                readOnly || working
                  ? "pointer-events-none opacity-50"
                  : "cursor-pointer"
              }
            >
              <UploadIcon />
              导入备份
              <input
                aria-label="导入备份"
                className="sr-only"
                type="file"
                accept="application/json,.json"
                disabled={readOnly || working}
                onChange={(event) => {
                  void readFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </label>
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {lastExport
            ? `上次发起导出：${new Date(lastExport).toLocaleString("zh-CN")}`
            : "尚未导出备份"}
        </p>
      </section>
      <p className="text-xs leading-6 text-muted-foreground">
        数据属于当前站点地址与浏览器。清除站点数据、隐私模式结束或更换设备后，需要通过备份恢复。关闭浏览器前已保存的内容可在原环境恢复。
      </p>
      {notice && (
        <p role="status" className="text-sm leading-6">
          {notice}
        </p>
      )}
      <div className="border-t pt-4">
        <Button
          variant="ghost"
          className="text-destructive"
          disabled={readOnly || working}
          onClick={() => open({ kind: "clear" })}
        >
          清空本地数据
        </Button>
      </div>
    </div>
  );
}
export function AppDialogs({
  state,
  change,
}: {
  state: DialogState | null;
  change: (state: DialogState | null) => void;
}) {
  const app = useAppStore();
  const [value, setValue] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    setWorking(false);
    if (state?.kind === "rename") setValue(state.session.title);
    else setValue("");
  }, [state]);
  if (!state) return null;
  const close = () => change(null);
  const submit = async (task: () => Promise<unknown>) => {
    setWorking(true);
    setError("");
    try {
      await task();
      close();
    } catch (error) {
      setError(errorText(error));
      setWorking(false);
    }
  };
  let content: ReactNode;
  if (state.kind === "character")
    content = (
      <ProfileForm
        key={`${state.character?.id ?? "new"}:${state.copy}`}
        state={state}
        close={close}
      />
    );
  else if (state.kind === "settings") content = <DataSettings open={change} />;
  else if (state.kind === "characters")
    content = (
      <>
        <DialogHeader>
          <DialogTitle>你的角色</DialogTitle>
          <DialogDescription>
            每个角色都有独立的故事与长期记忆。
          </DialogDescription>
        </DialogHeader>
        <div className="divide-y">
          {app.characters.map((character) => (
            <div key={character.id} className="flex items-center gap-3 py-4">
              <CharacterThumbnail
                assetId={character.appearancePhotoAssetId}
                name={character.name}
                className="size-10"
              />
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => void submit(() => selectCharacter(character.id))}
              >
                <span className="block truncate font-medium">
                  {character.name}
                  {character.archived && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      已归档
                    </span>
                  )}
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {character.identity}
                </span>
              </button>
              <Button
                variant="ghost"
                size="sm"
                disabled={app.readOnly}
                onClick={() => change({ kind: "character", character })}
              >
                编辑
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={app.readOnly}
                onClick={() => {
                  void archiveCharacter(character).catch(report);
                }}
              >
                {character.archived ? "恢复" : "归档"}
              </Button>
            </div>
          ))}
        </div>
        <Button
          disabled={app.readOnly}
          onClick={() => change({ kind: "character" })}
        >
          创建角色
        </Button>
      </>
    );
  else if (state.kind === "session-details")
    content = (
      <>
        <DialogHeader>
          <DialogTitle>对话详情</DialogTitle>
          <DialogDescription>{state.session.title}</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-4 text-sm">
          <div>
            <dt className="text-muted-foreground">创建时间</dt>
            <dd className="mt-1">
              {new Date(state.session.createdAt).toLocaleString("zh-CN")}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">角色设定版本</dt>
            <dd className="mt-1">
              {state.session.characterSnapshot.name} · v
              {state.session.profileVersion}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              创建时的身份（与我的关系）
            </dt>
            <dd className="mt-1 whitespace-pre-wrap leading-6">
              {state.session.characterSnapshot.identity}
            </dd>
          </div>
          {state.session.characterSnapshot.appearancePhotoAssetId && (
            <SnapshotPhoto
              assetId={state.session.characterSnapshot.appearancePhotoAssetId}
            />
          )}
          <div>
            <dt className="text-muted-foreground">创建时的角色描述</dt>
            <dd className="mt-1 whitespace-pre-wrap leading-6">
              {state.session.characterSnapshot.description}
            </dd>
          </div>
        </dl>
      </>
    );
  else {
    const config = {
      rename: {
        title: "重命名对话",
        description: "手动命名后，不会再被自动标题覆盖。",
        button: "保存标题",
      },
      "delete-session": {
        title: "删除这段对话？",
        description:
          "会话内的消息、剧情、记忆、目标与草稿将被删除，角色共享记忆仍会保留。",
        button: "删除对话",
      },
      import: {
        title: "用备份覆盖本地数据？",
        description:
          state.kind === "import"
            ? `文件包含 ${state.backup.data.characters.length} 个角色、${state.backup.data.sessions.length} 段对话、${state.backup.data.messages.length} 条消息。导出时间：${new Date(state.backup.exportedAt).toLocaleString("zh-CN")}。现有数据将被替换，建议先导出备份。`
            : "",
        button: "覆盖恢复",
      },
      clear: {
        title: "清空全部本地数据？",
        description:
          "角色、对话、记忆和草稿都会被删除。建议先导出备份，此操作无法撤销。",
        button: "清空全部",
      },
    }[state.kind];
    const form = state.kind === "rename";
    const destructive = ["delete-session", "import", "clear"].includes(
      state.kind,
    );
    async function save() {
      if (!state) return;
      if (state.kind === "rename") await renameSession(state.session, value);
      if (state.kind === "delete-session") await removeSession(state.session);
      if (state.kind === "import") await importBackup(state.backup);
      if (state.kind === "clear") await clearData();
    }
    content = (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(save);
        }}
        className="grid gap-5"
      >
        <DialogHeader>
          <DialogTitle>{config.title}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>
        {form && (
          <Field label="对话标题">
            <input
              className="app-input"
              autoFocus
              value={value}
              required
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
        )}
        {state.kind === "import" && (
          <Button
            variant="outline"
            type="button"
            onClick={() => change({ kind: "settings" })}
          >
            先返回导出当前数据
          </Button>
        )}
        {state.kind === "clear" && (
          <Field label="输入「清空」确认">
            <input
              className="app-input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
            />
          </Field>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={close}
            disabled={working}
          >
            取消
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={
              working ||
              app.readOnly ||
              (state.kind === "clear" && value !== "清空")
            }
          >
            {working ? "处理中…" : config.button}
          </Button>
        </DialogFooter>
      </form>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !working) close();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto max-sm:inset-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"
        onInteractOutside={(event) => {
          if (working) event.preventDefault();
        }}
      >
        {content}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
