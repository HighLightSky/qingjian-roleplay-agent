# AI 角色聊天系统：前后端开发计划

> 本文是开发计划，不代表当前代码已经实现。它替代原设计文档中“命令行 + 临时工作区 + 缓存包导入导出”的运行方式，改为**浏览器前端 + 无状态 Spring Boot 后端**。
>
> 定位：个人学习项目、本机单用户。优先保证结构清楚、代码量小，不做企业级的鉴权、并发控制、自动重试和兜底。
>
> 两个核心体验：
>
> 1. 角色回复**流式输出**，边生成边显示。
> 2. 回复区分**台词**和**描写**，由模型按约定格式输出，前端用不同样式渲染。

---

## 1. 最终形态与关键决策

```text
┌──────────────────────────── 浏览器 ────────────────────────────┐
│  Next.js + assistant-ui                                        │
│                                                                │
│  页面 / 组件        Zustand            IndexedDB（唯一长期存储） │
│  角色/会话/聊天  ←→  当前会话状态  ←→  characters / sessions     │
│  记忆/图片/备份                        messages / memories /    │
│                                        images                  │
└───────────────────────────┬────────────────────────────────────┘
                            │ POST /api/chat
                            │   → SSE：delta / done / error
                            │ POST /api/summary（非流式）
┌───────────────────────────▼────────────────────────────────────┐
│  Spring Boot（无数据库、无文件、无跨请求状态）                    │
│  Controller → PromptBuilder → LLMClient(stream)                │
│       ↑                                                        │
│  StreamSegmentParser：把模型标记文本切成台词/描写                 │
└────────────────────────────────────────────────────────────────┘
```

核心原则：**浏览器是唯一的数据所有者，后端每次请求临时接收上下文，处理完即丢。**

| 决策 | 选择 | 原因 |
| --- | --- | --- |
| 数据长期存储 | IndexedDB | 满足“只在前端浏览器存储” |
| 服务端状态 | 完全不保存 | 不需要工作区、临时文件、过期清理 |
| 角色/会话/记忆管理 | 前端完成 | 数据本来就在浏览器 |
| 后端职责 | 组装提示词、调用模型、切分输出 | 业务规则集中在一处 |
| 聊天方式 | `POST` + SSE 流式响应 | 角色回复逐段出现 |
| 回复结构 | 模型按行输出 `[台词]` / `[描写]` | 前端能稳定区分两种渲染 |
| 图片 | 每轮随请求内嵌 base64 | 不需要上传接口和图片存储 |
| 历史压缩 | 独立 `/api/summary` | 与聊天解耦，前端决定何时触发 |
| 备份 | 单个 JSON 文件 | 不引入 zip 库，实现简单 |
| 登录/鉴权 | 不做 | 本机单用户学习项目 |

### 相对原设计文档的简化

原文档为命令行设计，以下内容在本计划中直接删除：

- 临时工作区、`runtimeId`、`X-Runtime-Id`、空闲过期与定时清理。
- 服务端 `state.json`、图片目录、`.zip` 缓存包、导入解压安全校验。
- `RuntimeService`、`RuntimeCache`、`ImageService`（服务端保存图片）。
- `/api/runtimes/**`、`/api/images/**`、角色/会话 CRUD 接口。
- 命令行 `App` 与 `ConversationContext`。

保留并强化的部分：角色快照、三层记忆（最近消息 + 摘要 + 重要记忆）、图文输入、统一的提示词和回复规则、流式输出与结构化台词/描写。

---

## 2. 第一版实现哪些功能

### 2.1 功能清单

| 模块 | 功能 | 说明 |
| --- | --- | --- |
| 角色 | 新建、查看、编辑 | 名称、身份背景、性格、说话风格、世界观、开场场景 |
| 会话 | 新建、列表、切换、删除 | 一个会话绑定一个角色；删除会话时级联删除消息、记忆、图片 |
| 聊天 | 多轮对话 | 显示历史、发送文字、流式接收回复 |
| 流式 | 逐段显示 | 收到一段就渲染一段，不等待完整回复 |
| 回复结构 | 台词 / 描写分段 | 模型带标记输出，后端切成段，前端分别渲染 |
| 开场 | 自动写入开场场景 | 新建会话时把 `openingScene` 作为第一条角色消息 |
| 记忆 | 手动新增、查看、删除 | 属于当前会话，随每次聊天发送 |
| 摘要 | 自动压缩较早历史 | 超过阈值后调用 `/api/summary` 更新，失败则下次再试 |
| 图片 | 单张图片输入与展示 | 仅当前轮发送给模型；历史消息只保留文字占位 |
| 备份 | 导出/导入全部数据 | JSON，覆盖式导入 |
| 隐私 | 数据只存浏览器 | 后端不建库、不落盘、不记录请求正文 |

### 2.2 明确不做

- 登录、多用户、权限、分享链接。
- 服务端保存角色、会话、消息、记忆或图片。
- 流式断点续传、断线重连、生成中途刷新恢复。
- 消息编辑、重新生成、分支切换、点赞点踩。
- 语音输入/输出、图片生成、向量检索、多 Agent。
- 跨会话全局记忆、多个角色同场对话。
- 加密存储、数据擦除承诺、审计日志。

assistant-ui 自带的编辑、重新生成、分支、反馈按钮需要从界面移除或隐藏，只保留复制、发送和停止。

### 2.3 用户主要流程

```text
首次打开
  → 新建角色（填写资料）
  → 新建会话（选择角色，自动显示开场场景）
  → 输入文字或附加图片
  → 角色回复按台词/描写逐段出现
  → 随时查看/新增/删除重要记忆
  → 可导出备份；重新打开浏览器后数据仍在
```

---

## 3. 整体数据流

### 3.1 一次聊天

```text
1. 用户在输入框发送文字/图片
2. assistant-ui onNew 收到 AppendMessage
3. 前端把用户消息写入 IndexedDB，并立即显示
4. 前端从 IndexedDB 读取：
     当前会话的角色快照、全部重要记忆、摘要、最近 20 条消息
5. POST /api/chat，响应为 text/event-stream
6. 后端拼 system prompt + 历史 + 本轮输入，调用模型的流式接口
7. 模型返回带 [台词]/[描写] 标记的文本
8. 后端边解析边发送 SSE：
     event: delta  { kind: "dialogue" | "narration", text: "..." }
9. 前端把 delta 合并进“正在生成的回复”，实时渲染
10. 收到 done 后，把完整回复写入 IndexedDB
11. 前端检查是否需要生成摘要；需要则调用 POST /api/summary
```

