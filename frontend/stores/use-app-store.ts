"use client";

import { IMAGE_SEQUENCE_KEY } from "@/lib/images/ids";

import { create } from "zustand";
import * as db from "@/lib/db";
import { buildCatalog, warmImageCache } from "@/lib/images/coordinator";
import {
  followDispatch,
  dispatchError,
  ResultExpired,
  DispatchRejected,
  type StoredRun,
  type DispatchSnapshot,
} from "@/lib/chat/dispatch";
import {
  acceptStateResult,
  runStateTask,
  saveCompletedStateTask,
} from "@/lib/state/coordinator";
import type {
  Operation,
  Goal,
  GoalValue,
  MemoryValue,
  Story,
  StateSnapshot,
} from "@/lib/state/types";
import { imageIds, type ContentPart } from "@/lib/images/types";
import {
  chatContext,
  stateSnapshot,
  type ChatContext,
} from "@/lib/chat/context";
import {
  ensureContextBudget,
  resumeCompactionTasks,
} from "@/lib/context/coordinator";
import { unknownUsage, type ContextBudget } from "@/lib/context/types";
import {
  DEFAULT_INTERACTION_SETTINGS,
  errorText,
  now,
  id,
  plainText,
  parseInteractionSettings,
  visibleCharacters,
  type Character,
  type CharacterProfile,
  type Memory,
  type Message,
  type Session,
  type ThemeMode,
  type InteractionSettings,
} from "@/lib/domain";
import { restoreSnapshot, takeSnapshot, type Backup } from "@/lib/backup";

type AppState = {
  contextBudget: { sessionId: string; budget: ContextBudget } | null;
  ready: boolean;
  bootError: string;
  readOnly: boolean;
  busy: boolean;
  error: string;
  saveStatus: "saved" | "saving" | "failed";
  characters: Character[];
  sessions: Session[];
  memories: Memory[];
  goals: Goal[];
  operations: Operation[];
  characterId: string | null;
  sessionId: string | null;
  messages: Message[];
  hasEarlier: boolean;
  loadingMessages: boolean;
  draft: string;
  themeMode: ThemeMode;
  interactionSettings: InteractionSettings;
  activeSessionId: string | null;
  preparingInput: boolean;
  memoryOpen: boolean;
};
export const useAppStore = create<AppState>(() => ({
  contextBudget: null,
  ready: false,
  bootError: "",
  readOnly: false,
  busy: false,
  error: "",
  saveStatus: "saved",
  characters: [],
  sessions: [],
  memories: [],
  goals: [],
  operations: [],
  characterId: null,
  sessionId: null,
  messages: [],
  hasEarlier: false,
  loadingMessages: false,
  draft: "",
  themeMode: "system",
  interactionSettings: { ...DEFAULT_INTERACTION_SETTINGS },
  activeSessionId: null,
  preparingInput: false,
  memoryOpen: false,
}));
const get = useAppStore.getState;
const set = useAppStore.setState;
let writes: Promise<unknown> = Promise.resolve();
export function write<T>(task: () => Promise<T>): Promise<T> {
  if (get().readOnly)
    return Promise.reject(
      new Error("此标签页为只读，请关闭另一标签页后刷新。"),
    );
  const result = writes.then(async () => {
    set({ saveStatus: "saving" });
    return task();
  });
  writes = result.then(
    () => {
      set({ saveStatus: "saved" });
    },
    (error) => {
      set({ error: errorText(error), saveStatus: "failed" });
    },
  );
  return result;
}
export function report(error: unknown) {
  set({ error: errorText(error) });
}
let initPromise: Promise<void> | undefined;
let selection = 0;
let controller: AbortController | null = null;
let generation: Promise<void> | null = null;
let dispatchRunId: string | null = null;
let liveReply: Message | null = null;
function readInteractionSettings(
  value: string | undefined,
): InteractionSettings {
  if (value === undefined) return { ...DEFAULT_INTERACTION_SETTINGS };
  try {
    return parseInteractionSettings(JSON.parse(value));
  } catch {
    throw new Error("保存的交互设置无效，请清空本地数据或导入有效备份。");
  }
}
const draftBuffers = new Map<
  string,
  { text: string; timer: ReturnType<typeof setTimeout> }
