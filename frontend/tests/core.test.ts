import { dispatchResponse } from "./dispatch-fixture";
import { IMAGE_SEQUENCE_KEY } from "../lib/images/ids";
import { contextFixture } from "./context-fixture";
import { emptyStateResult } from "./state-fixture";
import "fake-indexeddb/auto";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  database,
  TABLES,
  saveCharacter,
  createSession,
  beginTurn,
  checkpoint,
  recoverInterrupted,
  allMessages,
  getMessages,
  deleteSession,
  putMemory,
  setting,
} from "../lib/db";
import {
  EMPTY_PROFILE,
  DEFAULT_INTERACTION_SETTINGS,
  parseInteractionSettings,
  parseCharacterProfile,
  appendDelta,
  plainText,
  titleFrom,
  visibleCharacters,
} from "../lib/domain";
import { chatContext } from "../lib/chat/context";
import { SSEParser } from "../lib/chat/sse";
import { restoreSnapshot, takeSnapshot, validateBackup } from "../lib/backup";
import {
  updateInteractionSettings,
  sendMessage,
  useAppStore,
  importBackup,
  clearData,
  changeThemeColor,
} from "../stores/use-app-store";

beforeEach(async () => {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  await Promise.all(TABLES.map((table) => tx.objectStore(table).clear()));
  await tx.objectStore("settings").put({ key: IMAGE_SEQUENCE_KEY, value: "0" });
  await tx.done;
  useAppStore.setState({
    ready: true,
    operations: [],
    goals: [],
    activeSessionId: null,
    readOnly: false,
    busy: false,
    interactionSettings: { ...DEFAULT_INTERACTION_SETTINGS },
  });
});
async function setup() {
  const character = await saveCharacter({
    ...EMPTY_PROFILE,
    name: "林溪",
    description: "旅馆老板",
    identity: "旅馆老板，也是我的旧友",
  });
  const session = await createSession(character.id);
  return { character, session };
}
test("角色仅需名字，空会话从第一条用户消息开始，编辑保留旧快照", async () => {
  const original = await saveCharacter({ ...EMPTY_PROFILE, name: " 林溪 " });
  assert.deepEqual(
    {
      name: original.name,
      identity: original.identity,
      description: original.description,
    },
    { name: "林溪", identity: "", description: "" },
  );
  const session = await createSession(original.id);
  assert.equal(session.nextMessageSeq, 1);
  assert.deepEqual(await allMessages(session.id), []);
  const updated = await saveCharacter(
    {
      name: "林溪",
      identity: "旅馆老板，也是我的旧友",
      description: "谨慎好奇，说话直接。",
    },
    original,
  );
  const next = await createSession(original.id);
  assert.deepEqual(session.characterSnapshot, {
    name: "林溪",
    identity: "",
    description: "",
  });
  assert.deepEqual(next.characterSnapshot, {
    name: "林溪",
    identity: updated.identity,
    description: updated.description,
  });
  assert.equal(next.profileVersion, session.profileVersion + 1);
  const turn = await beginTurn(session.id, "你好");
  assert.equal(turn.user.seq, 1);
  assert.equal(turn.assistant.seq, 2);
  assert.equal(turn.session.title, "你好");
  await checkpoint({ ...turn.assistant, status: "complete" });
  const backup = await takeSnapshot();
  await restoreSnapshot(backup);
  assert.deepEqual((await takeSnapshot()).data, backup.data);
});
test("角色本地结构检查保留，自由描述不再按字符截断", async () => {
  await assert.rejects(saveCharacter({ ...EMPTY_PROFILE, name: "  " }), /角色/);
  const character = await saveCharacter({
    name: "林溪",
    identity: "身".repeat(3000),
    description: "描".repeat(10000),
  });
  assert.equal(character.description.length, 10000);
});
test("备份拒绝旧版本、无效角色草稿和快照，空名字草稿可以恢复", async () => {
  await setup();
  await setting("characterDraft:new", JSON.stringify(EMPTY_PROFILE));
  const backup = await takeSnapshot();
  assert.equal(backup.formatVersion, 15);
  validateBackup(structuredClone(backup));
  for (const formatVersion of [1, 2, 3, 4, 5, 6, 7, 8])
    assert.throws(() => validateBackup({ ...backup, formatVersion }), /版本/);
  for (const field of ["name", "identity", "description"] as const) {
    const invalid = structuredClone(backup);
    (invalid.data.sessions[0].characterSnapshot as any)[field] = null;
    assert.throws(() => validateBackup(invalid), /角色/);
  }

  const invalidDraft = structuredClone(backup);
  invalidDraft.data.settings.find(
    (s) => s.key === "characterDraft:new",
  )!.value = JSON.stringify({ name: "未完成" });
  assert.throws(() => validateBackup(invalidDraft), /角色身份/);
  const invalidTitle = structuredClone(backup);
  delete (
    invalidTitle.data.sessions[0] as Partial<
      (typeof invalidTitle.data.sessions)[0]
    >
  ).titleSource;
  assert.throws(() => validateBackup(invalidTitle), /标题来源/);
});
test("titles normalize whitespace and preserve grapheme clusters", () => {
  assert.equal(titleFrom(" \n 你好\n 阿远  "), "你好 阿远");
  const family = "👨‍👩‍👧‍👦";
  assert.equal(visibleCharacters(titleFrom(family.repeat(21))).length, 21);
  assert.equal(titleFrom(family.repeat(21)), family.repeat(20) + "…");
});
test("turns atomically name sessions and manual titles survive", async () => {
  const { session } = await setup();
  const first = await beginTurn(session.id, "请叫我阿远");
  assert.equal(first.session.title, "请叫我阿远");
  assert.equal(first.user.seq + 1, first.assistant.seq);
  assert.equal((await (await database()).get("drafts", session.id))?.text, "");
  const db = await database();
  await db.put("sessions", {
    ...first.session,
    title: "手动标题",
    titleSource: "manual",
  });
  const second = await beginTurn(session.id, "第二条输入");
  assert.equal(second.session.title, "手动标题");
  assert.equal((await db.get("drafts", session.id))?.text, "");
});
test("completed checkpoints cannot be overwritten by late streaming writes", async () => {
  const { session } = await setup();
  const { assistant } = await beginTurn(session.id, "你好");
  const partial = appendDelta(assistant, { kind: "dialogue", text: "“你好”" });
  const complete = {
    ...partial,
    status: "complete" as const,
    checkpointVersion: partial.checkpointVersion + 1,
  };
  await checkpoint(complete);
  await checkpoint({ ...partial, checkpointVersion: 100 });
  assert.equal(
    (await (await database()).get("messages", assistant.id))?.status,
    "complete",
  );
});
test("browser recovery preserves partial segments; pagination has no gaps", async () => {
  const { session } = await setup();
  for (let i = 0; i < 30; i++) await beginTurn(session.id, String(i));
  const first = (await allMessages(session.id))[1];
  await checkpoint(
    appendDelta(first, { kind: "narration", text: "（还没说完" }),
  );
  await recoverInterrupted();
  const recovered = await (await database()).get("messages", first.id);
  assert.equal(recovered?.status, "interrupted");
  assert.equal(plainText(recovered!), "（还没说完");
  const latest = await getMessages(session.id);
  assert.equal(latest.messages.length, 50);
  assert.equal(latest.hasEarlier, true);
  const earlier = await getMessages(session.id, latest.messages[0].seq);
  assert.equal(earlier.messages.length + latest.messages.length, 60);
  assert.equal(earlier.hasEarlier, false);
});
test("memories belong to characters and survive session deletion", async () => {
  const { character, session } = await setup();
  await putMemory(character.id, session.id, {
    content: "用户叫阿远",
    scope: "character",
    kind: "fact",
    epistemicStatus: "established",
    status: "active",
  });
  const other = await createSession(character.id);
  await deleteSession(session.id);
  const db = await database();
  const memories = await db.getAllFromIndex(
    "memories",
    "character",
    character.id,
  );
  assert.equal(memories.length, 1);
  assert.equal((await allMessages(session.id)).length, 0);
  const body = chatContext(
    character,
    other,
    memories,
    [],
    "你好",
    DEFAULT_INTERACTION_SETTINGS,
  );
  assert.deepEqual(
    body.state.memories.map((m) => m.value.content),
    ["用户叫阿远"],
  );
  assert.deepEqual(
    chatContext(
      { ...character, id: "other" },
      other,
      memories,
      [],
      "你好",
      DEFAULT_INTERACTION_SETTINGS,
    ).state.memories,
    [],
  );
});
test("multi-turn context restores every assistant line marker without changing visible text", async () => {
  const { character, session } = await setup();
  const expected: string[] = [];
  for (let turn = 0; turn < 4; turn++) {
    const input = `第${turn}轮：\n“[台词]这是用户原文。”`;
    const body = chatContext(
      character,
      session,
      [],
      await allMessages(session.id),
      input,
      DEFAULT_INTERACTION_SETTINGS,
    );
    assert.equal(body.input.text, input);
    assert.deepEqual(
      body.history
        .filter((message) => message.role === "assistant")
        .map((message) => message.text),
      expected,
    );
    assert.deepEqual(
      body.history
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      Array.from(
        { length: turn },
        (_, index) => `第${index}轮：\n“[台词]这是用户原文。”`,
      ),
    );
    const { assistant } = await beginTurn(session.id, input);
    let reply = assistant;
    for (const delta of [
      { kind: "narration" as const, text: `她翻到第${turn}页。\n` },
      { kind: "narration" as const, text: "  指着一行字。\r\n\n" },
      { kind: "dialogue" as const, text: "“看这里。”\n" },
      { kind: "dialogue" as const, text: "下一行（保留括号）。" },
    ])
      reply = appendDelta(reply, delta);
    await checkpoint({
      ...reply,
      status: "complete",
      checkpointVersion: reply.checkpointVersion + 1,
    });
    expected.push(
      `[描写]她翻到第${turn}页。\n[描写]  指着一行字。\n[台词]“看这里。”\n[台词]下一行（保留括号）。`,
    );
    assert.equal(
      plainText(reply),
      `她翻到第${turn}页。\n  指着一行字。\r\n\n\n“看这里。”\n下一行（保留括号）。`,
    );
  }
});
test("interrupted history retains typed content and marks its completion note as narration", async () => {
  const { character, session } = await setup();
  const { assistant } = await beginTurn(session.id, "看看地图");
  await checkpoint({
    ...appendDelta(assistant, { kind: "dialogue", text: "这条路通往" }),
    status: "interrupted",
    checkpointVersion: 2,
  });
  // 下一轮尚未收到正文的占位消息不应进入模型历史。
  await beginTurn(session.id, "继续");
  const body = chatContext(
    character,
    session,
    [],
    await allMessages(session.id),
    "然后呢",
    DEFAULT_INTERACTION_SETTINGS,
  );
  assert.deepEqual(
    body.history
      .filter((message) => message.role === "assistant")
      .map((message) => message.text),
    ["[台词]这条路通往\n[描写]（该回复未完成。）"],
  );
});
test("all uncompressed history retains structure and is no longer blocked by a 20000-character limit", async () => {
  const { character, session } = await setup();
  for (let i = 0; i < 15; i++) {
    const { assistant } = await beginTurn(session.id, `消息${i}`);
    await checkpoint({
      ...assistant,
      status: "complete",
      segments: [{ kind: "dialogue", text: `回复${i}` }],
      checkpointVersion: 1,
    });
  }
  const history = await allMessages(session.id);
  const body = chatContext(
    character,
    session,
    [],
    history,
    "本轮",
    DEFAULT_INTERACTION_SETTINGS,
  );
  assert.equal(body.history.length, 30);
  assert.match(body.history[0].text, /消息0/);
  assert.match(body.history[1].text, /\[台词\]回复0/);
  assert.equal(body.summary.throughSeq, 0);
  assert.equal(body.input.text, "本轮");
  const long = history.map((message) =>
    message.role === "user" ? { ...message, text: "a".repeat(4000) } : message,
  );
  assert.equal(
    chatContext(
      character,
      session,
      [],
      long,
      "本轮",
      DEFAULT_INTERACTION_SETTINGS,
    ).history.length,
    30,
  );
});
test("backup roundtrip preserves structured messages and invalid import leaves data intact", async () => {
  const { character, session } = await setup();
  await putMemory(character.id, session.id, {
    content: "用户叫阿远",
    scope: "character",
    kind: "fact",
    epistemicStatus: "established",
    status: "active",
  });
  const { assistant } = await beginTurn(session.id, "你好");
  await checkpoint(
    appendDelta(assistant, { kind: "dialogue", text: "“欢迎”" }),
  );
  const backup = await takeSnapshot();
  const validated = validateBackup(structuredClone(backup));
  assert.equal(
    validated.data.messages.find((message) => message.id === assistant.id)
      ?.status,
    "interrupted",
  );
  await restoreSnapshot(validated);
  const restored = await takeSnapshot();
  assert.deepEqual(restored.data, validated.data);
  const bad = structuredClone(backup);
  bad.data.sessions[0].characterId = "missing";
  await assert.rejects(() => restoreSnapshot(bad), /不存在的角色/);
  assert.deepEqual((await takeSnapshot()).data, restored.data);
});
test("interaction settings validate all combinations and are snapshotted into requests", async () => {
  assert.deepEqual(DEFAULT_INTERACTION_SETTINGS, {
    replyLength: "standard",
    narrativeMode: "scene",
  });
  const { character, session } = await setup();
  for (const replyLength of ["short", "standard", "detailed"] as const) {
    for (const narrativeMode of ["interactive", "scene"] as const) {
      const settings = parseInteractionSettings({ replyLength, narrativeMode });
      const body = chatContext(
        character,
        session,
        [],
        [],
        "看看地图",
        settings,
      );
      assert.deepEqual(body.interactionSettings, settings);
      settings.replyLength = replyLength === "short" ? "detailed" : "short";
      assert.equal(body.interactionSettings.replyLength, replyLength);
    }
  }
  for (const invalid of [
    null,
    [],
    "short",
    {},
    { replyLength: "standard" },
    { replyLength: "SHORT", narrativeMode: "scene" },
    { replyLength: "standard", narrativeMode: "auto" },
    { replyLength: null, narrativeMode: "scene" },
  ]) {
    assert.throws(() => parseInteractionSettings(invalid), /设置无效/);
  }
});