约定：

- 历史消息只发送最近 20 条（约 10 轮）；更早的内容依靠摘要。
- 历史消息中的图片不重发，文字为空时由前端替换为 `（用户发送了一张图片）`。
- 只有本轮输入可以带图片。
- 流式过程中不逐字写 IndexedDB，只在完成、取消或出错时保存一次。

### 3.2 一次摘要更新

```text
会话中“尚未摘要”的消息达到 30 条
  → 取其中较早的部分（保留最近 20 条不压缩）
  → POST /api/summary { characterName, existingSummary, history }
  → 返回 { summary }
  → 前端更新 session.summary 和 session.summaryThroughMessageId
```

- 摘要失败不影响聊天，旧摘要继续使用，下一轮再尝试。
- 摘要由模型生成，可能遗漏细节；重要事实应手动加入“重要记忆”。
- 原始消息一直保留在 IndexedDB，只是不再全部发给模型。

---

## 4. 前端设计

### 4.1 技术栈与新增依赖

已确定：Next.js 16 App Router、React 19、TypeScript、Tailwind CSS 4、assistant-ui、Zustand、Radix/shadcn 组件。

新增一个依赖：

```bash
npm install idb
```

`idb` 只是 IndexedDB 的 Promise 包装，避免手写大量回调。

### 4.2 页面结构

第一版只做一个页面 `/`，用侧边栏 + 对话框完成管理，减少路由和页面间状态同步。

```text
/（app/page.tsx）
┌──────────────────────┬─────────────────────────────────────────┐
│ 侧边栏                │ 聊天区                                   │
│                      │                                         │
│ [新建会话]            │  当前会话的角色名 / 标题                  │
│                      │                                         │
│ 角色                  │  assistant-ui Thread                    │
│  - 林溪  [编辑]       │  台词：醒目、带强调边                     │
│  - 其他角色           │  描写：次要颜色、斜体                     │
│                      │  用户消息：普通气泡 + 图片                 │
│ 会话                  │                                         │
│  - 林溪：旅馆初遇      │  Composer：文字 + 图片 + 发送/停止         │
│  - 林溪：废塔探险      │                                         │
│                      │                                         │
│ [重要记忆] [备份]      │                                         │
│ [新建角色]            │                                         │
└──────────────────────┴─────────────────────────────────────────┘
```

对话框：

| 对话框 | 作用 |
| --- | --- |
| `CharacterFormDialog` | 新建/编辑角色资料 |
| `NewSessionDialog` | 选择角色、填写标题（可默认“角色名：新故事”） |
| `MemoryDialog` | 当前会话的重要记忆列表、新增、删除 |
| `BackupDialog` | 导出 JSON、导入 JSON、清空本地数据 |
| 确认框 | 删除会话、覆盖导入 |

### 4.3 组件与文件划分

```text
frontend/
  app/
    layout.tsx                    # 只保留全局样式，不再包 MyRuntimeProvider
    page.tsx                      # 应用外壳：侧边栏 + 聊天区
  components/
    layout/AppSidebar.tsx
    chat/ChatPanel.tsx            # 角色/会话标题 + Thread
    chat/ChatRuntimeProvider.tsx  # useExternalStoreRuntime + 流式状态
    chat/SegmentParts.tsx         # DialoguePart / NarrationPart
    characters/CharacterFormDialog.tsx
    sessions/NewSessionDialog.tsx
    memory/MemoryDialog.tsx
    backup/BackupDialog.tsx
  stores/
    useAppStore.ts                # Zustand，当前页面状态
  lib/
    types.ts                      # 数据模型
    db.ts                         # IndexedDB 读写
    api.ts                        # fetch /api/chat（SSE）、/api/summary
    sse.ts                        # SSE 文本流解析
    messages.ts                   # DB 消息 ↔ ThreadMessageLike
    backup.ts                     # 导出/导入 JSON
    config.ts                     # 前端常量：窗口大小、阈值、限制
```

删除现有 `app/MyRuntimeProvider.tsx` 中的假回复示例。`thread.aui.tsx` 保留主体，但删除不使用的功能入口。

### 4.4 assistant-ui 接入

使用外部存储 runtime，把 IndexedDB 中的消息作为唯一数据源。

```tsx
const runtime = useExternalStoreRuntime<ThreadMessageLike>({
  messages,
  isRunning,
  convertMessage: (m) => m,
  onNew,
  onCancel,
  adapters: {
    attachments: new SimpleImageAttachmentAdapter(),
  },
});
```

关键点：

1. **消息映射**：`lib/messages.ts` 把数据库消息转成 `ThreadMessageLike`。助手消息按段转换为 `data-*` 部件：

   ```ts
   {
     id: message.id,
     role: message.role,
     createdAt: new Date(message.createdAt),
     status: toStatus(message),
     content: message.segments
       ? message.segments.map((s) => ({
           type: s.kind === "dialogue" ? "data-dialogue" : "data-narration",
           data: { text: s.text },
         }))
       : [
           ...(message.text ? [{ type: "text", text: message.text }] : []),
           ...images.map((img) => ({ type: "image", image: img.dataUrl })),
         ],
   }
   ```

   `data-xxx` 部件会被 assistant-ui 转换为名为 `xxx` 的 `data` 部件，渲染时走注册的数据渲染器。

2. **区分渲染**：在 `ChatRuntimeProvider` 内注册两个数据渲染器：

   ```tsx
   useAssistantDataUI({ name: "dialogue", render: DialoguePart });
   useAssistantDataUI({ name: "narration", render: NarrationPart });
   ```

   主题组件里的 `case "data": return part.dataRendererUI;` 会自动使用它们，不需要重写整个消息渲染。

3. **附件**：`SimpleImageAttachmentAdapter` 负责选择、预览和把图片转成 data URL；`onNew` 中从 `message.content` 里取出 `type === "image"` 的部分。

4. **发送**：`onNew` 立即保存用户消息，然后开始流式请求；请求期间 `isRunning = true`。

5. **流式更新**：每收到一个 `delta`，更新 Zustand 中的 `streamingMessage`，`messages` 属性随之变化，界面实时刷新。保持消息 `id` 稳定，只追加正文，不重建整条历史。

6. **结束**：收到 `done` 后将 `streamingMessage` 写入 IndexedDB，并从“流式草稿”切换为正式消息（沿用同一个 `id`）。

