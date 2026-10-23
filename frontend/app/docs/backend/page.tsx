import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GuideShell } from "@/components/backend-guide/guide-shell";
import { guideSections } from "@/components/backend-guide/navigation";
import {
  OwnershipDiagram,
  RequestJourney,
} from "@/components/backend-guide/request-journey";

export const metadata: Metadata = {
  title: "Java 后端学习文档 · 青笺",
  description:
    "从青笺当前源码理解 Java、Spring Boot、Agent 编排、上下文管理与类的职责边界。",
};

function Section({
  id,
  children,
}: {
  id: (typeof guideSections)[number]["id"];
  children: ReactNode;
}) {
  const index = guideSections.findIndex((section) => section.id === id);
  const section = guideSections[index];
  return (
    <section id={id} aria-labelledby={`${id}-title`}>
      <p className="guide-eyebrow">
        {String(index + 1).padStart(2, "0")} / {section.caption}
      </p>
      <h2 id={`${id}-title`}>{section.title}</h2>
      {children}
    </section>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div
      className="guide-table"
      role="region"
      aria-label={headers.join("、")}
      tabIndex={0}
    >
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Source({ children }: { children: string }) {
  return (
    <p className="guide-source">
      源码定位 <code>{children}</code>
    </p>
  );
}

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="guide-note">
      <strong>{title}</strong>
      <div>{children}</div>
    </aside>
  );
}

function Code({ title, children }: { title: string; children: string }) {
  return (
    <figure className="guide-code">
      <figcaption>{title}</figcaption>
      <pre>
        <code>{children}</code>
      </pre>
    </figure>
  );
}

