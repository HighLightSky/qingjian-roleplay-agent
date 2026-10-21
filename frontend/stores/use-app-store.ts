"use client";

import { validateStory, validateGoalValue } from "@/lib/state/validation";

import { create } from "zustand";
import * as db from "@/lib/db";
import { prepareImageContext } from "@/lib/images/coordinator";
import {
  resumePendingTasks,
  runStateTask,
  saveCompletedStateTask,
} from "@/lib/state/coordinator";
import type {
  Operation,
  Goal,
  GoalValue,
  MemoryValue,
  Story,
} from "@/lib/state/types";
import { imageIds, type ContentPart } from "@/lib/images/types";
import { chatContext } from "@/lib/chat/context";
import { streamChat } from "@/lib/chat/sse";
import {
  appendDelta,
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
        void recoverStateTasks().catch(report);
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
  void recoverStateTasks().catch(report);
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
) {
  const preferred =
    existing?.id === get().characterId
      ? (get().sessionId ?? undefined)
      : undefined;
  const character = await write(() => db.saveCharacter(profile, existing));
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
export async function saveMemory(value: MemoryValue, existing?: Memory) {
  const { characterId, sessionId } = get();
  if (!characterId || !sessionId) throw new Error("请先选择会话。");
  await write(() => db.putMemory(characterId, sessionId, value, existing));
  await refreshActivity();
}
export async function removeMemory(memory: Memory) {
  await saveMemory({ ...memory.value, status: "dismissed" }, memory);
}
export async function saveStory(story: Story, expectedVersion: number) {
  validateStory(story);
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
  const sessionId = get().sessionId;
  if (!sessionId) throw new Error("请先选择会话。");
  validateGoalValue(value);
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
      if (
        !existing &&
        (await tx.objectStore("goals").index("session").count(sessionId)) >= 20
      )
        throw new Error("当前会话最多保留 20 个目标。");
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
    throw new Error("已有一段对话正在执行，请稍候或先停止。");
  const { sessionId, characterId, readOnly } = get();
  if (!sessionId || !characterId || readOnly)
    throw new Error("当前会话不可发送。");
  if ((!text.trim() && !imageIds(parts).length) || text.length > 2000)
    throw new Error("请输入文字或选择图片，文字最多 2000 个字符。");
  set({ activeSessionId: sessionId, preparingInput: true, error: "" });
  const runController = new AbortController();
  controller = runController;
  let reply: Message | undefined;
  let completedSaved = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paintTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let storageError: unknown;
  let preparationError: unknown;
  const publish = () => {
    if (get().sessionId === sessionId && reply)
      set((state) => ({
        messages: state.messages.map((m) => (m.id === reply!.id ? reply! : m)),
      }));
  };
  const persist = () => {
    if (!reply || storageError) return;
    const snapshot = structuredClone(reply);
    queue = queue
      .then(() => write(() => db.checkpoint(snapshot)))
      .catch((error) => {
        storageError = error;
        runController.abort();
      });
  };
  const run = async () => {
    try {
      await flushDrafts();
      await writes;
      const database = await db.database();
      const historyAtSend = await db.allMessages(sessionId);
      const retryUser = retryUserId
        ? historyAtSend.find((m) => m.id === retryUserId && m.role === "user")
        : undefined;
      if (
        retryUserId &&
        (!retryUser ||
          retryUser.seq !==
            historyAtSend.filter((m) => m.role === "user").at(-1)?.seq)
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
            : [...state.messages, turn.user, turn.assistant],
          draft: "",
        }));
      await refreshActivity();
      await resumePendingTasks(
        sessionId,
        runController.signal,
        write,
        refreshActivity,
      );
      const [character, session, memories, goals] = await Promise.all([
        database.get("characters", characterId),
        database.get("sessions", sessionId),
        database.getAllFromIndex("memories", "character", characterId),
        database.getAllFromIndex("goals", "session", sessionId),
      ]);
      if (!character || !session) throw new Error("角色或会话不存在。");
      if (character.archived) throw new Error("请先恢复角色，再继续对话。");
      const history = (await db.allMessages(sessionId)).filter(
        (m) => m.seq < turn.user.seq,
      );
      const base = chatContext(
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
      const body = await prepareImageContext(
        base,
        sessionId,
        history,
        runController.signal,
        reply.id,
        recordOperation,
      );
      runController.signal.throwIfAborted();
      set({ preparingInput: false });
      const reason = await streamChat(body, runController.signal, (delta) => {
        reply = appendDelta(reply!, delta);
        liveReply = reply;
        if (!paintTimer)
          paintTimer = setTimeout(() => {
            paintTimer = undefined;
            publish();
          }, 32);
        if (!timer) {
          persist();
          timer = setTimeout(() => {
            timer = undefined;
            persist();
          }, 500);
        }
      });
      clearTimeout(timer);
      clearTimeout(paintTimer);
      await queue;
      if (storageError) throw storageError;
      reply = {
        ...reply,
        status: reason === "stop" && plainText(reply) ? "complete" : "error",
        finishReason: reason,
        error:
          reason === "stop"
            ? plainText(reply)
              ? undefined
              : "本次未返回正文。"
            : reason === "length"
              ? "输出达到模型长度限制。"
              : `回复未正常完成（${reason}）。`,
        checkpointVersion: reply.checkpointVersion + 1,
        updatedAt: now(),
      };
      if (reply.status === "complete") {
        const task = await write(() => saveCompletedStateTask(body, reply!));
        completedSaved = true;
        publish();
        await refreshActivity();
        try {
          await runStateTask(
            task,
            runController.signal,
            write,
            refreshActivity,
          );
        } catch (error) {
          if (!runController.signal.aborted)
            report(new Error(`正文已保存，整理待重试：${errorText(error)}`));
        }
      }
    } catch (error) {
      const cancelled = runController.signal.aborted && !storageError;
      if (!reply) preparationError = error;
      if (reply && !completedSaved)
        reply = {
          ...reply,
          status: cancelled ? "cancelled" : "error",
          error: cancelled
            ? "已停止，保留已收到的内容。"
            : errorText(storageError ?? error),
          checkpointVersion: reply.checkpointVersion + 1,
          updatedAt: now(),
        };
      if (!cancelled) report(storageError ?? error);
    } finally {
      clearTimeout(timer);
      clearTimeout(paintTimer);
      await queue;
      if (reply) {
        publish();
        try {
          await write(() => db.checkpoint(reply!));
        } catch (error) {
          report(error);
        }
      }
      if (controller === runController) controller = null;
      liveReply = null;
      set({ activeSessionId: null, preparingInput: false });
    }
  };
  const currentRun = run();
  generation = currentRun;
  try {
    await currentRun;
  } finally {
    if (generation === currentRun) generation = null;
  }
  if (preparationError) throw preparationError;
}

export async function recoverStateTasks(operationId?: string) {
  const sessionId = get().sessionId;
  if (!sessionId || get().readOnly || get().activeSessionId) return;
  const tasks = await (
    await db.database()
  ).getAllFromIndex("stateTasks", "session", sessionId);
  if (!tasks.length || get().activeSessionId || get().sessionId !== sessionId)
    return;
  const runController = new AbortController();
  controller = runController;
  set({ activeSessionId: sessionId });
  const currentRun = (async () => {
    for (const task of tasks.sort((a, b) => a.throughSeq - b.throughSeq)) {
      await runStateTask(
        task,
        runController.signal,
        write,
        refreshActivity,
        task.id === operationId,
      );
      if (task.id === operationId) break;
    }
  })()
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
export async function retryLastMessage() {
  const sessionId = get().sessionId;
  if (!sessionId) return;
  const messages = await db.allMessages(sessionId);
  const user = messages.filter((m) => m.role === "user").at(-1);
  if (!user) return;
  return sendMessage(user.text ?? "", user.parts, user.id);
}
export async function cancelGeneration() {
  controller?.abort();
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