7. **停止**：`onCancel` 调用 `AbortController.abort()`；已经收到的部分内容保存为不完整消息（`finishReason = "cancelled"`），不自动补全或重试。

8. **会话切换**：给 `ChatRuntimeProvider` 加 `key={currentSession.id}`，切换会话时重建 runtime，避免旧分支、滚动位置和流式状态残留。

9. **失败**：请求或流式解析失败时，若已经收到正文，保存部分回复并显示错误；若一个字都没收到，不创建助手消息。用户消息保留，可以重新发送。

10. **界面裁剪**：
    - 删除 `Suggestions` 示例和英文欢迎语，改为中文引导。
    - 删除重新生成、编辑、分支、点赞/点踩、语音按钮。
    - 保留复制、附件、发送和停止。

### 4.5 台词与描写的渲染

模型输出约定：

| 类型 | 模型输出示例 | 前端渲染 |
| --- | --- | --- |
| 台词 | `[台词]“你也发现这座塔了？”` | 正常字号、强调色、左侧竖线或轻微背景 |
| 描写 | `[描写]（她挪开烛台，为地图腾出位置。）` | 次要颜色、斜体，块间距略小 |

渲染组件示例：

```tsx
const DialoguePart: DataMessagePartComponent<{ text: string }> = ({ data }) => (
  <p className="border-primary/40 text-foreground mt-3 border-l-2 pl-3 text-[15px] leading-7">
    {data.text}
  </p>
);

const NarrationPart: DataMessagePartComponent<{ text: string }> = ({ data }) => (
  <p className="text-muted-foreground mt-2 text-sm leading-6 italic">
    {data.text}
  </p>
);
```

约定：

- 第一版按纯文本渲染，不启用 Markdown，避免标记和 Markdown 语法互相干扰。
- 台词保留引号，描写保留括号；前端只负责样式，不再重新改写内容。
- 同一类型连续出现时，可以在合并 delta 阶段合成一段，避免碎片化。
- 模型偶尔不按格式输出时，后端按“描写”处理并保留原文，不丢内容；不做更复杂的自动猜分。

### 4.6 流式状态管理

Zustand 在原有状态上增加：

```ts
type AppState = {
  characters: Character[];
  sessions: Session[];
  currentSessionId: string | null;
  messages: Message[];
  memories: Memory[];
  isRunning: boolean;
  streamingMessage: Message | null;

  loadAll(): Promise<void>;
  createCharacter(input: CharacterProfile): Promise<void>;
  updateCharacter(id: string, input: CharacterProfile): Promise<void>;
  createSession(characterId: string, title: string): Promise<void>;
  selectSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  addMemory(content: string): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  sendMessage(input: SendInput): Promise<void>;
  cancelStreaming(): void;
};
```

发送流程：

```ts
async function sendMessage(input: SendInput) {
  const userMessage = buildUserMessage(input);
  await db.putMessage(userMessage);
  set((s) => ({ messages: [...s.messages, userMessage] }));

  const assistantId = crypto.randomUUID();
  const draft: Message = {
    id: assistantId,
    sessionId: currentSessionId,
    role: "assistant",
    text: "",
    segments: [],
    imageIds: [],
    createdAt: new Date().toISOString(),
  };

  controller = new AbortController();
  set({ isRunning: true, streamingMessage: draft });

  try {
    await streamChat(payload, {
      signal: controller.signal,
      onDelta(kind, text) {
        set((s) => ({
          streamingMessage: appendSegment(s.streamingMessage!, kind, text),
        }));
      },
      onDone() {
        const finished = finalizeStreamingMessage();
        void db.putMessage(finished);
        set((s) => ({
          messages: [...s.messages, finished],
          streamingMessage: null,
        }));
      },
    });
  } catch (e) {
    // 有部分内容就保存，标为 cancelled/error；否则只显示错误
  } finally {
    set({ isRunning: false, streamingMessage: null });
    void maybeSummarize();
  }
}
```

规则：

- `appendSegment`：如果最后一段类型相同，追加文本；否则新增一段。
- 流式期间 `messages` 传给 runtime 时，末尾追加 `streamingMessage`。
- 流式草稿不写 IndexedDB；结束、取消或出错时写一次。
- 刷新页面时正在生成的回复丢失，已发送的用户消息保留。第一版接受这个边界。

### 4.7 IndexedDB 数据模型

数据库名：`roleplay-agent`，版本 1。

| store | keyPath | 索引 | 记录 |
| --- | --- | --- | --- |
| `characters` | `id` | 无 | 角色资料 |
| `sessions` | `id` | `characterId` | 会话、角色快照、摘要 |
| `messages` | `id` | `sessionId`、`sessionId + createdAt` | 聊天消息 |
| `memories` | `id` | `sessionId` | 重要记忆 |
| `images` | `id` | 无 | 图片 data URL |

TypeScript 模型：

```ts
export type CharacterProfile = {
  name: string;
  description: string;
  personality: string;
  speakingStyle: string;
  worldSetting: string;
  openingScene: string;
};

export type Character = CharacterProfile & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type Session = {
  id: string;
  characterId: string;
  title: string;
  characterSnapshot: CharacterProfile; // 创建时的角色快照
  summary: string;
  summaryThroughMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SegmentKind = "dialogue" | "narration";

export type Segment = {
  kind: SegmentKind;
  text: string;
};

export type Message = {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;                 // 纯文本；助手消息由 segments 拼接得到
  segments?: Segment[];         // 仅助手消息
  imageIds: string[];
  finishReason?: "stop" | "cancelled" | "error";
  createdAt: string;
};

export type Memory = {
  id: string;
  sessionId: string;
  content: string;
  createdAt: string;
};

export type ImageRecord = {
  id: string;
  mimeType: string;
  name: string;
  dataUrl: string;
  createdAt: string;
};
```

约定：

- 所有 ID 使用 `crypto.randomUUID()`。
- 时间使用 `new Date().toISOString()`。
- 会话创建时复制一份 `characterSnapshot`；之后修改角色不影响已有会话。
- 开场场景在创建会话时写入一条 `role = "assistant"` 的消息；它没有 `segments`，按普通文本渲染。
- 助手消息同时保存 `segments`（用于渲染）和 `text`（用于摘要、历史请求和搜索）。
- 第一版每条用户消息最多一张图片。
- 删除会话时，删除其 `messages`、`memories` 以及只被这些消息引用的 `images`。

### 4.8 角色与记忆怎么维护

**角色**

