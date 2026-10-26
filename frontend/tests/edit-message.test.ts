import "fake-indexeddb/auto";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  database,
  TABLES,
  saveCharacter,
  createSession,
  beginTurn,
  allMessages,
} from "../lib/db";
import {
  beginEditDraft,
  discardEditDraft,
  replaceFailedTurn,
} from "../lib/chat/edit";
import { takeSnapshot, restoreSnapshot, validateBackup } from "../lib/backup";
import { IMAGE_SEQUENCE_KEY } from "../lib/images/ids";
import { now } from "../lib/domain";
import { contextFixture } from "./context-fixture";
import { dispatchResponse } from "./dispatch-fixture";
import { sendMessage, useAppStore } from "../stores/use-app-store";

beforeEach(async () => {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  for (const table of TABLES) await tx.objectStore(table).clear();
  await tx.objectStore("settings").put({ key: IMAGE_SEQUENCE_KEY, value: "0" });
  await tx.done;
  useAppStore.setState({
    readOnly: false,
    activeSessionId: null,
    editDraft: null,
    editSubmitting: false,
    messages: [],
    operations: [],
    busy: false,
  });
});

async function setup() {
  const character = await saveCharacter({
    name: "林溪",
    identity: "",
    description: "",
  });
  const session = await createSession(character.id);
  const turn = await beginTurn(session.id, "原消息");
  await (
    await database()
  ).put("messages", {
    ...turn.assistant,
    status: "error",
    error: "模型失败",
    reasoning: {
      text: "旧的思考",
      status: "error",
      startedAt: 1000,
      endedAt: 2000,
    },
  });
  await (
    await database()
  ).put("drafts", {
    sessionId: session.id,
    text: "下一轮草稿",
    updatedAt: now(),
  });
  return { character, ...turn };
}

test("失败轮编辑草稿、取消与备份恢复均保留普通草稿和原消息", async () => {
  const { session, user } = await setup();
  const edit = await beginEditDraft(session.id, user.id);
  assert.equal(edit.text, "原消息");
  const db = await database();
  const draft = (await db.get("drafts", session.id))!;
  await db.put("drafts", { ...draft, edit: { ...edit, text: "编辑草稿" } });
  const snapshot = await takeSnapshot();
  await restoreSnapshot(snapshot);
  assert.equal((await db.get("drafts", session.id))!.edit!.text, "编辑草稿");
  await discardEditDraft(session.id, user.id);
  assert.equal((await db.get("drafts", session.id))!.text, "下一轮草稿");
  assert.equal((await db.get("drafts", session.id))!.edit, undefined);
  assert.equal((await db.get("messages", user.id))!.text, "原消息");
});

test("重发事务只替换最近失败轮，清除旧尝试并保留历史压缩与人工剧情", async () => {
  const { session, user, assistant } = await setup();
  const db = await database();
  await beginEditDraft(session.id, user.id);
  await db.put("sessions", {
    ...session,
    story: { ...session.story, location: "人工地点" },
    stateVersion: 2,
  });
  for (const [id, kind, status] of [
    ["selection", "selection", "failed"],
    ["compact", "compaction", "committed"],
  ] as const)
    await db.put("operations", {
      id,
      kind,
      status,
      sessionId: session.id,
      runId: assistant.id,
      anchorMessageId: assistant.id,
      placement: "before",
      createdAt: now(),
      updatedAt: now(),
    });
  const result = await replaceFailedTurn(session.id, user.id, "修改后的输入");
  assert.equal(result.user.id, user.id);
  assert.equal(result.assistant.id, assistant.id);
  assert.equal(result.user.seq, user.seq);
  assert.equal(result.user.checkpointVersion, user.checkpointVersion + 1);
  assert.equal(result.assistant.status, "pending");
  assert.deepEqual(result.assistant.segments, []);
  assert.equal(result.assistant.reasoning, undefined);
  assert.equal((await allMessages(session.id)).length, 2);
  assert.equal((await db.get("drafts", session.id))!.text, "下一轮草稿");
  assert.equal(
    (await db.get("sessions", session.id))!.story.location,
    "人工地点",
  );
  assert.equal(await db.get("operations", "selection"), undefined);
  assert.ok(await db.get("operations", "compact"));
});

