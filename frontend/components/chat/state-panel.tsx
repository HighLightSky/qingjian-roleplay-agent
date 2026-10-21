"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { XIcon, PlusIcon, StarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useAppStore,
  saveMemory,
  removeMemory,
  saveStory,
  saveGoal,
  report,
} from "@/stores/use-app-store";
import { errorText } from "@/lib/domain";
import {
  STORY_LABELS,
  STORY_TEXT_FIELDS,
  GOAL_LABELS,
  type Story,
  type Memory,
  type Goal,
  type MemoryValue,
  type GoalValue,
} from "@/lib/state/types";
import { SourceLinks } from "./source-links";

const selectClass = "min-h-10 rounded border bg-background px-2 text-sm";
const lines = (value: string) =>
  value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Editor({
  children,
  save,
  close,
}: {
  children: ReactNode;
  save: () => Promise<void>;
  close: () => void;
}) {
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const readOnly = useAppStore((s) => s.readOnly);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setWorking(true);
    try {
      await save();
      close();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setWorking(false);
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="my-3 grid gap-3 rounded border p-3"
    >
      {children}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={working || readOnly} type="submit">
          保存
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={close}>
          取消
        </Button>
      </div>
    </form>
  );
}
function StoryEditor({
  story,
  version,
  close,
}: {
  story: Story;
  version: number;
  close: () => void;
}) {
  const [value, setValue] = useState(
    () =>
      Object.fromEntries(
        Object.entries(story).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join("\n") : v,
        ]),
      ) as Record<keyof Story, string>,
  );
  const save = () =>
    saveStory(
      Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          STORY_TEXT_FIELDS.includes(k) ? v : lines(v),
        ]),
      ) as Story,
      version,
    );
  return (
    <Editor save={save} close={close}>
      {(Object.keys(STORY_LABELS) as (keyof Story)[]).map((key) => (
        <Field key={key} label={STORY_LABELS[key]}>
          <Textarea
            rows={2}
            aria-label={STORY_LABELS[key]}
            maxLength={40_000}
            value={value[key]}
            onChange={(event) =>
              setValue((v) => ({ ...v, [key]: event.target.value }))
            }
          />
        </Field>
      ))}
      <p className="text-xs text-muted-foreground">
        人物、关系、物品和线索每行一项；保存后继续自动维护。
      </p>
    </Editor>
  );
}
function MemoryEditor({
  existing,
  close,
}: {
  existing?: Memory;
  close: () => void;
}) {
  const [value, setValue] = useState<MemoryValue>(
    existing?.value ?? {
      content: "",
      scope: "session",
      kind: "fact",
      epistemicStatus: "established",
      status: "active",
    },
  );
  return (
    <Editor save={() => saveMemory(value, existing)} close={close}>
      <Field label="记忆内容">
        <Textarea
          autoFocus
          aria-label="记忆内容"
          maxLength={300}
          value={value.content}
          onChange={(e) => setValue((v) => ({ ...v, content: e.target.value }))}
        />
      </Field>
      <Field label="使用范围">
        <select
          aria-label="使用范围"
          className={selectClass}
          value={value.scope}
          onChange={(e) =>
            setValue((v) => ({
              ...v,
              scope: e.target.value as MemoryValue["scope"],
            }))
          }
        >
          <option value="session">当前会话</option>
          <option value="character">角色所有会话共享</option>
        </select>
      </Field>
      <Field label="记忆类型">
        <select
          aria-label="记忆类型"
          className={selectClass}
          value={value.kind}
          onChange={(e) =>
            setValue((v) => ({
              ...v,
              kind: e.target.value as MemoryValue["kind"],
            }))
          }
        >
          <option value="fact">事实</option>
          <option value="preference">偏好</option>
          <option value="agreement">约定</option>
          <option value="event">关键经历</option>
        </select>
      </Field>
      <Field label="事实类别">
        <select
          aria-label="事实类别"
          className={selectClass}
          value={value.epistemicStatus}
          onChange={(e) =>
            setValue((v) => ({
              ...v,
              epistemicStatus: e.target.value as MemoryValue["epistemicStatus"],
            }))
          }
        >
          <option value="established">已确认</option>
          <option value="claim">某人的陈述</option>
          <option value="hypothesis">尚待确认的推测</option>
        </select>
      </Field>
    </Editor>
  );
}
function GoalEditor({
  existing,
  close,
}: {
  existing?: Goal;
  close: () => void;
}) {
  const [value, setValue] = useState<GoalValue>(
    existing?.value ?? {
      description: "",
      status: "active",
      currentFocus: "",
      progressSummary: "",
    },
  );
  return (
    <Editor save={() => saveGoal(value, existing)} close={close}>
      <Field label="目标描述">
        <Textarea
          autoFocus
          aria-label="目标描述"
          maxLength={2000}
          value={value.description}
          onChange={(e) =>
            setValue((v) => ({ ...v, description: e.target.value }))
          }
        />
      </Field>
      <Field label="目标状态">
        <select
          aria-label="目标状态"
          className={selectClass}
          value={value.status}
          onChange={(e) =>
            setValue((v) => ({
              ...v,
              status: e.target.value as GoalValue["status"],
            }))
          }
        >
          {Object.entries(GOAL_LABELS)
            .filter(([key]) => key !== "dismissed")
            .map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
        </select>
      </Field>
      <Field label="当前关注点">
        <Textarea
          aria-label="当前关注点"
          maxLength={2000}
          value={value.currentFocus}
          onChange={(e) =>
            setValue((v) => ({ ...v, currentFocus: e.target.value }))
          }
        />
      </Field>
      <Field label="完成过程">
        <Textarea
          aria-label="完成过程"
          rows={5}
          maxLength={2000}
          placeholder="用一小段话记录从目标开始以来的重要行动、信息与进展"
          value={value.progressSummary}
          onChange={(e) =>
            setValue((v) => ({ ...v, progressSummary: e.target.value }))
          }
        />
      </Field>
    </Editor>
  );
}
export function StatePanel() {
  const app = useAppStore();
  const session = app.sessions.find((s) => s.id === app.sessionId);
  const [tab, setTab] = useState<"story" | "memory" | "goal">("story");
  const [editing, setEditing] = useState<string>();
  if (!session) return <p className="p-5 text-sm">请先创建或选择一段对话。</p>;
  const memories = app.memories.filter(
    (m) =>
      m.value.status === "active" &&
      (m.sessionId === null || m.sessionId === session.id),
  );
  const goals = app.goals.filter((g) => g.value.status !== "dismissed");
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-start justify-between border-b p-5">
        <div>
          <h2 className="text-base font-semibold tracking-wide">剧情与记忆</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            记录当下，延续故事
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭剧情与记忆"
          onClick={() => useAppStore.setState({ memoryOpen: false })}
        >
          <XIcon />
        </Button>
      </div>
      <div
        role="tablist"
        aria-label="剧情状态管理"
        className="grid grid-cols-3 border-b px-5"
      >
        {(
          [
            ["story", "剧情"],
            ["memory", "记忆"],
            ["goal", "目标"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            id={`state-tab-${key}`}
            role="tab"
            aria-selected={tab === key}
            aria-controls={`state-panel-${key}`}
            variant="ghost"
            className={`h-12 rounded-none border-b-2 hover:bg-transparent ${tab === key ? "border-foreground text-foreground" : "border-transparent text-muted-foreground"}`}
            onClick={() => {
              setTab(key);
              setEditing(undefined);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`state-panel-${tab}`}
        aria-labelledby={`state-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto break-words p-5"
      >
        {tab === "story" &&
          (editing === "story" ? (
            <StoryEditor
              key={session.id}
              story={session.story}
              version={session.stateVersion}
              close={() => setEditing(undefined)}
            />
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={app.readOnly}
                onClick={() => setEditing("story")}
              >
                修改剧情
              </Button>
              <dl className="mt-4 divide-y">
                {(Object.keys(STORY_LABELS) as (keyof Story)[]).map((key) => (
                  <div
                    key={key}
                    className="py-4 first:pt-1"
                    data-story-field={key}
                  >
                    <dt className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
                      {STORY_LABELS[key]}
                      {session.storySources[key]?.origin === "manual" && (
                        <StarIcon
                          className="size-3 fill-current"
                          aria-label="手动修改"
                          role="img"
                        >
                          <title>手动修改</title>
                        </StarIcon>
                      )}
                    </dt>
                    <dd className="mt-2 whitespace-pre-wrap text-sm leading-7">
                      {(Array.isArray(session.story[key])
                        ? session.story[key].join("\n")
                        : session.story[key]) || "尚未记录"}
                    </dd>
                    {session.storySources[key] && (
                      <div className="mt-1">
                        <SourceLinks
                          ids={session.storySources[key]!.sourceMessageIds}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </dl>
            </>
          ))}
        {tab === "memory" && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={app.readOnly}
              onClick={() => setEditing("new-memory")}
            >
              <PlusIcon />
              新增记忆
            </Button>
            {editing === "new-memory" && (
              <MemoryEditor close={() => setEditing(undefined)} />
            )}
            {!memories.length && (
              <p className="mt-4 text-sm text-muted-foreground">
                暂无重要记忆，后续对话将自动检查。
              </p>
            )}
            {memories.map((m) =>
              editing === m.id ? (
                <MemoryEditor
                  key={m.id}
                  existing={m}
                  close={() => setEditing(undefined)}
                />
              ) : (
                <article key={m.id} className="space-y-2 border-b py-4">
                  <p className="whitespace-pre-wrap text-sm leading-6">
                    {m.value.content}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {m.value.scope === "character" ? "角色共享" : "当前会话"} ·{" "}
                    {m.value.epistemicStatus === "established"
                      ? "已确认"
                      : m.value.epistemicStatus === "claim"
                        ? "陈述"
                        : "推测"}
                  </p>
                  <SourceLinks ids={m.sourceMessageIds} />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={app.readOnly}
                      onClick={() => setEditing(m.id)}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={app.readOnly}
                      onClick={() => void removeMemory(m).catch(report)}
                    >
                      删除
                    </Button>
                  </div>
                </article>
              ),
            )}
          </>
        )}
        {tab === "goal" && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={app.readOnly}
              onClick={() => setEditing("new-goal")}
            >
              <PlusIcon />
              新增目标
            </Button>
            {editing === "new-goal" && (
              <GoalEditor close={() => setEditing(undefined)} />
            )}
            {!goals.length && (
              <p className="mt-4 text-sm text-muted-foreground">
                暂无目标，不影响继续对话。
              </p>
            )}
            {goals.map((g) =>
              editing === g.id ? (
                <GoalEditor
                  key={g.id}
                  existing={g}
                  close={() => setEditing(undefined)}
                />
              ) : (
                <article
                  key={g.id}
                  className="space-y-2 border-b py-4 text-sm leading-6"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="min-w-0 font-medium">
                      {g.value.description}
                    </h3>
                    <span
                      className="mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-4 text-muted-foreground"
                      data-goal-status={g.value.status}
                    >
                      {GOAL_LABELS[g.value.status]}
                    </span>
                  </div>
                  <dl className="space-y-3 pt-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        当前关注点
                      </dt>
                      <dd className="mt-1 whitespace-pre-wrap">
                        {g.value.currentFocus || "尚未记录"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        完成过程
                      </dt>
                      <dd className="mt-1 whitespace-pre-wrap leading-7">
                        {g.value.progressSummary || "尚未记录"}
                      </dd>
                    </div>
                  </dl>
                  <SourceLinks ids={g.sourceMessageIds} />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={app.readOnly}
                      onClick={() => setEditing(g.id)}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={app.readOnly}
                      onClick={() =>
                        void saveGoal(
                          { ...g.value, status: "dismissed" },
                          g,
                        ).catch(report)
                      }
                    >
                      删除
                    </Button>
                  </div>
                </article>
              ),
            )}
          </>
        )}
      </div>
    </div>
  );
}