```text
新建角色 → 写入 characters → 更新 Zustand 列表
编辑角色 → 更新 characters 记录
新建会话 → 复制当前角色字段到 session.characterSnapshot
聊天     → 请求携带 characterSnapshot，不再查角色表
```

因此：

- 修改角色只影响之后新建的会话。
- 已有会话“故事中途不会换人设”。
- 角色没有删除功能，避免处理“会话还引用着已删除角色”的情况。

**重要记忆**

- 用户在“重要记忆”对话框中手动新增/删除。
- 记忆属于会话，不跨会话共享。
- 每次聊天把当前会话的全部记忆作为字符串数组发送给后端。
- 删除记忆只删除这条独立记录，不会改写摘要或历史消息。

**摘要**

- 由模型生成，保存在 `sessions.summary`。
- `summaryThroughMessageId` 标记摘要已覆盖到哪条消息。
- 聊天时发送“摘要 + 已覆盖之后的最近 20 条消息”。
- 触发与更新逻辑见 4.9。

### 4.9 上下文与摘要的具体规则

常量放在 `lib/config.ts`：

```ts
export const KEEP_RECENT_MESSAGES = 20;  // 发给模型的最近消息数（约 10 轮）
export const SUMMARY_TRIGGER = 30;       // 未摘要消息达到该数量时压缩
export const MAX_INPUT_CHARS = 2000;     // 单条文字输入上限
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 单张图片 2MB
```

发送聊天请求时：

```ts
const history = messages
  .slice(-KEEP_RECENT_MESSAGES)
  .map((m) => ({
    role: m.role,
    text: m.imageIds.length > 0
      ? `${m.text || ""}（附有一张图片）`.trim()
      : m.text,
  }));

// 当前输入不放进 history，单独作为 input
```

每次成功收到 `done` 后检查摘要：

```ts
const start = summaryThroughMessageId
  ? messages.findIndex((m) => m.id === summaryThroughMessageId) + 1
  : 0;

const uncovered = messages.slice(start);
if (uncovered.length >= SUMMARY_TRIGGER) {
  let cut = messages.length - KEEP_RECENT_MESSAGES;
  while (cut > start && messages[cut]?.role !== "user") cut--;

  if (cut > start) {
    const toSummarize = messages.slice(start, cut);
    const { summary } = await api.summarize({
      characterName: snapshot.name,
      existingSummary: session.summary,
      history: toSummarize.map(toHistory),
    });
    // 保存 summary 与 toSummarize 最后一条消息的 id
  }
}
```

简化点：

- 不追求精确的“轮”，直接按消息条数控制。
- 摘要失败不阻塞聊天，也不弹复杂恢复流程。
- 不做 token 级预算，只限制消息条数、输入长度、图片大小和记忆条数。

### 4.10 流式响应解析

浏览器不能直接用 `EventSource`，因为它只支持 GET，不能携带 JSON 请求体。使用 `fetch` + `ReadableStream`：

```ts
export async function streamChat(
  body: ChatApiRequest,
  handlers: {
    signal: AbortSignal;
    onDelta(kind: SegmentKind, text: string): void;
    onDone(reason: string): void;
  },
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });

  if (!res.ok) throw await toApiError(res);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const raw of events) {
      const event = parseSseEvent(raw); // 解析 event: / data:
      if (event.name === "delta") {
        const { kind, text } = JSON.parse(event.data);
        handlers.onDelta(kind, text);
      } else if (event.name === "done") {
        handlers.onDone(JSON.parse(event.data).finishReason);
      } else if (event.name === "error") {
        throw new Error(JSON.parse(event.data).message);
      }
    }
  }
}
```

要点：

- SSE 事件以空行分隔，网络分块可能把一行或一个事件切开，必须保留 `buffer`。
- `delta` 的 `kind` 只有 `dialogue` / `narration`。
- 兼容 `\r\n` 时先统一替换为 `\n`。
- 不为流式引入第三方 SSE 库。

### 4.11 导入导出

导出文件结构：

```json
{
  "formatVersion": 1,
  "exportedAt": "2026-10-19T10:00:00.000Z",
  "characters": [],
  "sessions": [],
  "messages": [],
  "memories": [],
  "images": [
    {
      "id": "…",
      "mimeType": "image/png",
      "name": "map.png",
      "dataUrl": "data:image/png;base64,…",
      "createdAt": "…"
    }
  ]
}
```

实现方式：

- 导出：`JSON.stringify` 后创建 `Blob`，用临时 `<a download>` 下载，文件名 `roleplay-backup-YYYYMMDD.json`。
- 导入：`<input type="file">` 读取文本，检查 `formatVersion === 1`，确认后清空并覆盖全部 stores。
- 不做合并导入、不做增量同步。
- 消息里的 `segments` 原样导出和导入，避免把台词/描写重新合并成纯文本。
- 图片内嵌 base64，文件会比较大；第一版不引入 zip。
- 由于数据只在浏览器，清除站点数据、无痕模式、换设备都会丢失，备份文件是唯一恢复手段。

---

## 5. 后端设计

### 5.1 工程改造

当前后端是普通 Maven 项目，需要改成 Spring Boot：

1. `pom.xml` 增加 `spring-boot-starter-parent`、`spring-boot-starter-web`，统一 Java 21；删除与 Spring Boot 冲突的旧编译配置。
2. 新建 `com.example.RoleplayApplication`，使用 `@SpringBootApplication`。
3. 删除命令行相关类：`App.java`、`chat/ConversationContext.java`、`AppTest.java`。
4. 保留并扩展 `llm` 包中的 `LLMClient`、`OpenAiClient`、`ChatRequest`、`ChatResponse`、`Message`。
5. 新增 Web、Service、Prompt、Stream、Config 包。

目标结构：

```text
src/main/java/com/example/
  RoleplayApplication.java
  config/
    LlmConfig.java              # 构造 HttpClient 和 LLMClient
    LlmProperties.java          # roleplay.llm.* / roleplay.context.* 配置
  web/
    ChatController.java         # SSE
    SummaryController.java
    ApiExceptionHandler.java
    dto/
      ChatApiRequest.java
      SummaryApiRequest.java
      SummaryApiResponse.java
      CharacterDto.java
      HistoryMessageDto.java
      InputDto.java
      ImageDto.java
      ApiError.java
      SegmentDelta.java         # { kind, text }
  service/
    ChatService.java
    SummaryService.java
    SegmentStreamParser.java    # 模型输出 → 台词/描写
  prompt/
    PromptBuilder.java
  llm/
    LLMClient.java              # 已有，增加 chatStream
    OpenAiClient.java           # 已有，增加流式解析
    model/
      ChatRequest.java          # 已有
      ChatResponse.java         # 已有
      Message.java              # 已有，扩展 content
      ContentPart.java          # 新增
```