>();

async function acquireWriteLock() {
  if (!navigator.locks) return;
  await new Promise<void>((resolve, reject) => {
    void navigator.locks
      .request("roleplay-agent-writer", { ifAvailable: true }, async (lock) => {
        set({ readOnly: !lock });
        resolve();
        if (lock) await new Promise<void>(() => {});
      })
      .catch(reject);
  });
}
export function initialize() {
  if (!initPromise)
    initPromise = (async () => {
      try {
        await acquireWriteLock();
        if (!get().readOnly) await db.recoverInterrupted();
        const database = await db.database();
        const [characters, settings] = await Promise.all([
          database.getAll("characters"),
          database.getAll("settings"),
        ]);
        const saved = new Map(settings.map((item) => [item.key, item.value]));
        const mode = saved.get("themeMode");
        set({
          characters,
          themeMode: mode === "dark" || mode === "light" ? mode : "system",
          interactionSettings: readInteractionSettings(
            saved.get("interactionSettings"),
          ),
        });
        const character =
          characters.find((item) => item.id === saved.get("characterId")) ??
          characters.find((item) => !item.archived);
        if (character)
          await selectCharacter(character.id, saved.get("sessionId"));
        set({ ready: true, bootError: "" });
        void resumeDispatch().catch(report);
      } catch (error) {
        set({ bootError: `无法打开本地数据：${errorText(error)}` });
        initPromise = undefined;
      }
    })();
  return initPromise;
}
export async function refreshMetadata() {
  const database = await db.database();
  const characters = await database.getAll("characters");
  const characterId = get().characterId;
  const [sessions, memories] = characterId
    ? await Promise.all([
        database.getAllFromIndex("sessions", "character", characterId),
        database.getAllFromIndex("memories", "character", characterId),
      ])
    : [[], []];
  if (get().characterId !== characterId) return;
  set({
    characters,
    sessions: sessions.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    ),
    memories: memories.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  });
}
export async function selectCharacter(
  characterId: string,
  preferredSession?: string,
) {
  await cancelGeneration();
  await flushDrafts();
  const version = ++selection;
  set({
    characterId,
    sessionId: null,
    messages: [],
    sessions: [],
    memories: [],
    goals: [],
    operations: [],
    draft: "",
    loadingMessages: true,
    memoryOpen: false,
  });
  await refreshMetadata();
  if (selection !== version) return;
  const session =
    get().sessions.find((item) => item.id === preferredSession) ??
    get().sessions[0];
  if (session) await selectSession(session.id);
  else set({ loadingMessages: false, hasEarlier: false });
  if (!get().readOnly)
    await write(() => db.setting("characterId", characterId));
}
export async function selectSession(sessionId: string) {
  await cancelGeneration();
  await flushDrafts();
  const version = ++selection;
  set({
    sessionId,
    messages: [],
    draft: "",
    loadingMessages: true,
    hasEarlier: false,
  });
  const [page, draft] = await Promise.all([
    db.getMessages(sessionId),
    (await db.database()).get("drafts", sessionId),
  ]);
  if (selection !== version) return;
  const currentReply = liveReply?.sessionId === sessionId ? liveReply : null;
  set({
    ...page,
    messages: currentReply
      ? page.messages.map((message) =>
          message.id === currentReply.id ? currentReply : message,
        )
      : page.messages,
    draft: draft?.text ?? "",
    loadingMessages: false,
  });
  if (!get().readOnly) await write(() => db.setting("sessionId", sessionId));
  await refreshActivity();
}
export async function loadEarlier() {
  const { sessionId, messages } = get();
  if (!sessionId || !messages.length) return;
  const page = await db.getMessages(sessionId, messages[0].seq);
  if (get().sessionId === sessionId)
    set((state) => ({
      messages: [...page.messages, ...state.messages],
      hasEarlier: page.hasEarlier,
    }));
}
export function pauseDraft(sessionId: string) {
  const draft = draftBuffers.get(sessionId);
  if (draft) clearTimeout(draft.timer);
}
export function scheduleDraft(sessionId: string, text: string) {
  if (get().readOnly) return;
  const old = draftBuffers.get(sessionId);
  if (old) clearTimeout(old.timer);
  const timer = setTimeout(() => {
    void flushDrafts().catch(report);
  }, 300);
  draftBuffers.set(sessionId, { text, timer });
  set({ saveStatus: "saving" });
}
export async function flushDrafts() {
  const buffered = Array.from(draftBuffers);
  draftBuffers.clear();
  if (!buffered.length) return;
  for (const [, draft] of buffered) clearTimeout(draft.timer);
  await write(async () => {
    const database = await db.database();
    const tx = database.transaction(["drafts", "sessions"], "readwrite");
    for (const [sessionId, draft] of buffered)
      if (await tx.objectStore("sessions").get(sessionId))
        await tx.objectStore("drafts").put({
          ...(await tx.objectStore("drafts").get(sessionId)),
          sessionId,
          text: draft.text,
          updatedAt: now(),
        });
    await tx.done;
  });
}
export async function newSession() {
  if (get().busy) return;
  const characterId = get().characterId;
  if (!characterId) return;
  set({ busy: true });
  try {
    await flushDrafts();
    const session = await write(() => db.createSession(characterId));
    if (get().characterId === characterId) {
      await refreshMetadata();
      await selectSession(session.id);
    }
  } finally {
    set({ busy: false });
  }
}
export async function saveProfile(
  profile: CharacterProfile,
  existing?: Character,
  draftKey?: string,
) {
  const preferred =
    existing?.id === get().characterId
      ? (get().sessionId ?? undefined)
      : undefined;
  if (existing?.id === get().characterId) await cancelGeneration();
  await validateEdit("character", {
    ...profile,
    profileVersion: existing?.profileVersion ?? 1,
  });
  const character = await write(() =>
    db.saveCharacter(profile, existing, draftKey),
  );
  await refreshMetadata();
  await selectCharacter(character.id, preferred);
  return character;
}
export async function archiveCharacter(character: Character) {
  await write(async () => {
    const database = await db.database();
    const tx = database.transaction("characters", "readwrite");
    const current = await tx.store.get(character.id);
    if (!current) throw new Error("角色不存在。");
    await tx.store.put({
      ...current,
      archived: !current.archived,
      updatedAt: now(),
    });
    await tx.done;
  });
  await refreshMetadata();
}
export async function renameSession(session: Session, title: string) {
  if (!title.trim() || visibleCharacters(title.trim()).length > 60)
    throw new Error("标题需要在 1–60 个可见字符之间。");
  await write(async () => {
    const database = await db.database();
    const tx = database.transaction("sessions", "readwrite");
    const current = await tx.store.get(session.id);
    if (!current) throw new Error("会话不存在。");
    await tx.store.put({
      ...current,
      title: title.trim(),
      titleSource: "manual",
      updatedAt: now(),
    });
    await tx.done;
  });
  await refreshMetadata();
}
export async function removeSession(session: Session) {
  if (get().activeSessionId === session.id)
    throw new Error("请先停止这段对话的生成。");
  await flushDrafts();
  await write(() => db.deleteSession(session.id));
  await refreshMetadata();
  if (get().sessionId === session.id) {
    const next = get().sessions[0];
    if (next) await selectSession(next.id);
    else {
      ++selection;
      set({ sessionId: null, messages: [], draft: "", hasEarlier: false });
    }
  }
}
export async function refreshActivity() {
  const sessionId = get().sessionId;
  const database = await db.database();
  const [operations, goals] = sessionId
    ? await Promise.all([
        database.getAllFromIndex("operations", "session", sessionId),
        database.getAllFromIndex("goals", "session", sessionId),
      ])
    : [[], []];
  await refreshMetadata();
  if (get().sessionId === sessionId) set({ operations, goals });
}
async function recordOperation(operation: Operation) {
  await write(() =>
    db.database().then((database) => database.put("operations", operation)),
  );
  await refreshActivity();
}
async function validateEdit(kind: "character" | "state", value: unknown) {
  const response = await fetch(`/api/validate/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error((await response.json()).message);
}
async function validateStateEdit(edit: (state: StateSnapshot) => void) {
  await cancelGeneration();
  await writes;
  const database = await db.database();
  const sessionId = get().sessionId;
  const session = sessionId
    ? await database.get("sessions", sessionId)
    : undefined;
  if (!session) throw new Error("当前会话不存在。");
  const character = await database.get("characters", session.characterId);
  if (!character) throw new Error("角色不存在。");
  const state = stateSnapshot(
    character,
    session,
    await database.getAllFromIndex("memories", "character", character.id),
    await database.getAllFromIndex("goals", "session", session.id),
  );
  edit(state);
  await validateEdit("state", state);
}

export async function saveMemory(value: MemoryValue, existing?: Memory) {
  const { characterId, sessionId } = get();
  if (!characterId || !sessionId) throw new Error("请先选择会话。");
  await validateStateEdit((state) => {
    state.memories = state.memories.filter((m) => m.id !== existing?.id);
    state.memories.push({
      id: existing?.id ?? id(),
      characterId,
      sessionId: value.scope === "character" ? null : sessionId,
      value,
      version: existing?.version ?? 1,
      origin: "manual",
      sourceSessionId: sessionId,
      sourceMessageIds: [],
      updatedAt: now(),
    });
  });
  await write(() => db.putMemory(characterId, sessionId, value, existing));
  await refreshActivity();
}
export async function removeMemory(memory: Memory) {
  await saveMemory({ ...memory.value, status: "dismissed" }, memory);
}
export async function saveStory(story: Story, expectedVersion: number) {
  await validateStateEdit((state) => {
    state.story = story;
  });
  const sessionId = get().sessionId;
  if (!sessionId) throw new Error("请先选择会话。");
  await write(async () => {
    const database = await db.database();
    const tx = database.transaction("sessions", "readwrite");
    const session = await tx.store.get(sessionId);
    if (!session || session.stateVersion !== expectedVersion)
      throw new Error("剧情已变化，请重新打开编辑。");
    const storySources = { ...session.storySources };
    for (const key of Object.keys(story) as (keyof Story)[]) {
      if (JSON.stringify(story[key]) !== JSON.stringify(session.story[key]))
        storySources[key] = {
          origin: "manual",
          updatedAt: now(),
          sourceMessageIds: [],
        };
    }
    await tx.store.put({
      ...session,
      story,
      storySources,
      stateVersion: session.stateVersion + 1,
      updatedAt: now(),
    });
    await tx.done;
  });
  await refreshActivity();
}
export async function saveGoal(value: GoalValue, existing?: Goal) {
  await validateStateEdit((state) => {
    state.goals = state.goals.filter((g) => g.id !== existing?.id);
    state.goals.push({
      id: existing?.id ?? id(),
      sessionId: state.sessionId,
      value,
      version: existing?.version ?? 1,
      origin: "manual",
      sourceMessageIds: [],
      updatedAt: now(),
    });
  });
  const sessionId = get().sessionId;
  if (!sessionId) throw new Error("请先选择会话。");
  await write(async () => {
    const database = await db.database();
    const tx = database.transaction(["sessions", "goals"], "readwrite");
    await db.atomic(tx, async () => {
      const session = await tx.objectStore("sessions").get(sessionId);
      if (!session) throw new Error("会话不存在。");
      const previous = existing
        ? await tx.objectStore("goals").get(existing.id)
        : undefined;
      if (existing && previous?.version !== existing.version)
        throw new Error("目标已变化，请重新打开编辑。");
      await tx.objectStore("goals").put({
        id: existing?.id ?? id(),
        sessionId,
        value,
        version: (previous?.version ?? 0) + 1,
        origin: "manual",
        sourceMessageIds: previous?.sourceMessageIds ?? [],
        createdAt: previous?.createdAt ?? now(),
        updatedAt: now(),
      });
      await tx.objectStore("sessions").put({
        ...session,
        stateVersion: session.stateVersion + 1,
        updatedAt: now(),
      });
    });
  });
  await refreshActivity();
}
export async function changeTheme(themeMode: ThemeMode) {
  await write(() => db.setting("themeMode", themeMode));
  set({ themeMode });
}

export async function updateInteractionSettings(
  patch: Partial<InteractionSettings>,
) {
  if (!get().ready || get().busy)
    throw new Error("请等待当前操作完成后再修改交互设置。");
  await write(async () => {
    // 在串行写入任务中读取最新状态，两个控件的更新不会互相覆盖。
    const settings = parseInteractionSettings({
      ...get().interactionSettings,
      ...patch,
    });
    await db.setting("interactionSettings", JSON.stringify(settings));
    set({ interactionSettings: settings });
  });
}

export async function sendMessage(
  text: string,
  parts?: ContentPart[],
  retryUserId?: string,
) {
  if (get().activeSessionId)
    throw new Error("已有任务正在执行，请稍候或先停止。");
  const { sessionId, characterId, readOnly } = get();
  if (!sessionId || !characterId || readOnly)
    throw new Error("当前会话不可发送。");
  const runController = new AbortController();
  controller = runController;
  set({ activeSessionId: sessionId, preparingInput: true, error: "" });
  let reply: Message | undefined;
  let preparationError: unknown;
  const run = (async () => {
    try {
      await flushDrafts();
      await writes;
      const database = await db.database();
      for (const row of (await database.getAll("settings")).filter((row) =>
        row.key.startsWith("dispatch:"),
      )) {
        const previous = JSON.parse(row.value) as StoredRun;
        dispatchRunId = previous.runId;
        await consumeRun(previous, runController.signal);
        dispatchRunId = null;
      }
      const historyAtSend = await db.allMessages(sessionId);
      const retryUser = retryUserId
        ? historyAtSend.find((m) => m.id === retryUserId && m.role === "user")
        : undefined;
      if (
        retryUserId &&
        (!retryUser ||
          retryUser.id !==
            historyAtSend.filter((m) => m.role === "user").at(-1)?.id)
      )
        throw new Error("仅支持重试最近一条用户消息。");
      const turn = await write(async () => {
        if (!retryUser) return db.beginTurn(sessionId, text, parts);
        const previous = historyAtSend.find(
          (m) => m.role === "assistant" && m.replyToMessageId === retryUser.id,
        );
        if (!previous || previous.status === "complete")
          throw new Error("这条消息无需重试。");
        const assistant: Message = {
          ...previous,
          segments: [],
          status: "pending",
          error: undefined,
          finishReason: undefined,
          usage: unknownUsage(),
          checkpointVersion: previous.checkpointVersion + 1,
          updatedAt: now(),
        };
        await database.put("messages", assistant);
        return { user: retryUser, assistant };
      });
      reply = turn.assistant;
      liveReply = reply;
      if (get().sessionId === sessionId)
        set((state) => ({
          messages: retryUser
            ? state.messages.map((m) => (m.id === reply!.id ? reply! : m))
            : [...state.messages, turn.user, reply!],
          draft: "",
        }));
      const [character, session, memories, goals] = await Promise.all([
        database.get("characters", characterId),
        database.get("sessions", sessionId),
        database.getAllFromIndex("memories", "character", characterId),
        database.getAllFromIndex("goals", "session", sessionId),
      ]);
      if (!character || !session) throw new Error("角色或会话不存在。");
      if (character.archived) throw new Error("请先恢复角色，再继续对话。");
      const history = historyAtSend.filter((m) => m.seq < turn.user.seq);
      let context: ChatContext = chatContext(
        character,
        session,
        memories,
        history,
        text,
        { ...get().interactionSettings },
        parts,
        goals,
        `select:${reply.id}`,
      );
      context = {
        ...context,
        visual: {
          sessionId,
          assetCatalog: await buildCatalog(sessionId, history),
          plan: null,
          imagePayloads: [],
        },
      };
      const prepared = await ensureContextBudget(
        context,
        "preview",
        reply.id,
        runController.signal,
        write,
        refreshActivity,
        { batches: 0 },
      );
      const images = await warmImageCache(
        prepared.context,
        runController.signal,
      );
      runController.signal.throwIfAborted();
      const stored: StoredRun = {
        runId: `run:${reply.id}:${id()}`,
        sessionId,
        assistantMessageId: reply.id,
        context: prepared.context,
      };
      await write(() =>
        db.setting(`dispatch:${stored.runId}`, JSON.stringify(stored)),
      );
      dispatchRunId = stored.runId;
      await consumeRun(stored, runController.signal, {
        runId: stored.runId,
        context: prepared.context,
        images,
        user: {
          id: turn.user.id,
          seq: turn.user.seq,
          createdAt: turn.user.createdAt,
        },
        assistant: { id: reply.id, seq: reply.seq, createdAt: reply.createdAt },
      });
    } catch (error) {
      if (!reply) preparationError = error;
      if (!dispatchRunId && reply) {
        reply = {
          ...reply,
          status: runController.signal.aborted ? "cancelled" : "error",
          error: errorText(error),
          updatedAt: now(),
        };
        await write(() => db.checkpoint(reply!));
        if (get().sessionId === sessionId)
          set((state) => ({
            messages: state.messages.map((m) =>
              m.id === reply!.id ? reply! : m,
            ),
          }));
      }
      if (!runController.signal.aborted) report(error);
    } finally {
      if (controller === runController) controller = null;
      dispatchRunId = null;
      liveReply = null;
      set({ activeSessionId: null, preparingInput: false });
    }
  })();
  generation = run;
  try {
    await run;
  } finally {
    if (generation === run) generation = null;
  }
  if (preparationError) throw preparationError;
}

async function consumeRun(
  run: StoredRun,
  signal: AbortSignal,
  request?: unknown,
) {
  const database = await db.database();
  let reply = await database.get("messages", run.assistantMessageId);
  if (!reply) throw new Error("后台任务对应的正文消息缺失。");
  let lastCheckpoint = 0;
  let lastStages = "";
  let bodySaved = reply.status === "complete";
  let task = await database.get("stateTasks", `state:${reply.id}`);
  const apply = async (snapshot: DispatchSnapshot) => {
    signal.throwIfAborted();
    const completed =
      snapshot.body?.finishReason === "stop" &&
      snapshot.segments.some((s) => s.text.trim());
    const terminalBody = !!snapshot.body || snapshot.terminal;
    // 终态正文的检查点版本只推进一次，重订阅不会改变整理来源版本。
    const firstTerminal =
      terminalBody && ["pending", "streaming"].includes(reply!.status);
    reply = {
      ...reply!,
      segments: snapshot.segments,
      status: completed
        ? "complete"
        : snapshot.terminal
          ? snapshot.stages.body?.status === "cancelled"
            ? "cancelled"
            : "error"
          : snapshot.segments.length
            ? "streaming"
            : "pending",
      usage: snapshot.body?.usage ?? unknownUsage(),
      finishReason: snapshot.body?.finishReason,
      checkpointVersion: reply!.checkpointVersion + (firstTerminal ? 1 : 0),
      updatedAt: now(),
      error: completed ? undefined : dispatchError(snapshot),
    };
    liveReply = reply;
    if (get().sessionId === run.sessionId)
      set((state) => ({
        messages: state.messages.map((m) => (m.id === reply!.id ? reply! : m)),
        ...(snapshot.budget
          ? {
              contextBudget: {
                sessionId: run.sessionId,
                budget: snapshot.budget,
              },
            }
          : {}),
        preparingInput: !snapshot.stages.body && !snapshot.terminal,
      }));
    const context = {
      ...run.context,
      visual: run.context.visual
        ? { ...run.context.visual, plan: snapshot.plan, imagePayloads: [] }
        : undefined,
    };
    if (completed && !bodySaved) {
      task = await write(() => saveCompletedStateTask(context, reply!));
      bodySaved = true;
    } else if (
      (!bodySaved && Date.now() - lastCheckpoint >= 500) ||
      snapshot.terminal
    ) {
      await write(() => db.checkpoint(reply!));
      lastCheckpoint = Date.now();
    }
    const stageKey = JSON.stringify(snapshot.stages);
    if (stageKey !== lastStages)
      for (const stage of Object.values(snapshot.stages)) {
        if (stage.name === "body") continue;
        const operationId =
          stage.name === "selection"
            ? run.context.operationId
            : `state:${reply.id}`;
        const previous = await database.get("operations", operationId);
        if (previous?.status === "committed" && stage.name === "state_update")
          continue;
        await recordOperation({
          id: operationId,
          sessionId: run.sessionId,
          runId: reply.id,
          anchorMessageId: reply.id,
          placement: stage.name === "selection" ? "before" : "after",
          kind: stage.name === "selection" ? "selection" : "state_update",
          status:
            stage.name === "state_update" && stage.status === "committed"
              ? "computed"
              : stage.status,
          createdAt: previous?.createdAt ?? now(),
          updatedAt: now(),
          error: stage.error ?? undefined,
          ...(stage.name === "selection" && snapshot.plan
            ? {
                result: {
                  plan: snapshot.plan,
                  catalog: context.visual?.assetCatalog ?? [],
                },
              }
            : {}),
        });
      }
    lastStages = stageKey;
    if (snapshot.state) {
      const operation = await database.get(
        "operations",
        snapshot.state.operationId,
      );
      if (operation?.status !== "committed") {
        if (!task) throw new Error("整理结果对应的本地待办缺失。");
        try {
          await acceptStateResult(task, snapshot.state, write, refreshActivity);
        } catch (error) {
          const state = await database.get("operations", task.id);
          if (state?.status !== "stale") throw error;
          report(error);
        }
      }
    }
    if (snapshot.terminal && snapshot.stages.state_update?.status === "failed")
      report(
        new Error(
          `正文已保存，整理失败：${snapshot.stages.state_update.error}`,
        ),
      );
  };
  try {
    await followDispatch(run, signal, apply, request);
  } catch (error) {
    if (error instanceof ResultExpired || error instanceof DispatchRejected) {
      const current = await database.get("messages", run.assistantMessageId);
      if (current && current.status !== "complete")
        await write(() =>
          db.checkpoint({
            ...current,
            status: error instanceof ResultExpired ? "interrupted" : "error",
            error: error.message,
            updatedAt: now(),
          }),
        );
      const saved = await database.get("messages", run.assistantMessageId);
      if (saved && get().sessionId === run.sessionId)
        set((state) => ({
          messages: state.messages.map((m) => (m.id === saved.id ? saved : m)),
        }));
      await write(() => database.delete("settings", `dispatch:${run.runId}`));
    }
    throw error;
  }
  // 保存完成再确认删除；确认失败保留本地任务元数据，下次只重取同一任务。
  const response = await fetch(`/api/chat/${run.runId}/ack`, {
    method: "POST",
    signal,
  });
  if (!response.ok)
    throw new Error("结果已保存，确认删除失败，稍后将再次确认。");
  await write(() => database.delete("settings", `dispatch:${run.runId}`));
  await refreshActivity();
}

export async function resumeDispatch() {
  if (get().readOnly || get().activeSessionId) return;
  const settings = await (await db.database()).getAll("settings");
  for (const row of settings.filter((s) => s.key.startsWith("dispatch:"))) {
    const run = JSON.parse(row.value) as StoredRun;
    const abort = new AbortController();
    controller = abort;
    dispatchRunId = run.runId;
    set({ activeSessionId: run.sessionId, preparingInput: true });
    const current = consumeRun(run, abort.signal)
      .catch(report)
      .finally(() => {
        controller = null;
        dispatchRunId = null;
        liveReply = null;
        set({ activeSessionId: null, preparingInput: false });
      });
    generation = current;
    try {
      await current;
    } finally {
      if (generation === current) generation = null;
    }
  }
}

export async function recoverStateTasks(operationId: string) {
  const sessionId = get().sessionId;
  if (!sessionId || get().readOnly || get().activeSessionId) return;
  const database = await db.database();
  const task = await database.get("stateTasks", operationId);
  if (!task) throw new Error("整理步骤已失效，不能重试。");
  const abort = new AbortController();
  controller = abort;
  set({ activeSessionId: sessionId });
  const current = runStateTask(task, abort.signal, write, refreshActivity)
    .catch(report)
    .finally(() => {
      controller = null;
      set({ activeSessionId: null });
    });
  generation = current;
  try {
    await current;
  } finally {
    if (generation === current) generation = null;
  }
}

export async function retryLastMessage() {
  const sessionId = get().sessionId;
  if (!sessionId) return;
  const messages = await db.allMessages(sessionId);
  const user = messages.filter((m) => m.role === "user").at(-1);
  if (!user) return;
  return sendMessage(user.text ?? "", user.parts, user.id);
}

export async function recoverCompactionTasks(operationId: string) {
  const sessionId = get().sessionId;
  if (!sessionId || get().readOnly || get().activeSessionId) return;
  const runController = new AbortController();
  controller = runController;
  set({ activeSessionId: sessionId, preparingInput: true });
  const currentRun = resumeCompactionTasks(
    sessionId,
    runController.signal,
    write,
    refreshActivity,
    operationId,
  )
    .catch((error) => {
      if (!runController.signal.aborted) report(error);
    })
    .finally(() => {
      if (controller === runController) controller = null;
      set({ activeSessionId: null, preparingInput: false });
    });
  generation = currentRun;
  try {
    await currentRun;
  } finally {
    if (generation === currentRun) generation = null;
  }
}
export async function cancelGeneration() {
  if (dispatchRunId) {
    const response = await fetch(`/api/chat/${dispatchRunId}/cancel`, {
      method: "POST",
    });
    if (!response.ok && response.status !== 404)
      throw new Error("无法取消后台任务，请确认后端连接。");
    if (!generation) controller?.abort();
  } else controller?.abort();
  await generation;
}
export async function exportBackup() {
  await cancelGeneration();
  await flushDrafts();
  await writes;
  return takeSnapshot();
}
export async function importBackup(backup: Backup) {
  await cancelGeneration();
  await flushDrafts();
  await write(() => restoreSnapshot(backup));
  const database = await db.database();
  const characters = await database.getAll("characters");
  const settings = new Map(
    (await database.getAll("settings")).map((item) => [item.key, item.value]),
  );
  const mode = settings.get("themeMode");
  set({
    characters,
    themeMode: mode === "light" || mode === "dark" ? mode : "system",
    interactionSettings: readInteractionSettings(
      settings.get("interactionSettings"),
    ),
    characterId: null,
    sessionId: null,
    sessions: [],
    messages: [],
    memories: [],
    goals: [],
    operations: [],
    draft: "",
    error: "",
  });
  const character =
    characters.find((item) => item.id === settings.get("characterId")) ??
    characters[0];
  if (character) await selectCharacter(character.id, settings.get("sessionId"));
}
export async function clearData() {
  await cancelGeneration();
  await flushDrafts();
  await write(async () => {
    const database = await db.database();
    const tx = database.transaction(db.TABLES, "readwrite");
    for (const table of db.TABLES) await tx.objectStore(table).clear();
    await tx
      .objectStore("settings")
      .put({ key: IMAGE_SEQUENCE_KEY, value: "0" });
    await tx.done;
  });
  ++selection;
  set({
    characters: [],
    sessions: [],
    memories: [],
    goals: [],
    operations: [],
    messages: [],
    characterId: null,
    sessionId: null,
    draft: "",
    hasEarlier: false,
    themeMode: "system",
    interactionSettings: { ...DEFAULT_INTERACTION_SETTINGS },
    error: "",
  });
}
