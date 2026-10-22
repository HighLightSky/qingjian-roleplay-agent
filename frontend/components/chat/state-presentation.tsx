"use client";

import { useState, type ReactNode } from "react";
import {
  BadgeCheckIcon,
  BookOpenIcon,
  BrainIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  ClockIcon,
  FlagIcon,
  LinkIcon,
  MapPinIcon,
  MessageCircleIcon,
  PauseIcon,
  SearchIcon,
  TriangleAlertIcon,
  UserIcon,
  UsersIcon,
  PackageIcon,
  XIcon,
} from "lucide-react";
import { MemoryChips } from "@/components/assistant-ui/elements/memory-chips";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  GOAL_LABELS,
  type GoalValue,
  type MemoryValue,
  type Story,
} from "@/lib/state/types";
import { cn } from "@/lib/utils";

export const STATE_TABS = [
  { key: "story", label: "剧情", Icon: BookOpenIcon },
  { key: "memory", label: "记忆", Icon: BrainIcon },
  { key: "goal", label: "目标", Icon: FlagIcon },
] as const;

export const STORY_ICONS = {
  location: MapPinIcon,
  storyTime: ClockIcon,
  characterState: UserIcon,
  userState: UserIcon,
  presentCharacters: UsersIcon,
  relationships: LinkIcon,
  items: PackageIcon,
  openThreads: SearchIcon,
};

export function StateTag({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs leading-5 text-primary [overflow-wrap:anywhere]",
        className,
      )}
    >
      {children}
    </span>
  );
}

const EPISTEMIC = {
  established: {
    label: "已确认",
    Icon: BadgeCheckIcon,
    basis: "故事中已确立的事实。",
  },
  claim: {
    label: "陈述",
    Icon: MessageCircleIcon,
    basis: "来自某人的陈述，不代表内容已经证实。",
  },
  hypothesis: {
    label: "推测",
    Icon: CircleHelpIcon,
    basis: "尚未证实的推测，需要后续依据。",
  },
};

function EpistemicMarker({
  status,
}: {
  status: MemoryValue["epistemicStatus"];
}) {
  const [open, setOpen] = useState(false);
  const { label, Icon, basis } = EPISTEMIC[status];
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-epistemic-status={status}
            aria-label={`事实类别：${label}`}
            aria-expanded={open}
            onClick={(event) => {
              event.preventDefault();
              setOpen(true);
            }}
            className={cn(
              "inline-flex min-h-8 items-center gap-1 rounded px-1 text-xs underline decoration-primary/40 underline-offset-4 outline-offset-2 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-primary",
              status === "established"
                ? "text-primary"
                : "text-muted-foreground",
              status === "hypothesis" && "decoration-dotted",
            )}
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent
          showArrow={false}
          className="max-w-60 border bg-popover p-3 text-xs leading-6 text-popover-foreground"
        >
          {basis}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const MEMORY_KINDS = {
  fact: "事实",
  preference: "偏好",
  agreement: "约定",
  event: "关键经历",
};
const MEMORY_STATUSES = {
  active: "有效",
  superseded: "已替代",
  dismissed: "已删除",
};

export function MemoryMeta({ value }: { value: MemoryValue }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <MemoryChips
        chips={[
          { id: "kind", text: MEMORY_KINDS[value.kind], change: "updated" },
          {
            id: "scope",
            text: value.scope === "character" ? "角色共享" : "当前会话",
            change: "existing",
          },
          ...(value.status === "active"
            ? []
            : [
                {
                  id: "status",
                  text: MEMORY_STATUSES[value.status],
                  change: "existing" as const,
                },
              ]),
        ]}
      />
      <EpistemicMarker status={value.epistemicStatus} />
    </div>
  );
}

const GOAL_ICONS = {
  candidate: CircleDashedIcon,
  active: FlagIcon,
  blocked: TriangleAlertIcon,
  paused: PauseIcon,
  completed: CircleCheckIcon,
  abandoned: XIcon,
  dismissed: XIcon,
};

export function GoalStatus({ status }: { status: GoalValue["status"] }) {
  const Icon = GOAL_ICONS[status];
  return (
    <span
      data-goal-status={status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs leading-5 text-primary",
        status === "blocked"
          ? "bg-state-warning-surface text-state-warning"
          : status !== "active" &&
              status !== "completed" &&
              "bg-muted text-muted-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {GOAL_LABELS[status]}
    </span>
  );
}

export function GoalDetails({ value }: { value: GoalValue }) {
  return (
    <dl className="space-y-3 pt-1 text-sm leading-7">
      <div className="border-l-2 border-primary/40 bg-primary/5 px-3 py-2">
        <dt className="text-xs font-medium text-primary">当前关注点</dt>
        <dd className="mt-1 whitespace-pre-wrap">
          {value.currentFocus || "尚未记录"}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">完成过程</dt>
        <dd className="mt-1 whitespace-pre-wrap">
          {value.progressSummary || "尚未记录"}
        </dd>
      </div>
    </dl>
  );
}

export function StoryValue({
  field,
  value,
}: {
  field: keyof Story;
  value: Story[keyof Story];
}) {
  if (Array.isArray(value)) {
    if (!value.length)
      return <span className="text-muted-foreground">尚未记录</span>;
    if (field === "presentCharacters")
      return (
        <MemoryChips
          chips={value.map((text, index) => ({
            id: String(index),
            text,
            change: "updated",
          }))}
        />
      );
    return (
      <ul className="space-y-2">
        {value.map((text, index) => (
          <li key={index} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-3 size-1 shrink-0 rounded-full bg-primary/60"
            />
            <span className="min-w-0 whitespace-pre-wrap">{text}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <span
      className={cn(
        "whitespace-pre-wrap",
        !value && "text-muted-foreground",
        (field === "location" || field === "storyTime") && "font-medium",
      )}
    >
      {value || "尚未记录"}
    </span>
  );
}