命名注意：已有的 `llm.model.ChatRequest` 表示模型请求，Web DTO 使用 `ChatApiRequest` 区分。

### 5.2 接口清单

| 方法 | 路径 | 作用 | 响应 | 是否保存数据 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/chat` | 根据请求中的上下文流式生成角色回复 | `text/event-stream` | 否 |
| `POST` | `/api/summary` | 合并旧摘要与新对话，生成新摘要 | JSON | 否 |
| `GET` | `/api/health` | 探活，方便开发时确认服务启动 | JSON | 否 |

**没有角色、会话、消息、记忆、图片的 CRUD 接口**，因为这些数据由浏览器管理。后端只在请求里接收它们。

### 5.3 `POST /api/chat`：请求

请求体仍是 JSON，与之前业务字段一致：

```json
{
  "character": {
    "name": "林溪",
    "description": "山间旅馆的老板，曾经是探险家",
    "personality": "谨慎、好奇、愿意帮助熟悉的人",
    "speakingStyle": "简短自然，偶尔带一点幽默",
    "worldSetting": "一座被迷雾包围的山城",
    "openingScene": "雨夜，用户走进旅馆"
  },
  "memories": [
    "用户希望被称为阿远",
    "用户与林溪约定第二天去废塔"
  ],
  "summary": "林溪在雨夜接待了阿远，两人发现地图上的红色标记与废塔有关。",
  "history": [
    {
      "role": "assistant",
      "text": "（窗外的雨声渐渐密集。）“欢迎，旅人。”"
    },
    {
      "role": "user",
      "text": "我把地图放到桌上。"
    }
  ],
  "input": {
    "text": "你能看出这个标记是什么意思吗？",
    "image": {
      "dataUrl": "data:image/png;base64,iVBORw0KGgo..."
    }
  }
}
```

字段约定：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `character` | 是 | 会话角色快照 |
| `memories` | 是 | 字符串数组，可为空 |
| `summary` | 是 | 可为空字符串 |
| `history` | 是 | 只含最近消息，`role` 只能是 `user` / `assistant` |
| `input.text` | 否 | 文字 |
| `input.image.dataUrl` | 否 | 单张图片的 data URL |

`text` 和 `image` 不能同时为空。后端最多取 `history` 的最后 `max-history-messages` 条（默认 20），忽略更早内容。

### 5.4 `POST /api/chat`：SSE 响应

成功时返回 `Content-Type: text/event-stream`：

```text
event: delta
data: {"kind":"narration","text":"（林溪抬起头，目光落在地图右上角的红色标记上。"}

event: delta
data: {"kind":"narration","text":"窗外的雨声渐渐密集。）"}

event: delta
data: {"kind":"dialogue","text":"“你也发现这座塔了？"}

event: delta
data: {"kind":"dialogue","text":"我昨天在那里见过同样的符号。”"}

event: delta
data: {"kind":"narration","text":"（她挪开桌上的烛台，为地图腾出位置。）"}

event: done
data: {"finishReason":"stop"}
```

事件定义：

| event | data | 说明 |
| --- | --- | --- |
| `delta` | `{"kind":"dialogue"\|"narration","text":"..."}` | 一段可追加的正文 |
| `done` | `{"finishReason":"stop"\|"length"}` | 生成结束 |
| `error` | `{"code":"MODEL_ERROR","message":"..."}` | 流式过程中出错 |

说明：

- `kind` 由后端的 `SegmentStreamParser` 根据模型输出标记决定。
- 同一类型连续 delta 由前端合并；类型变化时前端新开一段。
- SSE 的 `delta` 可能比模型原始 token 粗一些，因为需要先识别行首标记；识别完成后按模型返回的块转发。
- 停止生成时前端主动断开连接，后端发送失败后结束任务。

### 5.5 模型输出格式与提示词

模型必须按“一行一段”的格式输出，行首标记类型：

```text
[描写]（林溪抬起头，目光落在地图右上角的红色标记上。窗外的雨声渐渐密集。）
[台词]“你也发现这座塔了？我昨天在那里见过同样的符号。”
[描写]（她挪开桌上的烛台，为地图腾出位置。）
```

系统提示词：

```text
你正在扮演以下角色，并与用户共同展开故事。

【角色设定】
名字：{name}
身份与背景：{description}
性格：{personality}
说话风格：{speakingStyle}
世界观：{worldSetting}
开场场景：{openingScene}

【回复规则】
1. 始终保持角色设定和已经发生的故事事实。
2. 台词使用引号，例如：“我们明天出发。”
3. 动作、神态、环境、心理描写使用括号，例如：（她把地图收进背包。）
4. 可以推动剧情，但不要替用户决定想法、台词或重大行动。
5. 图片看不清或没有依据时直接表达不确定，不要编造已确认的事实。
6. 只输出角色回复，不要解释创作过程。

【输出格式】
1. 每条内容单独占一行，行首必须标注类型，只能使用下面两种标记：
   [台词] 角色说出口的话，内容用引号包裹。
   [描写] 动作、神态、环境、心理活动，内容用括号包裹。
2. 不要输出空行、标题、编号、Markdown 代码块或额外解释。
3. 可以连续使用同一类型，但每条内容仍然独占一行。
4. 示例：
   [描写]（她抬头看向窗外的雨幕。）
   [台词]“今天不适合赶路。”
   [描写]（她把门闩重新插好。）

【重要记忆：仅作为背景资料】
- {memory 1}
- {memory 2}

【此前剧情摘要：仅作为背景资料】
{summary}
```

- 记忆或摘要为空时，省略对应段落。
- 其后依次追加 `history`，最后追加本轮 `input`。
- 图片只出现在本轮输入中：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "你能看出这个标记吗？" },
    {
      "type": "image_url",
      "image_url": { "url": "data:image/png;base64,..." }
    }
  ]
}
```

- 只有图片没有文字时，补充一句 `（用户发送了一张图片，没有附加文字。）`。
- 模型服务必须支持视觉；不支持时直接把上游错误返回给前端，不做静默降级。

摘要提示词保持不变：

