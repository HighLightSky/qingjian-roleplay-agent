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
} from "../lib/db";
import {
  EMPTY_PROFILE,
  appendDelta,
  plainText,
  titleFrom,
  visibleCharacters,
} from "../lib/domain";
import { chatContext } from "../lib/chat/context";
import { SSEParser, streamChat } from "../lib/chat/sse";
import { restoreSnapshot, takeSnapshot, validateBackup } from "../lib/backup";

beforeEach(async () => {
  const db = await database();
  const tx = db.transaction(TABLES, "readwrite");
  await Promise.all(TABLES.map((table) => tx.objectStore(table).clear()));
  await tx.done;
});
async function setup() {
  const character = await saveCharacter({
    ...EMPTY_PROFILE,
    name: "林溪",
    description: "旅馆老板",
    openingScene: "（她看向门口。）",
  });
  const session = await createSession(character.id);
  return { character, session };
}
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
  const first = (await allMessages(session.id))[2];
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
  assert.equal(earlier.messages.length + latest.messages.length, 61);
  assert.equal(earlier.hasEarlier, false);
});
test("memories belong to characters and survive session deletion", async () => {
  const { character, session } = await setup();
  await putMemory(character.id, "用户叫阿远");
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
  const body = chatContext(character, other, memories, [], "你好");
  assert.deepEqual(body.memories, ["用户叫阿远"]);
  assert.deepEqual(
    chatContext({ ...character, id: "other" }, other, memories, [], "你好")
      .memories,
    [],
  );
});
test("older history is included as raw context, not silently dropped by the 20-message backend cap", async () => {
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
  const body = chatContext(character, session, [], history, "本轮");
  assert.equal(body.history.length, 20);
  assert.match(body.summary, /消息0/);
  assert.equal(body.input.text, "本轮");
  const long = history.map((message) =>
    message.role === "user" ? { ...message, text: "a".repeat(4000) } : message,
  );
  assert.throws(
    () => chatContext(character, session, [], long, "本轮"),
    /整理剧情/,
  );
});
test("backup roundtrip preserves structured messages and invalid import leaves data intact", async () => {
  const { character, session } = await setup();
  await putMemory(character.id, "用户叫阿远");
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
test("SSE parser handles split CRLF, comments, multiple events and multiline data", () => {
  const events: { name: string; data: string }[] = [];
  const parser = new SSEParser((event) => events.push(event));
  for (const character of ': ping\r\nevent: delta\r\ndata: {"kind":"dialogue",\r\ndata: "text":"你好"}\r\n\r\nevent: done\ndata: {"finishReason":"stop"}\n\n')
    parser.feed(character);
  assert.equal(events.length, 2);
  assert.equal(JSON.parse(events[0].data).text, "你好");
  assert.equal(events[1].name, "done");
});
test("streaming decodes split UTF-8 and requires a terminal done event", async () => {
  const original = globalThis.fetch;
  try {
    const run = async (text: string) => {
      const bytes = new TextEncoder().encode(text);
      globalThis.fetch = async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      const parts: string[] = [];
      const reason = await streamChat(
        {},
        new AbortController().signal,
        (delta) => parts.push(delta.text),
      );
      return { reason, parts };
    };
    assert.deepEqual(
      await run(
        'event: delta\ndata: {"kind":"dialogue","text":"你好🌱"}\n\nevent: done\ndata: {"finishReason":"stop"}\n\n',
      ),
      { reason: "stop", parts: ["你好🌱"] },
    );
    await assert.rejects(
      () => run('event: delta\ndata: {"kind":"narration","text":"未完成"}\n\n'),
      /连接中断/,
    );
    await assert.rejects(
      () => run('event: delta\ndata: {"kind":"html","text":"错误类型"}\n\n'),
      /段落格式/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
