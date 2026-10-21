"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ThreadListPrimitive,
  ThreadListItemPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { DropdownMenu } from "radix-ui";
import {
  BookOpenIcon,
  ChevronDownIcon,
  LeafIcon,
  MenuIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatePanel } from "@/components/chat/state-panel";
import { OperationTool } from "@/components/chat/operation-tool";
import { ChatRuntimeProvider } from "@/components/chat/runtime-provider";
import { InteractionSettingsControls } from "@/components/chat/interaction-settings";
import { AppDialogs, type DialogState } from "@/components/app-dialogs";
import {
  cancelGeneration,
  initialize,
  newSession,
  report,
  selectSession,
  useAppStore,
} from "@/stores/use-app-store";
import { cn } from "@/lib/utils";

const OpenDialog = createContext<(state: DialogState) => void>(() => {});
const SessionSearch = createContext("");
const THREAD_COMPONENTS = {
  ToolFallback: OperationTool,
  ToolGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  ComposerControls: InteractionSettingsControls,
};
function MoreMenu({
  label,
  items,
}: {
  label: string;
  items: {
    label: string;
    action: () => void;
    disabled?: boolean;
    destructive?: boolean;
  }[];
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className="size-11"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-44 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-sm"
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              disabled={item.disabled}
              onSelect={item.action}
              className={cn(
                "cursor-default rounded-sm px-3 py-2.5 outline-none focus:bg-accent data-[disabled]:opacity-40",
                item.destructive && "text-destructive",
              )}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
function SessionItem() {
  const title = useAuiState((state) => state.threadListItem.title ?? "新对话");
  const sessionId = useAuiState((state) => state.threadListItem.id);
  const running = useAppStore((state) => state.activeSessionId === sessionId);
  const query = useContext(SessionSearch);
  if (!title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    return null;
  return (
    <ThreadListItemPrimitive.Root className="my-0.5 min-w-0 rounded-md transition-colors hover:bg-accent/60 data-[active=true]:bg-accent">
      <ThreadListItemPrimitive.Trigger className="flex min-h-12 w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm">
        <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
        {running && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-primary"
            aria-label="正在回复"
          />
        )}
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  );
}
function Navigation() {
  const app = useAppStore();
  const open = useContext(OpenDialog);
  const [query, setQuery] = useState("");
  const character = app.characters.find((item) => item.id === app.characterId);
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar px-3 py-5">
      <div className="flex items-center gap-2 px-3 text-primary">
        <LeafIcon className="size-5" />
        <span className="text-lg font-semibold tracking-widest">青笺</span>
        <span className="ml-auto text-[10px] tracking-wider text-muted-foreground">
          角色与故事
        </span>
      </div>
      <Button
        variant="ghost"
        className="my-6 h-auto min-h-12 justify-between px-3 py-2 text-left"
        onClick={() => open({ kind: "characters" })}
        aria-label="切换角色"
      >
        <span className="min-w-0">
          <span className="block truncate text-base font-medium">
            {character?.name ?? "选择角色"}
          </span>
          <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
            {character
              ? character.archived
                ? "已归档 · 可阅读已有对话"
                : "每段故事，都有自己的经历"
              : "开启一个新的故事"}
          </span>
        </span>
        <ChevronDownIcon />
      </Button>
      <ThreadListPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadListPrimitive.New asChild>
          <Button
            className="h-11 w-full justify-start"
            variant="outline"
            disabled={
              !character || character.archived || app.readOnly || app.busy
            }
          >
            <PlusIcon />
            新建对话
          </Button>
        </ThreadListPrimitive.New>
        <p className="px-3 pb-2 pt-6 text-xs text-muted-foreground">对话</p>
        {app.sessions.length > 5 && (
          <input
            className="app-input mb-2 text-sm"
            aria-label="搜索对话"
            placeholder="搜索对话…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SessionSearch.Provider value={query}>
            <ThreadListPrimitive.Items
              components={{ ThreadListItem: SessionItem }}
            />
          </SessionSearch.Provider>
          {!app.sessions.length && (
            <p className="px-3 py-3 text-xs leading-6 text-muted-foreground">
              还没有对话，点击上方开始。
            </p>
          )}
        </div>
      </ThreadListPrimitive.Root>
      <div className="mt-4 grid gap-1 border-t pt-3">
        <Button
          variant="ghost"
          className="h-11 justify-start"
          onClick={() => open({ kind: "characters" })}
        >
          <LeafIcon />
          角色库
        </Button>
        <Button
          variant="ghost"
          className="h-11 justify-start"
          onClick={() => open({ kind: "settings" })}
        >
          <SettingsIcon />
          设置与数据
        </Button>
      </div>
    </div>
  );
}
function useTheme() {
  const mode = useAppStore((state) => state.themeMode);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);
}
function SaveIndicator({ name }: { name: string }) {
  const status = useAppStore((state) => state.saveStatus);
  return (
    <>
      {name} ·{" "}
      {status === "saving"
        ? "保存中…"
        : status === "failed"
          ? "保存失败，请查看提示"
          : "已保存到本机"}
    </>
  );
}
export function AppShell() {
  // Saving a draft must not rerender the shell or resync the chat runtime.
  const app = useAppStore(
    useShallow((state) => ({
      ready: state.ready,
      bootError: state.bootError,
      characters: state.characters,
      sessions: state.sessions,
      characterId: state.characterId,
      sessionId: state.sessionId,
      readOnly: state.readOnly,
      busy: state.busy,
      activeSessionId: state.activeSessionId,
      error: state.error,
      memoryOpen: state.memoryOpen,
    })),
  );
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [wide, setWide] = useState(false);
  useTheme();
  useEffect(() => {
    void initialize();
    const blocked = () =>
      useAppStore.setState({
        error:
          "本地数据库需要升级。请关闭其他打开本站的标签页后刷新，此前的数据不会删除。",
        readOnly: true,
      });
    window.addEventListener("roleplay-db-blocked", blocked);
    return () => window.removeEventListener("roleplay-db-blocked", blocked);
  }, []);
  useEffect(() => {
    const media = matchMedia("(min-width: 1200px)");
    const change = () => setWide(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    setNavOpen(false);
  }, [app.sessionId, app.characterId]);
  if (!app.ready)
    return (
      <main className="flex h-dvh items-center justify-center bg-background p-8">
        <div className="max-w-sm text-center">
          <LeafIcon className="mx-auto mb-5 size-8 text-primary" />
          <p
            role={app.bootError ? "alert" : "status"}
            className="text-sm leading-7 text-muted-foreground"
          >
            {app.bootError || "正在找回你的故事…"}
          </p>
          {app.bootError && (
            <Button
              variant="outline"
              className="mt-5"
              onClick={() => location.reload()}
            >
              重新打开
            </Button>
          )}
        </div>
      </main>
    );
  const character = app.characters.find((item) => item.id === app.characterId);
  const session = app.sessions.find((item) => item.id === app.sessionId);
  return (
    <OpenDialog.Provider value={setDialog}>
      <ChatRuntimeProvider key={`${app.characterId}:${app.sessionId}`}>
        <main className="flex h-dvh min-h-0 w-full overflow-hidden bg-background">
          <aside className="hidden w-64 shrink-0 border-r md:block">
            <Navigation />
          </aside>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex min-h-18 shrink-0 items-center gap-2 border-b px-3 sm:px-6">
              <Button
                variant="ghost"
                size="icon"
                className="size-11 md:hidden"
                aria-label="打开会话导航"
                onClick={() => setNavOpen(true)}
              >
                <MenuIcon />
              </Button>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-base font-medium">
                  {session?.title ??
                    (character ? `${character.name}的故事` : "欢迎来到青笺")}
                </h1>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {session ? (
                    <SaveIndicator name={session.characterSnapshot.name} />
                  ) : (
                    "与角色相识，让故事慢慢发生"
                  )}
                </p>
              </div>
              {character && (
                <>
                  <Button
                    variant="ghost"
                    className="h-11 px-3 text-sm"
                    onClick={() =>
                      useAppStore.setState({ memoryOpen: !app.memoryOpen })
                    }
                    aria-label="打开剧情与记忆"
                    aria-expanded={app.memoryOpen}
                  >
                    <BookOpenIcon />
                    <span className="hidden sm:inline">剧情与记忆</span>
                  </Button>
                  <MoreMenu
                    label="角色与会话菜单"
                    items={[
                      ...(session
                        ? [
                            {
                              label: "重命名对话",
                              action: () =>
                                setDialog({ kind: "rename", session }),
                              disabled: app.readOnly,
                            },
                            {
                              label: "对话详情",
                              action: () =>
                                setDialog({ kind: "session-details", session }),
                            },
                          ]
                        : []),
                      {
                        label: "编辑角色设定",
                        action: () =>
                          setDialog({ kind: "character", character }),
                        disabled: app.readOnly,
                      },
                      {
                        label: "复制为新角色",
                        action: () =>
                          setDialog({
                            kind: "character",
                            character,
                            copy: true,
                          }),
                        disabled: app.readOnly,
                      },
                      ...(session
                        ? [
                            {
                              label: "删除对话",
                              action: () =>
                                setDialog({ kind: "delete-session", session }),
                              disabled:
                                app.readOnly ||
                                app.activeSessionId === session.id,
                              destructive: true,
                            },
                          ]
                        : []),
                    ]}
                  />
                </>
              )}
            </header>
            {app.readOnly && (
              <p
                role="status"
                className="border-b px-5 py-3 text-sm text-muted-foreground"
              >
                另一个标签页正在使用数据，本页为只读。关闭另一页后刷新可继续编辑。
              </p>
            )}
            {app.error && (
              <div
                role="alert"
                className="flex items-start gap-2 border-b bg-destructive/5 px-5 py-3 text-sm leading-6 text-destructive"
              >
                <p className="min-w-0 flex-1 break-words">{app.error}</p>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="关闭提示"
                  className="size-8 shrink-0"
                  onClick={() => useAppStore.setState({ error: "" })}
                >
                  <XIcon />
                </Button>
              </div>
            )}
            {session ? (
              <>
                <div className="min-h-0 flex-1">
                  <Thread components={THREAD_COMPONENTS} autoFocus={false} />
                </div>
                {app.activeSessionId && app.activeSessionId !== session.id && (
                  <div className="flex items-center justify-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
                    <span>另一段对话正在回复</span>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => {
                        void selectSession(app.activeSessionId!).catch(report);
                      }}
                    >
                      前往
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void cancelGeneration();
                      }}
                    >
                      停止
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center px-8 pb-12">
                <div className="max-w-md text-center">
                  <LeafIcon className="mx-auto mb-6 size-10 stroke-[1.2] text-primary" />
                  <h2 className="text-2xl font-medium tracking-wide">
                    {character ? "每一次相遇，都能续写" : "走进一场新的相遇"}
                  </h2>
                  <p className="mt-4 whitespace-pre-line text-sm leading-7 text-muted-foreground">
                    {character
                      ? "开启一段对话，或从侧栏继续故事。\n重要的记忆，陪伴点点滴滴"
                      : "写下你心中的角色信息，\n然后打开你们的故事"}
                  </p>
                  <Button
                    className="mt-7 h-11"
                    disabled={app.readOnly || app.busy || !!character?.archived}
                    onClick={() =>
                      character
                        ? void newSession().catch(report)
                        : setDialog({ kind: "character" })
                    }
                  >
                    <PlusIcon />
                    {character ? "开始对话" : "创建第一个角色"}
                  </Button>
                  {!character && (
                    <Button
                      variant="ghost"
                      className="ml-2 mt-7 h-11"
                      onClick={() => setDialog({ kind: "settings" })}
                    >
                      导入备份
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          {wide && app.memoryOpen && character && (
            <aside className="w-80 shrink-0 border-l">
              <StatePanel key={app.sessionId} />
            </aside>
          )}
        </main>
        <Dialog open={navOpen} onOpenChange={setNavOpen}>
          <DialogContent
            showCloseButton
            className="inset-y-0 left-0 h-dvh max-h-dvh w-[min(85vw,20rem)] max-w-none translate-x-0 translate-y-0 rounded-none border-y-0 border-l-0 p-0 sm:max-w-none"
          >
            <DialogTitle className="sr-only">角色与对话导航</DialogTitle>
            <DialogDescription className="sr-only">
              选择角色或打开一段对话
            </DialogDescription>
            <Navigation />
          </DialogContent>
        </Dialog>
        <Dialog
          open={!wide && app.memoryOpen && !!character}
          onOpenChange={(open) => useAppStore.setState({ memoryOpen: open })}
        >
          <DialogContent
            showCloseButton={false}
            className="inset-y-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none border-y-0 border-r-0 p-0 sm:w-96 sm:max-w-none"
          >
            <DialogTitle className="sr-only">剧情与记忆</DialogTitle>
            <DialogDescription className="sr-only">
              查看与维护当前剧情、记忆与目标
            </DialogDescription>
            <StatePanel key={app.sessionId} />
          </DialogContent>
        </Dialog>
      </ChatRuntimeProvider>
      <AppDialogs state={dialog} change={setDialog} />
    </OpenDialog.Provider>
  );
}
