"use client";

import { useState } from "react";
import { ArrowDownIcon, ArrowRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const steps = [
  {
    title: "准备上下文",
    owner: "浏览器 → ContextController",
    detail:
      "从 IndexedDB 读取角色、剧情、记忆、目标、摘要和未摘要历史。先做预算预检，必要时调用压缩接口并提交摘要，再查询缓存、补传生成所需原图；压缩自身需要读取的原图会在压缩前补传。",
    event: "POST /api/context/budget · /api/context/compact",
  },
  {
    title: "接收任务",
    owner: "ChatController → ChatDispatchService.start",
    detail:
      "前端提供 runId 和本轮消息元数据。编排入口校验上下文及引用，检查结果容量，取得全局模型名额并固定图片。相同 runId 已存在时直接订阅已有任务。",
    event: "POST /api/chat → snapshot",
  },
  {
    title: "选择原图",
    owner: "VisualSelectionService.select",
    detail:
      "本轮附件与首次无观察角色照片属于必选图。模型只从可选目录挑选需要重读的历史图；目录为空时省去选图调用。目录过大时按 token 分批，再合并与最终选择。",
    event: "stage: selection → committed",
  },
  {
    title: "流式正文",
    owner: "ChatService.chatStream",
    detail:
      "按实际图片组装模型请求并复核预算。OpenAiClient 读取上游 SSE，SegmentStreamParser 将文本变成台词／描写增量，任务缓存正文并向订阅者广播。",
    event: "context → delta… → body_done",
  },
  {
    title: "整理本轮",
    owner: "StateUpdateService.update",
    detail:
      "仅 stop 且非空的正文触发整理。整理器读本轮双方消息，提出剧情、记忆、目标与视觉观察变更，同时生成简短画面提示词和参考建议。服务端还原短编号并校验来源、权限、证据和完整性。",
    event: "stage: state_update → state_result",
  },
  {
    title: "提交与确认",
    owner: "浏览器事务 → ChatDispatchService.acknowledge",
    detail:
      "浏览器校验会话、记忆、来源等版本后，在同一事务提交状态变更和画面草稿，保存全部终态才发送 ACK。任务结束时释放模型与图片租约；ACK 删除后台结果。事务失败时保留句柄，可再次取回同一结果。",
    event: "done → POST /api/chat/{runId}/ack",
  },
] as const;

export function RequestJourney() {
  const [selected, setSelected] = useState(0);
  const step = steps[selected];
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border bg-card">
      <div
        role="tablist"
        aria-label="请求执行步骤"
        className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-3"
      >
        {steps.map((item, index) => (
          <button
            key={item.title}
            id={`journey-tab-${index}`}
            role="tab"
            aria-selected={selected === index}
            aria-controls="journey-panel"
            tabIndex={selected === index ? 0 : -1}
            onClick={() => setSelected(index)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % steps.length
                  : event.key === "ArrowLeft"
                    ? (index + steps.length - 1) % steps.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? steps.length - 1
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              setSelected(next);
              document.getElementById(`journey-tab-${next}`)!.focus();
            }}
            className={cn(
              "flex min-h-14 items-center gap-2 bg-card px-3 py-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              selected === index
                ? "bg-sidebar-accent text-primary"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            <span className="font-mono text-xs">0{index + 1}</span>
            {item.title}
          </button>
        ))}
      </div>
      <div
        id="journey-panel"
        role="tabpanel"
        aria-labelledby={`journey-tab-${selected}`}
        tabIndex={0}
        className="p-5 sm:p-6"
      >
        <p className="mb-3 break-words font-mono text-xs leading-6 text-primary">
          {step.owner}
        </p>
        <p className="text-sm leading-7">{step.detail}</p>
        <p className="mt-4 break-words rounded-md bg-muted px-3 py-2 font-mono text-xs leading-6 text-muted-foreground">
          {step.event}
        </p>
      </div>
    </div>
  );
}

export function OwnershipDiagram() {
  const nodes = [
    {
      name: "浏览器",
      role: "长期数据与最终提交",
      items: "IndexedDB · 原始消息 · 角色与状态 · 图片原件",
    },
    {
      name: "Java 后端",
      role: "校验、编排与临时资源",
      items: "任务与 SSE · 提示词 · 预算 · 结果与原图内存缓存",
    },
    {
      name: "模型服务",
      role: "推理与结构化提议",
      items: "正文生成 · 选图 · 整理 · 摘要 · 模板与 token 计数",
    },
  ];
  return (
    <figure
      className="not-prose my-6"
      aria-label="浏览器、Java 后端与模型服务的职责关系"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        {nodes.map((node, index) => (
          <div key={node.name} className="contents">
            {index > 0 && (
              <div className="flex items-center justify-center text-muted-foreground">
                <ArrowDownIcon className="size-4 sm:hidden" />
                <ArrowRightIcon className="hidden size-4 sm:block" />
              </div>
            )}
            <div className="min-w-0 flex-1 rounded-lg border bg-card p-4">
              <p className="mb-2 text-base font-medium">{node.name}</p>
              <p className="mb-3 text-xs text-primary">{node.role}</p>
              <p className="text-xs leading-6 text-muted-foreground">
                {node.items}
              </p>
            </div>
          </div>
        ))}
      </div>
      <figcaption className="mt-3 text-xs leading-6 text-muted-foreground">
        请求携带完整上下文；响应返回正文与变更。后端内存中的任务和图片都有明确期限。
      </figcaption>
    </figure>
  );
}