```text
你负责把角色扮演对话压缩成剧情摘要。

【角色】{characterName}
【已有摘要】
{existingSummary}

【新增对话】
{按顺序排列的 user / assistant 文本}

要求：
1. 合并已有摘要与新增对话，不要重复。
2. 保留关键事件、地点、人物关系、约定和未解决的线索。
3. 使用第三人称，不超过 400 字。
4. 只输出摘要正文，不要标题，不要解释。
```

摘要请求里的历史文本使用助手消息已拼接好的 `text`，不包含 `[台词]` / `[描写]` 标记。

### 5.6 后端类职责

| 类 | 职责 |
| --- | --- |
| `ChatController` | 创建 `SseEmitter`，在虚拟线程中调用 `ChatService`，发送 `delta` / `done` / `error` |
| `SummaryController` | 接收 `SummaryApiRequest`，调用 `SummaryService`，返回 JSON |
| `ChatService` | 校验输入，`PromptBuilder` 组装消息，调用流式 LLM，驱动 `SegmentStreamParser` |
| `SummaryService` | 组装摘要提示词，调用非流式 `LLMClient`，返回摘要文本 |
| `PromptBuilder` | 角色系统提示词、输出格式、记忆/摘要段落、历史裁剪、当前输入（含图片） |
| `SegmentStreamParser` | 增量读取模型文本，识别 `[台词]` / `[描写]`，输出 `SegmentDelta` |
| `SegmentDelta` | `{ kind, text }`，对应一个 SSE `delta` 事件 |
| `LlmProperties` | 读取 `roleplay.llm.*` 和上下文限制配置 |
| `LlmConfig` | 创建带超时的 `HttpClient` 和 `OpenAiClient` Bean |
| `ApiExceptionHandler` | 处理流式开始前的参数错误、模型错误等 |
| `LLMClient` / `OpenAiClient` | `chat()` 非流式；`chatStream()` 解析上游 SSE 并回调文本 |
| `Message` / `ContentPart` | 纯文本消息或“文本 + 图片”消息 |

一次 `/api/chat` 的调用链：

```text
ChatController（返回 SseEmitter，虚拟线程执行）
  → ChatService.chatStream()
      → PromptBuilder.build()
          → 角色/记忆/摘要/输出格式 → system message
          → history → user/assistant messages
          → input → 最后一条 user message（可能带图片）
      → LLMClient.chatStream()
          → OpenAiClient 请求 stream=true，逐行解析上游 SSE
          → 每个 content delta 回调
      → SegmentStreamParser.feed()
          → 识别 [台词]/[描写]，输出 SegmentDelta
      → controller 写入 SseEmitter
```

### 5.7 SSE 与 `SegmentStreamParser` 实现要点

**Controller**

```java
@PostMapping(value = "/api/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter chat(@RequestBody ChatApiRequest request) {
    SseEmitter emitter = new SseEmitter(timeoutMillis);
    Thread.ofVirtual().start(() -> {
        try {
            String finish = chatService.chatStream(request, delta ->
                    emitter.send(SseEmitter.event().name("delta").data(delta)));
            emitter.send(SseEmitter.event().name("done")
                    .data(Map.of("finishReason", finish)));
            emitter.complete();
        } catch (Exception e) {
            try {
                emitter.send(SseEmitter.event().name("error").data(toApiError(e)));
            } catch (IOException ignored) {
                // 客户端已断开
            }
            emitter.complete();
        }
    });
    return emitter;
}
```

- 每个请求一个虚拟线程，不维护线程池。
- 客户端断开时 `send` 抛 `IOException`，直接结束该任务。
- 响应头加 `Cache-Control: no-store`；如果经过 nginx 等代理，关闭代理缓冲（例如 `X-Accel-Buffering: no`）。
- Next.js 的 rewrite 通常能透传 SSE；如果发现被缓冲，改为浏览器直接请求后端并开启 CORS。

**`OpenAiClient.chatStream`**

- 请求体设置 `"stream": true`。
- 用 `HttpResponse.BodyHandlers.ofInputStream()`，按行读取。
- 只处理以 `data:` 开头的行；跳过空行和 `[DONE]`。
- 解析 `choices[0].delta.content`，非空时回调。
- 记录 `choices[0].finish_reason`，结束时返回。
- 上游非 2xx 时读取错误体并抛出模型异常。
- 设置连接和读取超时。

**`SegmentStreamParser`**

职责：把连续的模型文本增量转换成“带类型的文本增量”。

识别规则：

- 行首（允许前置空白）为 `[台词]` → `dialogue`，去掉标记。
- 行首为 `[描写]` → `narration`，去掉标记。
- 其他行 → `narration`，保留原文；如果以 `“` 开头也视为 `dialogue`。
- 一行只有标记或空白时不输出空段。

流式解析要点：

- 维护当前行是否已识别类型、当前偏移和类型。
- 标记可能被网络分块切开（例如先收到 `[台`），此时先缓存，等足够字符再判断。
- 类型确定后，把该行剩余内容按收到的块转发；遇到换行后重置状态，准备下一行。
- 流结束时 flush 缓冲区。
- 不确定或不符合格式的内容一律按描写输出，优先保证“不丢字”。

伪代码：

```text
feed(chunk):
  for each char in chunk:
    if kind == null:
      prefix += char
      if prefix is a prefix of "[台词]" or "[描写]": continue
      classify prefix -> kind, strip marker, emit remaining
    else:
      if char == '\n': emit("\n", kind); reset
      else: buffer += char
  flush buffer as delta(kind)

finish():
  flush remaining buffer
```

输出示例：

```json
{"kind":"narration","text":"（她抬起头。）"}
{"kind":"dialogue","text":"“你来了。”"}
```

### 5.8 模型适配改造

现有 `Message.content` 是 `String`，需要支持多模态：

```java
public final class Message {
    private final String role;
    private final Object content; // String 或 List<ContentPart>
    // 两个构造器：纯文本、多段内容
}

public sealed interface ContentPart permits TextPart, ImagePart {}
public record TextPart(String text) implements ContentPart {}
public record ImagePart(String dataUrl) implements ContentPart {}
```

`OpenAiClient` 序列化时：

- `content` 是 `String`：保持原样；
- `content` 是列表：输出 `text` / `image_url` 数组。

`LLMClient` 增加：

```java
String chatStream(ChatRequest request, Consumer<String> onTextDelta)
        throws IOException, InterruptedException;
```

- `chatStream` 返回 `finishReason`，文本增量通过回调交给上层。
- 现有 `chat()` 保留给 `/api/summary` 使用。
- 温度默认 0.8，最大输出 token 默认 800，全部放在配置中。
- 上游空 `choices`、无文本内容、非 2xx 都抛异常，由 Controller 转为 `error` 事件。