export default function BackendGuidePage() {
  return (
    <GuideShell>
      <div className="mb-12 border-b pb-9">
        <p className="guide-eyebrow">青笺 / 后端开发学习文档</p>
        <h1>读懂这个 Java 后端</h1>
        <p className="guide-lead">
          从一条聊天消息出发，理解代码如何组织、模型如何协作，以及每个类为什么停在这里。
        </p>
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span>Java 21</span>
          <span>Spring Boot 3.5</span>
          <span>手写模型编排</span>
          <span>基于当前实现 · 2026.10.23</span>
        </div>
      </div>

      <Section id="overview">
        <p>
          这个项目的 Java
          后端，是一个围绕角色聊天设计的模型任务服务。它接收浏览器提供的业务快照，校验后执行选图、流式正文和本轮状态整理，并把可恢复的结果交还浏览器。
        </p>
        <OwnershipDiagram />
        <p>
          角色、会话、原始消息、剧情、记忆、目标、摘要和图片原件长期保存在浏览器
          IndexedDB。后端持有的任务、未确认结果和图片原图都在进程内存中，重启会丢失。理解这一点，才能看懂为什么
          Java 没有 Repository
          层，为什么整理结果包含版本，以及为什么收到回复以后还需要 ACK。
        </p>
        <Table
          headers={["实际使用", "在项目里的作用"]}
          rows={[
            [
              "Java 21",
              "record、sealed interface、模式匹配 switch、虚拟线程、集合与函数式回调。",
            ],
            [
              "Spring Boot + Spring MVC",
              "依赖注入、配置绑定、HTTP 路由、Filter、异常映射和 SseEmitter。",
            ],
            [
              "JDK HttpClient + Jackson",
              "调用兼容 Chat Completions 的服务、解析上游 SSE、构建 JSON Schema 和领域 DTO。",
            ],
            [
              "JUnit + Spring 测试工具 + 本地 HTTP 夹具",
              "验证协议、流式事件、并发、取消、容量、模型输出与恢复行为。",
            ],
          ]}
        />
        <Note title="先建立正确的学习坐标">
          <p>
            这里最密集的知识是应用编排、协议、并发和资源生命周期。当前代码没有
            JPA /
            MyBatis、后端业务数据库、向量检索或通用工具调用循环；学习这些方向时，需要另外做练习。项目中的
            Agent 行为由 Java 明确控制执行顺序。
          </p>
        </Note>
        <Source>
          pom.xml · src/main/resources/application.yml · frontend/lib/db.ts
        </Source>
      </Section>

      <Section id="java">
        <p>
          把“学过一个语法”变成“知道它解决哪个问题”，可以从下面这些真实落点入手。
        </p>
        <Table
          headers={["知识点", "源码落点", "应该理解到什么程度"]}
          rows={[
            [
              "接口与依赖倒置",
              <code key="llm">LLMClient / LlmConfig</code>,
              "业务服务依赖 chat / chatStream 契约，Spring 注入 OpenAiClient。接口隔离上游传输实现，测试可以替换模型客户端。",
            ],
            [
              "构造器注入与 Bean",
              <code key="di">ChatService / LlmConfig</code>,
              "@Service、@Component 交给容器创建；@Bean 装配 HttpClient、Clock 和 LLMClient。final 字段明确实例成立需要哪些依赖。",
            ],
            [
              "record 与边界归一化",
              <code key="dto">ChatApiRequest / DispatchDtos / StateDtos</code>,
              "record 表达传输值；紧凑构造器统一处理 null 集合。字段引用不可重新赋值，并不自动让内部 List 深度不可变，仍要看实际复制策略。",
            ],
            [
              "sealed 与类型分支",
              <code key="sealed">
                VisualDtos.Source / StateUpdateMaterial.resolve
              </code>,
              "消息图与角色照片用封闭来源类型表达；模式匹配 switch 根据真实类型还原 ID，减少含糊的类型判断。",
            ],
            [
              "泛型与函数式接口",
              <code key="consumer">
                Consumer&lt;SegmentDelta&gt; / Consumer&lt;String&gt;
              </code>,
              "生产者报告发生了什么，回调接收者决定怎么处理。parser::feed 是方法引用，避免解析器依赖 SSE。",
            ],
            [
              "集合与 Stream",
              <code key="stream">
                VisualSelectionService / StateUpdateMaterial
              </code>,
              "Set 做去重与引用集合校验；LinkedHashSet 保留选图顺序；Map 做编号映射；Stream 负责筛选、排序与投影。注意顺序是否影响提示词和结果。",
            ],
            [
              "字符串与增量状态机",
              <code key="parser">SegmentStreamParser</code>,
              "StringBuilder 保存跨 chunk 的半个标记；feed 与 finish 区分持续输入和结束收尾，不能假定网络块等于一行文字。",
            ],
            [
              "异常与中断",
              <code key="errors">
                ApiExceptionHandler / ChatDispatchService
              </code>,
              "非法输入、容量冲突、上游失败各有语义；捕获 InterruptedException 后恢复中断位，让取消信号继续传播。后台异常由任务记录并通过事件传回。",
            ],
            [
              "AutoCloseable 与资源管理",
              <code key="lease">ModelGate.Lease / ImageCache.Lease</code>,
              "把必须配对的 acquire / release、pin / unpin 包进租约。try-with-resources 在成功、失败和取消退出时统一释放。",
            ],
            [
              "并发与内存可见性",
              <code key="concurrency">Task / Subscription / ImageCache</code>,
              "synchronized 保护复合状态；volatile 让线程句柄和关闭标志可见；BlockingQueue 把模型工作线程与网络发送线程隔开。",
            ],
            [
              "Java 21 虚拟线程",
              <code key="virtual">Thread.ofVirtual()</code>,
              "任务与订阅各用虚拟线程执行阻塞流程。线程创建轻量，不代表模型可以无限并发；模型容量由 Semaphore 单独控制。",
            ],
            [
              "时间、调度与生命周期",
              <code key="clock">
                Clock / ScheduledThreadPoolExecutor / @PreDestroy
              </code>,
              "注入 Clock 可确定性测试过期；调度器负责清理与任务截止；容器退出时取消活跃任务并停调度器。",
            ],
          ]}
        />
        <h3>一个回调，隔开三个职责</h3>
        <Code title="ChatService.chatStream 中的实际连接方式">{`SegmentStreamParser parser = new SegmentStreamParser(onDelta);
ChatStreamResult result = llmClient.chatStream(prepared.request(), parser::feed);
parser.finish();`}</Code>
        <p>
          <code>OpenAiClient</code> 只产出文本；<code>SegmentStreamParser</code>{" "}
          把文本变成 <code>SegmentDelta</code>；编排任务提供{" "}
          <code>onDelta</code>
          ，负责缓存和广播。回调的价值在于分开变化原因：上游协议、正文格式、下游分发可以各自修改。
        </p>
        <h3>Spring 单例与请求状态</h3>
        <p>
          <code>ChatService</code>{" "}
          是容器中的共享服务。解析器包含“当前行读到哪里”的状态，因此每次{" "}
          <code>chatStream</code>{" "}
          都新建解析器。若把解析器放进服务成员字段，并发请求就可能相互污染。任务状态属于{" "}
          <code>Task</code>，订阅队列属于 <code>Subscription</code>
          ，整理短编号属于单次 <code>StateUpdateMaterial</code>。
        </p>
        <Source>
          src/main/java/com/example/service/ChatService.java ·
          service/SegmentStreamParser.java · prompt/StateUpdateMaterial.java
        </Source>
      </Section>

      <Section id="layers">
        <p>
          按职责可以把当前代码读成下面几层。它们位于一个 Spring Boot
          应用中；这些是阅读视角，并没有强制的模块隔离。特别是服务层直接使用{" "}
          <code>web.dto</code>，当前协议模型与应用模型存在耦合。
        </p>
        <div className="guide-stack" aria-label="后端分层关系">
          {[
            [
              "01",
              "HTTP 边界",
              "web / web.dto",
              "解析请求、返回 JSON 或 SSE、表达协议",
            ],
            [
              "02",
              "任务编排",
              "ChatDispatchService",
              "持有任务，安排选图 → 正文 → 整理",
            ],
            [
              "03",
              "业务能力",
              "service",
              "选图、正文、整理、预算、压缩与领域校验",
            ],
            ["04", "模型材料", "prompt", "把业务快照投影成提示词和结构约束"],
            [
              "05",
              "外部模型适配",
              "llm / llm.model",
              "序列化请求、发送 HTTP、读上游 SSE",
            ],
          ].map(([index, name, path, description]) => (
            <div key={index} className="guide-stack-row">
              <span>{index}</span>
              <div>
                <strong>{name}</strong>
                <code>{path}</code>
                <p>{description}</p>
              </div>
            </div>
          ))}
        </div>
        <p>
          配置、图片缓存、模型名额和取消机制为这些层提供横向支持。实际依赖中，预算服务也会调用计数接口；不要把上图理解成只能相邻调用的机械规则。
        </p>
        <h3>HTTP 入口：把传输责任收在边缘</h3>
        <Table
          headers={["类", "主要职责"]}
          rows={[
            [
              <code key="c">ChatController</code>,
              "启动／订阅任务，显式取消，确认结果；设置 no-store 和关闭代理缓冲的响应头。",
            ],
            [
              <code key="s">StateController</code>,
              "手动重试最新失败整理的 HTTP 入口，取得模型与图片租约，组装已固定原图的整理请求。最新可重试状态由浏览器协调器管理。",
            ],
            [
              <code key="ctx">ContextController</code>,
              "只读预算预检与独立历史压缩入口；压缩占用 ModelGate，预算计数不占生成名额。",
            ],
            [
              <code key="i">ImageController</code>,
              "查询缺失哈希、上传二进制原图、查询指定哈希的缓存统计、释放指定缓存。",
            ],
            [
              <code key="v">ValidationController</code>,
              "人工编辑角色和状态前，复用服务端规则校验。",
            ],
            [
              <code key="cap">CapabilitiesController</code>,
              "暴露模型图片能力、容量与压缩参数，不返回模型凭据。",
            ],
            [
              <code key="f">RequestSizeFilter / ApiExceptionHandler</code>,
              "限制实际读入请求体；将入口异常映射成状态码与 ApiError，正确处理已失效的异步响应。",
            ],
          ]}
        />
        <Source>src/main/java/com/example/web/</Source>
        <h3>编排与能力：决定顺序，完成单项任务</h3>
        <Table
          headers={["类", "拥有的责任"]}
          rows={[
            [
              <code key="dispatch">ChatDispatchService</code>,
              "维护 runId → Task，管理期限、阶段、快照、订阅、取消、结果容量和 ACK；内部 Task 执行整轮，Subscription 发送事件。",
            ],
            [
              <code key="chat">ChatService</code>,
              "验证聊天入口材料、准备实际正文预算、调用流式模型并解析分段；不管理订阅与会话存档。",
            ],
            [
              <code key="select">VisualSelectionService</code>,
              "从可选历史目录生成选图计划；按 token 分批、合并、严格检查引用和剩余名额，必要时纠错一次。",
            ],
            [
              <code key="state">StateUpdateService</code>,
              "调用整理模型，将提议还原成带 before / value / expectedVersion 的领域变更，验证来源和修改权限。",
            ],
            [
              <code key="budget">
                ContextBudgetService / LlamaTokenCounter
              </code>,
              "前者判断能否容纳、何时需要压缩；后者用部署模板与 tokenizer 计文字 token，按尺寸估算图片 token。",
            ],
            [
              <code key="compact">ContextCompactionService</code>,
              "选择完整轮次的历史批次、生成并校验摘要，返回覆盖游标与来源信息；不删除原始消息。",
            ],
            [
              <code key="aux">AuxiliaryContextService</code>,
              "给选图和整理构造有界背景，按预算裁减模型投影，标记不完整材料，控制纠错材料长度。",
            ],
            [
              <code key="valid">
                ContextValidation / StateValidation / ImageValidationService /
                ImageIds
              </code>,
              "分别处理上下文关联、领域值与来源、视觉引用和图片编号规则；供不同入口共用。",
            ],
            [
              <code key="infra">
                ImageCache / ModelGate / UpstreamCancellation
              </code>,
              "分别管理原图内存与占用、全局一个生成名额、工作线程关联的上游取消句柄。",
            ],
            [
              <code key="exceptions">
                ContextLimits / ContextTooLargeException / DispatchException
              </code>,
              "集中资源常量，表达上下文容量不足和带状态码、错误码的编排失败。",
            ],
          ]}
        />
        <Source>src/main/java/com/example/service/</Source>
        <h3>提示词、协议与适配：把模型接口隔开</h3>
        <Table
          headers={["类或类型", "主要职责"]}
          rows={[
            [
              <code key="builders">
                PromptBuilder / VisualSelectionPromptBuilder /
                StateUpdatePromptBuilder / CompactionPromptBuilder
              </code>,
              "分别构建正文、选图、整理和摘要模型请求。提示词类组织规则和消息，不发送 HTTP。",
            ],
            [
              <code key="material">
                StateUpdateMaterial / StateUpdateResponseSchema
              </code>,
              "前者管理冻结快照到短编号材料的映射及写权限；后者构建整理输出的严格 JSON Schema。选图 schema 由选图提示词构建器生成。",
            ],
            [
              <code key="client">
                LLMClient / OpenAiClient / LlmRequestMapper
              </code>,
              "能力接口、具体 HTTP 实现、共用序列化器。计数与正式生成共用消息、thinking 和 response_format 的映射。",
            ],
            [
              <code key="model">
                ChatRequest / Message / ChatResponse / ChatStreamResult /
                TokenUsage
              </code>,
              "模型适配层使用的请求、内容块、非流式结果、流式终态和用量。它们和浏览器传入的 ChatApiRequest 不是同一种协议。",
            ],
            [
              <code key="records">
                ChatApiRequest / CharacterDto / InputDto / ContentPartDto /
                HistoryMessageDto / InteractionSettingsDto
              </code>,
              "表示一轮聊天的业务输入，保留有序图文、历史消息与交互设置。",
            ],
            [
              <code key="groups">
                DispatchDtos / StateDtos / ContextDtos / VisualDtos /
                SegmentDelta / ApiError
              </code>,
              "分组承载任务事件、领域快照与变更、预算摘要、视觉来源与计划、正文分段和错误。",
            ],
            [
              <code key="config">
                RoleplayApplication / LlmConfig / 各 Properties 类
              </code>,
              "启动应用、装配共享依赖；Llm、Context、Vision、Dispatch、AuxiliaryContext Properties 绑定对应配置并校验部署限制。",
            ],
          ]}
        />
        <Source>
          src/main/java/com/example/prompt/ · llm/ · web/dto/ · config/
        </Source>
      </Section>

      <Section id="flow">
        <p>
          一次点击发送，对应的是一条带前置处理的工作流。点击各步骤，查看交接的对象、负责的类与事件。
        </p>
        <RequestJourney />
        <h3>两条流，分开理解</h3>
        <p>
          上游是 <code>OpenAiClient</code> 消费的模型 SSE，包含文本增量、
          <code>finish_reason</code>、usage 和 <code>[DONE]</code>。下游是{" "}
          <code>ChatDispatchService</code> 提供的业务
          SSE，包含选图、正文、整理和任务终态。Java
          把上游协议翻译成业务事件，浏览器不直接依赖模型响应格式。
        </p>
        <Table
          headers={["业务事件", "含义"]}
          rows={[
            [
              <code key="snapshot">snapshot</code>,
              "首次订阅的完整任务状态；恢复时用快照替换已有正文，不逐条重放旧 chunk。",
            ],
            [
              <code key="stage">stage</code>,
              "selection / body / state_update 的运行、完成、失败或取消状态。",
            ],
            [
              <code key="context">context / delta</code>,
              "实际正文预算，以及台词／描写的增量。",
            ],
            [
              <code key="body_done">body_done</code>,
              "正文模型调用结束原因与 token 用量。收到它仍需判断是否正常且非空。",
            ],
            [
              <code key="state_result">state_result</code>,
              "已完成服务端校验的整理结果，等待浏览器按版本提交。",
            ],
            [
              <code key="done">done</code>,
              "整个任务已终结，附最终快照；成功与失败都需要以实际阶段判断。",
            ],
          ]}
        />
        <h3>断线为什么不用重生成？</h3>
        <p>
          工作线程属于 <code>Task</code>，HTTP 连接只是{" "}
          <code>Subscription</code>。断线仅关闭订阅，模型继续运行。重连{" "}
          <code>{"GET /api/chat/{runId}/events"}</code> 获取快照，再接收递增{" "}
          <code>revision</code>{" "}
          的事件。快照捕获和订阅注册放在同一同步边界内，避免中间漏掉更新。
        </p>
        <p>
          任务中的 <code>committed</code>{" "}
          表示这个阶段已产生并记录结果；长期数据是否已经写入
          IndexedDB，仍由浏览器事务决定。ACK
          要等全部终态保存成功，不能在刚看到正文时提前发送。
        </p>
        <Note title="幂等的实际范围">
          <p>
            只要内存中的同一 runId 仍存在，重复启动会订阅已有任务。ACK
            或到期删除后，这份去重记录也被删除。当前恢复机制是单进程、有期限的；后端重启或结果过期后，前端明确显示不可恢复，保留检查点，不自动重新生成。
          </p>
        </Note>
        <Source>
          src/main/java/com/example/service/ChatDispatchService.java ·
          frontend/lib/chat/dispatch.ts
        </Source>
      </Section>

      <Section id="agents">
        <p>
          这里的 Agent
          开发可以理解为：给一个模型阶段明确目标、限定材料、约束输出，并把不可靠的生成结果转成受业务规则约束的结果。执行顺序由代码决定。
        </p>
        <Table
          headers={["阶段", "模型看到什么", "返回与约束"]}
          rows={[
            [
              "选图",
              "语义背景、图片短编号、来源、已有观察和最近用途。候选选择本身主要读目录文字。",
              "严格 JSON 选图计划，只能引用本次目录；本轮必选原图先排除，历史图数受剩余 slots 约束；thinking=false。",
            ],
            [
              "正文",
              "角色设定、剧情、有效记忆、目标、旧摘要、未摘要历史、本轮输入与实际选定原图。",
              "带 [台词] / [描写] 行首标记的流式文本；保留结束原因与用量；thinking=true。",
            ],
            [
              "本轮整理",
              "有界背景、本轮双方消息、可编辑状态投影和实际送入的原图。",
              "视觉观察与剧情／记忆／目标变更；严格 schema，加领域与来源校验；thinking=true。",
            ],
            [
              "历史压缩",
              "已有摘要、准备覆盖的完整历史轮次，以及需要读取的未观察原图。",
              "带来源的有界摘要；验证图片引用、摘要长度和实际减量；thinking=true。",
            ],
          ]}
        />
        <h3>结构正确，不等于业务正确</h3>
        <p>
          JSON Schema
          约束字段、类型、枚举和允许的引用候选。服务端还要验证：变更对象是否存在、来源是否属于本轮、旧值是否完整提供、模型能否覆盖人工修改、观察是否对应实际原图。即便模型返回了合法
          JSON，也不能直接写入业务状态。
        </p>
        <Code title="StateUpdateService.parseResult 的严格解析选项">{`JsonNode node = mapper.reader()
    .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
    .readTree(content);

ModelResult result = mapper.readerFor(ModelResult.class)
    .with(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
    .readValue(node);`}</Code>
        <p>
          代码块包装、顶层数组、尾随 JSON
          都作为输出协议错误处理，不猜测或拼接成一个看起来可用的对象。选图与整理遇到结构／引用错误时，最多附具体原因纠正一次；网络异常或未正常结束不会走这个纠错循环。
        </p>
        <h3>短编号是模型投影，不是数据库 ID</h3>
        <p>
          <code>StateUpdateMaterial</code> 把记忆、目标、来源消息映射成{" "}
          <code>memN</code>、<code>goalN</code>、<code>msgN</code>。真实
          ID、存储版本等留在冻结快照，模型只输出业务提议。裁减和纠错共用同一映射；解析时按类型严格还原，新增对象由后端生成
          UUID。
        </p>
        <p>
          这样既省 token，也减少模型抄错长 ID 或试图修改存储元数据的机会。
          <code>expectedVersion</code> 从快照取得，不让模型编造。
        </p>
        <h3>更新目标需要有信息价值</h3>
        <p>
          目标允许只更新发生变化的字段。只修改 <code>currentFocus</code>{" "}
          或状态时，旧的 <code>progressSummary</code>{" "}
          保留；若更新进展摘要，则必须提供 <code>progressEvidence</code>，标出
          discovery、decision、outcome 或 correction、本轮来源消息与原文片段。
        </p>
        <p>
          服务端同时检查片段存在于“本次可见材料”和“原始消息”。这能排除历史、摘要或截断标记冒充本轮证据；这段文字是否在语义上足以证明进展，仍由模型判断。验证规则的能力范围要和语义质量区分清楚。
        </p>
        <Source>
          src/main/java/com/example/service/StateUpdateService.java ·
          prompt/StateUpdateMaterial.java ·
          prompt/StateUpdateResponseSchema.java
        </Source>
      </Section>

      <Section id="context">
        <h3>预算算的是实际模型请求</h3>
        <div className="guide-formula">
          输入 token + 当前阶段输出预留 + 安全余量 ≤ 部署窗口
        </div>
        <p>
          <code>LlamaTokenCounter</code> 使用部署的 <code>/apply-template</code>{" "}
          和 <code>/tokenize</code>，把模板开销与生成起始标记也计入。
          <code>LlmRequestMapper</code> 被计数与生成共同使用，thinking 开关与
          schema
          也保持一致。文字可以精确计数，图片按尺寸估算；带图预算明确标记为
          estimated。
        </p>
        <Table
          headers={["当前默认配置", "作用"]}
          rows={[
            [
              "窗口 193,024 / 安全余量 1,024 token",
              "统一约束模型容量，修改部署窗口需要同步服务端配置。",
            ],
            [
              "正文与整理输出 8,192 / 选图 4,096 token",
              "各阶段分别预留输出，不能把输入恰好塞满整个窗口。",
            ],
            [
              "输入占窗口达到 70% 触发压缩；配置目标 50%",
              "前端根据预算协调历史压缩；当前循环处理全部可压缩的较早历史，目标比例没有作为中途停止条件。能否发送仍按完整容量公式判断。",
            ],
            [
              "正文压缩保留最近 10 轮原文 / 摘要最多 4,096 token",
              "较早历史按完整轮次分批摘要，保护近期交互。",
            ],
            [
              "辅助背景最近 4 轮 / 历史 8,192 / 本轮消息 8,192 token",
              "选图和整理使用专用的有界材料，与正文保留轮数是不同用途。",
            ],
            [
              "辅助选图与整理文字输入各 32,768 token",
              "总文字预算包含指令、材料包装和纠错，同时还要满足部署窗口。",
            ],
          ]}
        />
        <p className="text-sm text-muted-foreground">
          这些数值是当前配置的默认值，页面本身是学习文档，不是运行时配置面板。单集合
          10,000 项与请求体 64 MiB 属于资源保护，也不等同于模型 token 容量。
        </p>
        <h3>历史压缩与辅助裁减，产生不同结果</h3>
        <Table
          headers={["机制", "改变什么", "不应该混淆的边界"]}
          rows={[
            [
              "历史压缩",
              "生成新的 HistorySummary 和 throughSeq，浏览器校验版本后保存；下次正文用摘要替代相应历史原文。",
              "原始聊天消息仍在 IndexedDB。摘要是有损投影，只有有效且实际减少输入时才推进覆盖游标。",
            ],
            [
              "辅助材料裁减",
              "临时缩短本次给选图／整理模型的材料，并标记 incompleteSections。",
              "不推进摘要游标、不删除原始数据、不表示被省略事实已经失效。",
            ],
          ]}
        />
        <p>
          <code>ContextCompactionService.selectBatch</code>{" "}
          以完整轮次为单位二分选择可容纳批次。最早一轮也装不下时明确报错。辅助裁减则优先缩短已结束目标、失效记忆、旧摘要和近期背景，再缩短其他材料。
        </p>
        <h3>图片有两种身份，承担两种责任</h3>
        <p>
          <code>imgN</code> 是业务与提示词中的图片编号；SHA-256
          是后端原图缓存的内容键。不同浏览器都叫 img1
          不会混图，相同内容则共享同一份缓存。上传入口验证真实格式、可解码性、字节、像素和哈希，不能只信客户端声明的
          MIME。
        </p>
        <Table
          headers={["缓存规则", "设计目的"]}
          rows={[
            [
              "默认 512 MiB；空闲 30 分钟；上传后绝对 2 小时",
              "容量与时间双重有界。访问可以影响空闲时间，不能无限延长绝对寿命。",
            ],
            [
              "Lease pin / close，容量淘汰只选未占用项",
              "整轮任务持有原图引用。过期但仍占用的图保留至释放，不能被新任务使用。",
            ],
            [
              "手动清理有任一目标占用时整次拒绝",
              "检查与删除在同一同步边界内，避免部分删除或刚检查完又被任务取得。",
            ],
            [
              "默认最多 32 个结果、总额度 64 MiB、保留 2 小时",
              "结果缓存按任务均分额度；满额拒绝新任务，保护尚未确认的结果。",
            ],
            [
              "整轮最多 10 分钟；每次模型调用另有超时",
              "有名额、内存与网络连接的流程必须有退出期限。",
            ],
          ]}
        />
        <h3>缺失原图是协议状态</h3>
        <p>
          历史图片或角色照片原件丢失时，浏览器通过 <code>missingAssets</code>{" "}
          显式声明，保留来源和旧观察。缺图不参与选图、传图名额和图片 token
          估算；材料注明无法复核，摘要必须保留缺失标记，整理不能为其生成新观察。本轮新附件必须有原件；损坏、哈希不符和数据库读取异常仍然报错。
        </p>
        <Source>
          src/main/java/com/example/service/ContextBudgetService.java ·
          ContextCompactionService.java · AuxiliaryContextService.java ·
          ImageCache.java · src/main/resources/application.yml
        </Source>
      </Section>

      <Section id="boundaries">
        <p>
          一个类的边界，取决于它拥有哪种状态、对哪个结果负责、为什么需要变化。不要仅凭“都和聊天有关”把逻辑放到同一个服务里。
        </p>
        <Table
          headers={["边界", "当前如何划分", "混在一起会怎样"]}
          rows={[
            [
              "HTTP 与任务",
              "ChatController 处理连接；ChatDispatchService 持有任务、结果和可替换的订阅。",
              "把工作绑到连接，刷新页面就可能丢失或重复生成。",
            ],
            [
              "整轮与单次正文",
              "Dispatch 串行调能力；ChatService 只生成正文与分段。",
              "正文服务承担选图、恢复、ACK 后会变成难以复用的大类。",
            ],
            [
              "提示词与模型通信",
              "Builder 产出 ChatRequest；Client 负责 HTTP 和上游 SSE。",
              "改一句提示词也牵动传输逻辑，测试必须走网络。",
            ],
            [
              "原始快照与模型投影",
              "快照保存完整业务值；Material / Auxiliary 只构造本次允许看到的材料。",
              "直接改原始对象做裁减，可能破坏后续版本验证或把省略误当删除。",
            ],
            [
              "模型提议与真实写入",
              "StateUpdateService 校验并返回变更；浏览器版本检查后原子提交。",
              "模型的迟到结果可能覆盖用户刚刚进行的人工编辑。",
            ],
            [
              "剧情、记忆、目标与摘要",
              "剧情表示当前场景；记忆保留重要事实与认知状态；目标表示方向、关注点与进展；摘要压缩较早消息。",
              "全部写进摘要会失去结构化更新边界；把每句闲聊写成记忆会累积噪声。",
            ],
            [
              "图片原件、观察与用途",
              "缓存存原始内容；观察是有版本、有来源的有损语义；用途解释为什么重读该图。",
              "把观察当原图事实，就无法表达模糊文字或未确认细节，也不能真正重读。",
            ],
          ]}
        />
        <h3>三道信任边界，各校验自己的问题</h3>
        <ol>
          <li>
            <strong>浏览器请求进入服务端：</strong>
            公共入口调用共享校验，检查必需字段、顺序、版本、归属和资源限制。集合在
            DTO 边界统一处理 null，内层使用已成立的事实。
          </li>
          <li>
            <strong>模型结果回到业务层：</strong>
            模型是另一个不可信来源，需要独立检查结构、引用、证据、可编辑字段与实际图片覆盖。这不是重复检查客户端请求。
          </li>
          <li>
            <strong>计算结果进入 IndexedDB：</strong>
            计算期间数据可能变化，浏览器校验冻结版本、来源和指纹后提交。这解决时间上的竞争，服务端首次校验不能代替它。
          </li>
        </ol>
        <h3>“没看到完整旧值”意味着“不能覆盖”</h3>
        <p>
          辅助材料可能截断目标、记忆或剧情列表。
          <code>StateUpdateMaterial.updatePermissions</code>{" "}
          先从实际提供的材料计算可写字段；服务端再用{" "}
          <code>requireWritableStory</code> 和 <code>requireWritableValue</code>{" "}
          检查旧值完整性。模型未看到完整列表时，无权用一个不完整的新列表替换它。
        </p>
        <p>
          这是一种很实用的边界设计：<strong>读取范围限制了写入权限</strong>
          。提示词会告知模型可写范围，最终授权仍由代码执行。
        </p>
        <Source>
          src/main/java/com/example/prompt/StateUpdateMaterial.java ·
          frontend/lib/state/coordinator.ts ·
          frontend/lib/context/coordinator.ts
        </Source>
      </Section>

      <Section id="patterns">
        <h3>1. 用租约表达“占用期间必须释放”</h3>
        <Code title="ChatDispatchService 工作线程中的资源作用域">{`task.cancellation = UpstreamCancellation.install();
try (permit; images) {
    task.execute(request, images);
} finally {
    UpstreamCancellation.clear();
    task.finish();
}`}</Code>
        <p>
          <code>permit</code> 是模型名额，<code>images</code>{" "}
          是原图占用。整轮持有名额，避免选图和正文之间插入其他生成任务；资源释放和任务终结集中处理，不需要在每个失败分支手动复制清理逻辑。ThreadLocal
          的 remove 同样属于生命周期收尾。
        </p>
        <h3>2. 把“慢客户端”隔在有界队列外</h3>
        <p>
          每个订阅有容量 64 的 <code>ArrayBlockingQueue</code>{" "}
          和独立虚拟发送线程。任务只做非阻塞
          offer；队列满就结束该订阅，模型流程继续。客户端可以重新用快照接入，慢连接不会无限占用事件内存，也不会阻塞模型读流。
        </p>
        <p>
          这是一种“断开后可恢复”的限流选择。当前实现缓存正文快照，恢复不依赖完整事件日志。
        </p>
        <h3>3. 快照与 revision 解决重连重复追加</h3>
        <p>
          快照携带完整正文与
          revision；后续事件按单调递增序号更新。重连先替换正文，再消费新增事件，而不是把快照当
          delta 追加。Task
          用同步锁把状态变更、快照与订阅登记连成明确的一致性边界。
        </p>
        <h3>4. 资源保护与模型容量分开建模</h3>
        <p>
          64 MiB 请求体、10,000
          项集合上限、缓存字节和结果数量限制资源消耗；token
          预算限制模型是否装得下。图片先校验压缩文件体积和解码像素，再按实际模型材料估算
          token。不同限制有不同单位、错误原因与配置位置。
        </p>
        <h3>5. 保留正文，允许整理独立失败</h3>
        <p>
          正文与状态整理分别保存阶段结果。正文成功后整理失败，不把已生成回复伪装成失败正文，也不阻止下一轮。最新失败整理可手动重试，新一轮整理开始后旧待办失效；这避免用迟到的旧整理反复修补新状态。
        </p>
        <h3>6. 用“证据 + 旧值 + 版本”让变更可审查</h3>
        <p>
          <code>Change</code> 同时携带 before、value、expectedVersion、reason
          和来源消息。服务端负责可接受性，浏览器负责提交时机。用户看到的是具体变化及来源，测试也可以验证一个提议为什么被接受或拒绝。
        </p>
        <h3>7. 单一序列化路径，避免预检与实调分叉</h3>
        <p>
          共用 <code>LlmRequestMapper</code>{" "}
          后，模板计数和真实生成都使用相同消息内容、thinking 与
          schema。剥离图片用于文字计数时，也保留这些参数。这比维护两套“差不多一样”的
          JSON 组装逻辑更容易保持正确。
        </p>
        <Source>
          src/main/java/com/example/service/ChatDispatchService.java ·
          ModelGate.java · ImageCache.java · llm/LlmRequestMapper.java
        </Source>
      </Section>

      <Section id="testing">
        <p>
          这个项目适合学习的测试方法，是围绕可观察的入口行为与信任边界构造场景。模型结果可以由本地
          HTTP 夹具控制，不必让每个测试都依赖真实模型。
        </p>
        <Table
          headers={["测试类", "重点观察"]}
          rows={[
            [
              <code key="web">ChatControllerTest</code>,
              "SSE 快照与终态、断线重订阅、取消、ACK、全局名额、结果容量和诊断信息。",
            ],
            [
              <code key="stream">OpenAiClientStreamTest</code>,
              "上游流结束标记、结束原因、usage、读取失败、流式超时和主动关闭。",
            ],
            [
              <code key="parser">SegmentStreamParserTest</code>,
              "把同一回复按不同 chunk 长度切开，仍得到一致分段；行首标记、空白与结束残留。",
            ],
            [
              <code key="aux">
                AuxiliaryAgentsTest / StateUpdateServiceTest
              </code>,
              "短编号还原、材料裁减、只改目标关注点、进展证据、未提供旧值保护、结构纠错与原图保留。",
            ],
            [
              <code key="context">ContextFlowTest</code>,
              "真实模板路径的计数夹具、图片估算、容量公式、完整轮次压缩、摘要无效或无减量不推进游标。",
            ],
            [
              <code key="cache">ImageCacheTest / ImageControllerTest</code>,
              "哈希与解码校验、空闲／绝对过期、引用固定、容量淘汰、并发计量和手动清理原子性。",
            ],
            [
              <code key="prompt">
                PromptBuilderTest / ChatServiceTest / ApiExceptionHandlerTest
              </code>,
              "材料与输出规则、模型调用衔接、入口拒绝无效请求、错误状态码与失效响应处理。",
            ],
          ]}
        />
        <p>
          <code>MutableClock</code> 把“等 30
          分钟过期”变成推进测试时间。流式夹具可以控制什么时候发送
          chunk、何时断开；这类测试验证的是时间与状态关系，比只断言“某个方法被调用”更有价值。
        </p>
        <Code title="在仓库根目录运行后端测试">{`mvn test

# 按问题缩小测试范围
mvn -Dtest=SegmentStreamParserTest test
mvn -Dtest=ContextFlowTest test`}</Code>
        <p>
          默认测试不请求真实模型。<code>VisualSelectionLiveTest</code> 和{" "}
          <code>StateUpdateLiveTest</code> 需要显式设置{" "}
          <code>-Droleplay.live-llm=true</code>
          ，运行环境还需提供支持聊天、模板和计数接口的模型服务。
        </p>
        <h3>定位问题，先问失败属于哪一层</h3>
        <Table
          headers={["现象", "优先排查"]}
          rows={[
            [
              "请求直接返回 JSON 错误",
              "入口校验、Filter、缓存是否缺图、ModelGate 是否忙；从 ApiError.code 和 HTTP 状态开始。",
            ],
            [
              "SSE 已开始，随后某阶段失败",
              "任务快照的阶段与 error、任务 ID 对应的后端日志。后台异常不会再经过 ControllerAdvice。",
            ],
            [
              "stop 但没有有效正文",
              "空白或仅类型标记的输出；代码单独诊断，并阻止本轮整理。",
            ],
            [
              "length 或缺少流结束标记",
              "分别区分模型输出长度停止与连接未完整结束；结合输出上限、实际 usage 和返回字符数判断。",
            ],
            [
              "整理提议合法却没有落库",
              "浏览器提交前的领域版本、来源版本、指纹或事务失败；保留句柄取回同一结果，不重新生成。",
            ],
            [
              "断网后仍在生成",
              "这是连接与任务分离的预期行为。要停止，应调用显式 cancel；它中断工作线程并关闭上游流。",
            ],
          ]}
        />
        <p>
          日志保留阶段、异常类型、结束原因、token
          用量和字符数，避免记录原图与生成全文。上游未报告用量时明确标记
          unavailable，不把未知用量写成零。
        </p>
        <Source>
          src/test/java/com/example/ ·
          src/main/java/com/example/web/ApiExceptionHandler.java ·
          llm/model/TokenUsage.java
        </Source>
      </Section>

      <Section id="reading">
        <p>
          不必按文件树从上读到下。先沿一条成功路径建立整体模型，再追失败分支、资源释放和并发时序。
        </p>
        <ol className="guide-reading">
          <li>
            <strong>读启动与依赖。</strong>从{" "}
            <code>RoleplayApplication → LlmConfig → LLMClient</code> 理解 Spring
            创建了哪些共享对象。画出 ChatService
            的构造依赖，解释为什么依赖接口。
          </li>
          <li>
            <strong>读最短正文链。</strong>按{" "}
            <code>
              ChatController → ChatDispatchService → ChatService → PromptBuilder
              → OpenAiClient → SegmentStreamParser
            </code>{" "}
            追一轮纯文字请求，标出每次数据类型转换。
          </li>
          <li>
            <strong>读任务生命线。</strong>追{" "}
            <code>Task.subscribe / emit / finish</code> 和{" "}
            <code>Subscription</code>
            ，画出“连接断开，任务继续，再次订阅”的时序，解释锁、队列和 revision
            各解决什么问题。
          </li>
          <li>
            <strong>读模型结果的约束。</strong>按{" "}
            <code>
              StateUpdateMaterial → StateUpdatePromptBuilder →
              StateUpdateService.parseResult / changes
            </code>{" "}
            追一个 goal1 的部分更新，观察它如何恢复真实 ID、取得旧值和版本。
          </li>
          <li>
            <strong>读容量与图片。</strong>追{" "}
            <code>ContextBudgetService → LlamaTokenCounter</code>，再读{" "}
            <code>ImageCache.pin / Lease.close</code>。分别列出
            token、原图字节、结果字节、时间和名额的限制。
          </li>
          <li>
            <strong>读客户端提交。</strong>看{" "}
            <code>frontend/lib/chat/dispatch.ts</code> 与 state / context
            coordinator，理解服务端的“结果已计算”和用户数据的“结果已提交”之间如何交接。
          </li>
        </ol>
        <h3>把“看懂”变成“能解释”的练习</h3>
        <Table
          headers={["练习", "完成标准"]}
          rows={[
            [
              "追一次分段",
              "手算 [台 / 词]你好 / 换行 / [描写] 三个 chunk 如何经过 feed；解释为什么只在行首认标记。",
            ],
            [
              "追一次取消",
              "从 cancel 接口追到 worker.interrupt、UpstreamCancellation、try 资源释放与 done，区分请求取消和订阅关闭。",
            ],
            [
              "追一次拒绝更新",
              "找到未完整提供的剧情列表为何不能被覆盖；说明提示词告知与服务端授权分别做了什么。",
            ],
            [
              "追一次版本竞争",
              "设想模型计算期间用户人工修改目标，指出哪里提供 expectedVersion、哪里拒绝迟到提交。",
            ],
            [
              "做一个边界清晰的小改动",
              "例如新增一种正文交互规则：入口枚举与校验、PromptBuilder 规则、前端调用方一起更新，并用行为测试证明模型材料正确。",
            ],
          ]}
        />
        <h3>继续学习时，认识当前实现的适用范围</h3>
        <p>
          当前任务表、模型名额与缓存都在单个 JVM
          中。若要做多实例部署，需要另行设计任务归属、共享结果与全局容量控制。现有{" "}
          <code>LLMClient</code> 抽象了聊天调用，但模板与 token
          计数仍依赖部署提供的两个接口；更换模型服务时也要验证这部分能力。
        </p>
        <p>
          这些是从当前实现能直接看出的约束。学习时可以先把单进程流程中的协议、并发与资源管理掌握扎实，再去补关系数据库、事务、认证授权、分布式任务和检索的专项实践。
        </p>
        <Note title="给自己的一张检查卡">
          <p>
            对每个类，都能回答：输入已经保证了什么？它拥有哪份状态？输出代表计算完成还是提交完成？它可能失败在哪里？谁释放它占用的资源？这五个问题能帮助你在新增功能时继续守住职责边界。
          </p>
        </Note>
      </Section>
      <footer className="mt-12 border-t pt-6 text-xs leading-6 text-muted-foreground">
        本页仅描述当前代码。源码路径以仓库根目录为起点；类名与方法名可直接在编辑器中搜索。维护时请同步核对实际调用链与配置。
      </footer>
    </GuideShell>
  );
}