test("queued settings changes merge, survive backup import, and reset on clear", async () => {
  await Promise.all([
    updateInteractionSettings({ replyLength: "detailed" }),
    updateInteractionSettings({ narrativeMode: "interactive" }),
  ]);
  const expected = { replyLength: "detailed", narrativeMode: "interactive" };
  assert.deepEqual(useAppStore.getState().interactionSettings, expected);
  const saved = await (await database()).get("settings", "interactionSettings");
  assert.deepEqual(JSON.parse(saved!.value), expected);
  const backup = await takeSnapshot();
  await clearData();
  assert.deepEqual(
    useAppStore.getState().interactionSettings,
    DEFAULT_INTERACTION_SETTINGS,
  );
  await importBackup(backup);
  assert.deepEqual(useAppStore.getState().interactionSettings, expected);
});

test("主题色随备份恢复，清空后回到青绿，拒绝无效备份主题色", async () => {
  await changeThemeColor("violet");
  const backup = await takeSnapshot();
  await clearData();
  assert.equal(useAppStore.getState().themeColor, "teal");
  await importBackup(validateBackup(backup));
  assert.equal(useAppStore.getState().themeColor, "violet");
  const invalid = structuredClone(backup);
  invalid.data.settings.find((setting) => setting.key === "themeColor")!.value =
    "unknown";
  assert.throws(() => validateBackup(invalid), /主题色设置无效/);
  assert.equal(
    (await (await database()).get("settings", "themeColor"))!.value,
    "violet",
  );
  const previous = structuredClone(backup);
  previous.data.settings = previous.data.settings.filter(
    (setting) => setting.key !== "themeColor",
  );
  await importBackup(validateBackup(previous));
  assert.equal(useAppStore.getState().themeColor, "teal");
});