test("拒绝成功轮、非最近轮、未处理后台任务和版本冲突，失败不改变原数据", async () => {
  const { session, user, assistant } = await setup();
  const db = await database();
  await db.put("messages", { ...assistant, status: "complete" });
  await assert.rejects(beginEditDraft(session.id, user.id), /最近一轮/);
  await db.put("messages", { ...assistant, status: "error" });
  await db.put("settings", {
    key: "dispatch:run",
    value: JSON.stringify({ sessionId: session.id }),
  });
  await assert.rejects(beginEditDraft(session.id, user.id), /后台任务/);
  await db.delete("settings", "dispatch:run");
  await beginEditDraft(session.id, user.id);
  await db.put("messages", {
    ...assistant,
    status: "error",
    checkpointVersion: 2,
  });
  await assert.rejects(
    replaceFailedTurn(session.id, user.id, "新输入"),
    /原消息已变化/,
  );
  assert.equal((await db.get("messages", user.id))!.text, "原消息");
  const snapshot = await takeSnapshot();
  assert.throws(() => validateBackup(snapshot), /编辑草稿/);
  await discardEditDraft(session.id, user.id);
  await beginTurn(session.id, "下一轮");
  await assert.rejects(
    replaceFailedTurn(session.id, user.id, "修改旧轮"),
    /最近一轮/,
  );
});

test("编辑重发的模型上下文排除旧轮，生成失败仍可再次编辑，普通草稿保留", async () => {
  const { session, character, user } = await setup();
  useAppStore.setState({
    sessionId: session.id,
    characterId: character.id,
    characters: [character],
    sessions: [session],
    messages: await allMessages(session.id),
  });
  const original = globalThis.fetch;
  let request: any;
  let fail = true;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const context = contextFixture(path, init);
    if (context) return context;
    if (path === "/api/chat") {
      request = JSON.parse(String(init!.body));
      if (fail) return Response.json({ message: "模型失败" }, { status: 502 });
      return dispatchResponse(request);
    }
    if (path.endsWith("/ack")) return Response.json({});
    throw new Error(`测试未配置接口：${path}`);
  };
  try {
    await beginEditDraft(session.id, user.id);
    await sendMessage("第一次修改", undefined, user.id);
    assert.equal((await allMessages(session.id))[1].status, "error");
    await beginEditDraft(session.id, user.id);
    fail = false;
    await sendMessage("第二次修改", undefined, user.id);
    assert.equal(request.context.input.text, "第二次修改");
    assert.deepEqual(request.context.history, []);
    assert.equal((await allMessages(session.id)).length, 2);
    assert.equal(
      (await (await database()).get("drafts", session.id))!.text,
      "下一轮草稿",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("原位重发写入失败时整笔回滚，编辑草稿和原回复均可继续使用", async () => {
  const { session, user } = await setup();
  await beginEditDraft(session.id, user.id);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    if (this.name === "messages" && value.role === "assistant")
      throw new Error("测试事务失败");
    return key === undefined
      ? put.call(this, value)
      : put.call(this, value, key);
  };
  try {
    await assert.rejects(
      replaceFailedTurn(session.id, user.id, "修改消息"),
      /测试事务失败/,
    );
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  assert.equal((await allMessages(session.id))[0].text, "原消息");
  assert.equal((await allMessages(session.id))[1].status, "error");
  const draft = (await (await database()).get("drafts", session.id))!;
  assert.equal(draft.edit!.userMessageId, user.id);
  assert.equal(draft.text, "下一轮草稿");
  await replaceFailedTurn(session.id, user.id, "修改消息");
});