### 5.9 配置与跨域

`application.yml`：

```yaml
server:
  port: 8080

roleplay:
  llm:
    base-url: ${LLM_BASE_URL:https://api.example.com/v1/chat/completions}
    api-key: ${LLM_API_KEY}
    model: ${LLM_MODEL:qwen-vl-max}
    temperature: 0.8
    max-tokens: 800
    timeout-seconds: 120
  context:
    max-history-messages: 20
    max-input-chars: 2000
    max-memory-items: 50
```

- 密钥只放环境变量，不进代码、不进前端、写入 `.gitignore`。
- 前端通过 Next.js rewrite 访问后端，浏览器请求同源 `/api/*`，不需要 CORS：

```ts
// next.config.ts
const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8080/api/:path*",
      },
    ];
  },
};
```

### 5.10 错误格式

流式开始前的错误返回普通 JSON：

```json
{
  "code": "MODEL_ERROR",
  "message": "模型服务调用失败，请稍后重试。"
}
```

流式开始后的错误通过 `error` 事件发送：

```text
event: error
data: {"code":"MODEL_ERROR","message":"模型服务调用失败，请稍后重试。"}
```

第一版只需要三种错误码：

| HTTP / 事件 | code | 场景 |
| --- | --- | --- |
| `400` | `BAD_REQUEST` | 文字和图片同时为空、历史格式错误、输入过长 |
| `502` / `error` | `MODEL_ERROR` | 模型返回错误、响应无法解析 |
| `504` / `error` | `MODEL_TIMEOUT` | 模型请求超时 |

不为此引入复杂错误码体系，也不自动重试。

---

## 6. 数据如何做到只在前端浏览器存储

### 6.1 存储责任划分

| 数据 | 生成方 | 长期存放 | 后端是否保存 | 每次请求是否发送 |
| --- | --- | --- | --- | --- |
| 角色 | 前端 | IndexedDB `characters` | 否 | 当前会话的角色快照 |
| 会话 | 前端 | IndexedDB `sessions` | 否 | 只发送会话内上下文，不发送会话元数据 |
| 消息 | 前端 | IndexedDB `messages` | 否 | 最近 20 条作为 `history` |
| 台词/描写分段 | 后端流式生成、前端保存 | IndexedDB `messages.segments` | 否 | 作为普通历史文本发送 |
| 重要记忆 | 前端 | IndexedDB `memories` | 否 | 当前会话全部记忆 |
| 摘要 | 后端生成、前端保存 | IndexedDB `sessions.summary` | 否 | 作为 `summary` 发送 |
| 图片 | 前端 | IndexedDB `images` | 否 | 只有当前输入图片发送 |
| 模型密钥 | 后端配置 | 环境变量 | 是（配置，不是用户数据） | 不发送给浏览器 |

### 6.2 后端“零存储”的具体含义

- 不引入数据库。
- 不创建临时工作区或图片目录。
- 不在内存里维护跨请求的会话 Map。
- 流式请求只在当前线程的回调和 SSE 连接中持有数据，结束后释放。
- 不记录请求正文、回复正文和图片内容。默认 Spring 日志不会打印请求体；不要开启 Web 请求体的 DEBUG 日志。
- 后端重启不丢任何用户数据，因为后端本来就没有用户数据。

### 6.3 浏览器存储的边界

- IndexedDB 按“浏览器 + 站点来源”隔离。换浏览器、换设备、换端口都看不到原数据。
- 清除站点数据、无痕模式关闭、浏览器配置清理都会导致数据丢失。
- 同机同一浏览器配置文件下的其他用户或扩展理论上可以读取这些数据；第一版不做加密。
- 图片以 base64 字符串存放，会明显增加占用；接近浏览器配额时会写入失败，界面提示用户导出备份或删除会话。
- 唯一可靠的迁移和恢复方式是导出 JSON 备份。

### 6.4 数据离开浏览器的路径

“只在前端存储”不等于数据不离开浏览器：

- 每轮聊天会把角色设定、记忆、摘要、最近消息和当前图片发送给后端。
- 后端会把必要内容发送给配置的模型服务。
- 模型服务是否留存请求，由模型服务的部署方决定，本系统无法保证。

因此准确表述是：**应用自身长期保存用户数据的位置只有浏览器；后端和模型服务只在处理请求时临时接触数据。**

---

## 7. 开发边界条件

### 7.1 运行环境假设

- 本机开发：前端 `http://localhost:3000`，后端 `http://localhost:8080`。
- 单用户、单浏览器、单后端实例。
- 后端不暴露到公网；没有鉴权，任何能访问 `localhost:8080` 的本地程序都可以调用。
- 必须能访问所配置的 OpenAI 兼容模型服务。
- 模型服务需要支持流式响应；图片功能还需要支持视觉。

### 7.2 输入与容量限制

| 项目 | 限制 | 处理方式 |
| --- | --- | --- |
| 单条文字 | 2000 字符 | 前端提示，后端返回 `400` |
| 每轮图片 | 1 张 | 附件适配器只接受图片；前端只取第一张 |
| 单张图片 | 2MB | 前端拒绝 |
| 图片格式 | JPEG / PNG / WebP | 由附件适配器 `accept` 限制 |
| 发给模型的历史 | 最近 20 条 | 前端切片，后端再兜底取最后 20 条 |
| 摘要触发 | 未摘要消息 ≥ 30 条 | 压缩到只剩最近 20 条 |
| 重要记忆 | 50 条 | 前端限制，超出提示删除 |
| 摘要长度 | 约 400 字 | 提示词约束，不做硬校验 |
| 会话数量/字符数量 | 不限制 | 依赖浏览器配额 |
| 单次流式响应 | 120 秒 | 超时后发送 `error` 并结束 |

### 7.3 失败处理原则

只处理会直接导致数据丢失或用户无法理解的情况，其余保持简单：

| 场景 | 行为 |
| --- | --- |
| 流式开始前请求失败 | 返回 JSON 错误，前端显示，不创建助手消息 |
| 流式中途断开/超时 | 已收到的内容保存为不完整消息，显示错误；不自动续传 |
| 用户点击停止 | 断开请求，保存已收到内容，标记 `cancelled` |
| 摘要失败 | 静默保留旧摘要，下一轮再试，不阻塞聊天 |
| IndexedDB 写入失败 | 提示“保存失败”，不假装成功 |
| 图片超限 | 发送前提示并移除附件 |
| 导入文件版本不对/解析失败 | 提示无效，不修改现有数据 |
| 删除会话 | 二次确认后级联删除 |
| 后端重启 | 无影响，前端数据仍在 |
| 浏览器刷新 | 数据仍在，重新加载当前会话；正在生成的回复丢失 |
| 模型不按 `[台词]`/`[描写]` 格式输出 | 按描写处理并保留原文，不丢内容 |