test("invalid interaction settings in backups are rejected without replacing current data", async () => {
  await setting(
    "interactionSettings",
    JSON.stringify(DEFAULT_INTERACTION_SETTINGS),
  );
  const backup = await takeSnapshot();
  for (const value of [
    "not-json",
    "null",
    "{}",
    '{"replyLength":"standard","narrativeMode":"auto"}',
  ]) {
    const invalid = structuredClone(backup);
    invalid.data.settings.find(
      (item) => item.key === "interactionSettings",
    )!.value = value;
    await assert.rejects(() => restoreSnapshot(invalid), /交互设置无效/);
    assert.deepEqual((await takeSnapshot()).data, backup.data);
  }
});

test("sending waits for an already queued settings save", async () => {
  const { character, session } = await setup();
  useAppStore.setState({
    characterId: character.id,
    sessionId: session.id,
    characters: [character],
    sessions: [session],
  });
  const originalFetch = globalThis.fetch;
  let sentSettings: unknown;
  globalThis.fetch = async (_input, init) => {
    const fixture = contextFixture(String(_input), init);
    if (fixture) return fixture;
    if (String(_input).endsWith("/ack")) return Response.json({});
    const request = JSON.parse(String(init?.body));
    sentSettings = request.context.interactionSettings;
    return dispatchResponse(request);
  };
  try {
    const saving = updateInteractionSettings({ replyLength: "detailed" });
    const sending = sendMessage("我把地图递给她，让她看看");
    await Promise.all([saving, sending]);
    assert.deepEqual(sentSettings, {
      replyLength: "detailed",
      narrativeMode: "scene",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed settings saves keep the last committed choice", async () => {
  await updateInteractionSettings({ replyLength: "short" });
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "settings")
      throw new DOMException("storage full", "QuotaExceededError");
    return put.apply(this, args);
  };
  try {
    await assert.rejects(
      () => updateInteractionSettings({ replyLength: "detailed" }),
      /storage full/,
    );
    assert.equal(
      useAppStore.getState().interactionSettings.replyLength,
      "short",
    );
    const saved = await (
      await database()
    ).get("settings", "interactionSettings");
    assert.equal(JSON.parse(saved!.value).replyLength, "short");
  } finally {
    IDBObjectStore.prototype.put = put;
  }
});

test("SSE parser handles split CRLF, comments, multiple events and multiline data", () => {
  const events: { name: string; data: string }[] = [];
  const parser = new SSEParser((event) => events.push(event));
  for (const character of ': ping\r\nevent: delta\r\ndata: {"kind":"dialogue",\r\ndata: "text":"你好"}\r\n\r\nevent: done\ndata: {"finishReason":"stop","usage":{"status":"reported","inputTokens":100,"outputTokens":20,"totalTokens":120}}\n\n')
    parser.feed(character);
  assert.equal(events.length, 2);
  assert.equal(JSON.parse(events[0].data).text, "你好");
  assert.equal(events[1].name, "done");
});

test("角色照片入口拒绝旧编号、前导零和尾随换行", () => {
  for (const appearancePhotoAssetId of [
    "00000000-0000-4000-8000-000000000001",
    "img0",
    "img01",
    "img1\n",
    "img1\r",
    "img1\u2028",
  ]) {
    assert.throws(
      () =>
        parseCharacterProfile({
          ...EMPTY_PROFILE,
          name: "林溪",
          appearancePhotoAssetId,
        }),
      /图片编号无效/,
    );
  }
});