明确不做的兜底：

- 不自动重试模型请求。
- 不做 SSE 断点续传、断线重连、生成任务恢复。
- 不做请求队列、离线缓存。
- 不做乐观锁、版本冲突合并、多标签页同步。
- 不做导入合并、增量备份。
- 不做 token 级精确裁剪。
- 不做图片压缩或格式转换。
- 不做模型输出格式的纠正重试（例如发现没标记就再请求一次）。
- 不做服务端日志脱敏框架，只保证不主动打印正文。

### 7.4 数据一致性边界

- 角色资料修改不影响已有会话，只影响新建会话。
- 删除重要记忆不会删除历史消息或摘要中的同一事实。
- 删除会话会删除其消息、记忆和图片，不可恢复（除非已有备份）。
- 摘要可能遗漏细节，不承诺完整还原剧情。
- 摘要覆盖位置之后的最近消息始终以原文发送；覆盖位置之前的消息不再发送原文。
- 第一版不支持消息删除、编辑和重新生成，因此摘要标记不会遇到“被覆盖消息被删除”的问题。
- 台词/描写分段是模型输出格式的产物；模型不遵守格式时，分段质量下降，但文本内容不会丢失。

### 7.5 隐私边界

- 不收集统计、不接入第三方分析。
- 模型密钥只存在于后端环境变量。
- 浏览器数据未加密；共享电脑上使用需自行注意。
- 导出文件包含完整对话和图片，交给他人前需自行检查。
- 流式响应经过的中间代理（如果有）应关闭缓冲和缓存，避免正文被临时保存。

---

## 8. 开发顺序与验收

| 步骤 | 完成内容 | 验收方式 |
| --- | --- | --- |
| 1 | Spring Boot 化：删 CLI，加 `/api/health`、`/api/chat` 的 SSE 流式和 `SegmentStreamParser` | `curl -N` 能看到 `delta` 事件不断到达，最后收到 `done`；空输入返回 400 |
| 2 | IndexedDB + 数据层：`types.ts`、`db.ts`、角色和会话的基础读写 | 刷新页面后角色和会话仍在；两个会话消息互不串 |
| 3 | 前端接入流式聊天：替换假 runtime、SSE 解析、台词/描写渲染 | 回复边生成边出现；台词和描写样式不同；停止按钮能终止 |
| 4 | 记忆与摘要：记忆增删、`/api/summary`、上下文窗口 | 新增“用户希望被称为阿远”后下一轮生效；超过阈值后摘要保存到会话 |
| 5 | 图片：附件适配器、data URL 存储、多模态请求、历史占位 | 图文和纯图片都能流式回复；刷新后图片仍显示；换会话不串图 |
| 6 | 导入导出与界面收尾：备份、清空、隐藏无用按钮、中文文案 | 导出后清空数据再导入，角色/会话/消息/记忆/图片/分段全部恢复 |

每一步完成后都可以独立运行，不需要等全部功能齐备。

---

## 9. 需要新增、修改、删除的文件

### 9.1 后端

| 操作 | 文件 |
| --- | --- |
| 修改 | `pom.xml`：加入 Spring Boot parent 和 web starter |
| 新增 | `src/main/java/com/example/RoleplayApplication.java` |
| 删除 | `src/main/java/com/example/App.java` |
| 删除 | `src/main/java/com/example/chat/ConversationContext.java` |
| 删除 | `src/test/java/com/example/AppTest.java` |
| 新增 | `config/LlmConfig.java`、`config/LlmProperties.java` |
| 新增 | `web/ChatController.java`（SSE）、`web/SummaryController.java`、`web/ApiExceptionHandler.java` |
| 新增 | `web/dto/*`：请求/响应记录、`SegmentDelta`、`ApiError` |
| 新增 | `service/ChatService.java`、`service/SummaryService.java`、`service/SegmentStreamParser.java` |
| 新增 | `prompt/PromptBuilder.java` |
| 修改 | `llm/LLMClient.java`：增加 `chatStream` |
| 修改 | `llm/OpenAiClient.java`：上游流式 SSE 解析、多模态内容、超时、错误信息 |
| 修改 | `llm/model/Message.java`：支持文本或内容段列表 |
| 新增 | `llm/model/ContentPart.java` |

### 9.2 前端

| 操作 | 文件 |
| --- | --- |
| 删除 | `app/MyRuntimeProvider.tsx` |
| 修改 | `app/layout.tsx`：移除全局 runtime provider |
| 重写 | `app/page.tsx`：侧边栏 + 聊天区 |
| 新增 | `components/layout/AppSidebar.tsx` |
| 新增 | `components/chat/ChatPanel.tsx`、`components/chat/ChatRuntimeProvider.tsx` |
| 新增 | `components/chat/SegmentParts.tsx`：`DialoguePart`、`NarrationPart` |
| 新增 | `components/characters/CharacterFormDialog.tsx` |
| 新增 | `components/sessions/NewSessionDialog.tsx` |
| 新增 | `components/memory/MemoryDialog.tsx` |
| 新增 | `components/backup/BackupDialog.tsx` |
| 新增 | `stores/useAppStore.ts` |
| 新增 | `lib/types.ts`、`lib/db.ts`、`lib/api.ts`、`lib/sse.ts`、`lib/messages.ts`、`lib/backup.ts`、`lib/config.ts` |
| 修改 | `components/assistant-ui/elements/thread.aui.tsx`：移除编辑/重新生成/分支/反馈/语音入口，中文欢迎语；`data` 部件渲染继续使用 `dataRendererUI` |
| 修改 | `next.config.ts`：增加 `/api` rewrite |

---

## 10. 以后再考虑（不在第一版）

- 生成中断后的恢复与重新生成。
- 更精细的段落格式（例如内心独白、场景切换）和对应样式。
- 用向量检索代替“最近消息 + 摘要”。
- 角色卡导入格式、多个角色同场。
- 多个备份合并、云端同步。
- 图片压缩、多图、图片生成。
- 服务端加入用户和鉴权。

这些都应建立在第一版跑通之后，不提前预留抽象层。
