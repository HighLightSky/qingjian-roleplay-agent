// 源自 https://github.com/assistant-ui/assistant-ui 的 standalone ContextDisplay Ring（MIT）。
"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  createContext,
  useContext,
  useState,
  type FC,
  type ReactNode,
} from "react";

import {
  getBarColor,
  getContextSegments,
  getPercentColor,
  getStrokeColor,
  type TokenUsage,
} from "../utils/context-usage";
import {
  ContextDisplayContext,
  useContextDisplay,
  useContextDisplayState,
} from "../utils/context-display-state";
import { formatTokenCount } from "../utils/tokens";

export type { TokenUsage } from "../utils/context-usage";

const TouchContext = createContext<() => void>(() => {});

export type PresetProps = {
  details?: ReactNode;
  modelContextWindow: number;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  usage?: TokenUsage | undefined;
  resetKey?: string | undefined;
};

export type ContextDisplayRootProps = {
  modelContextWindow: number;
  children: ReactNode;
  usage?: TokenUsage | undefined;
  resetKey?: string | undefined;
};

function ContextDisplayRoot({
  modelContextWindow,
  children,
  usage,
  resetKey,
}: ContextDisplayRootProps) {
  const { contextValue, hasUsage } = useContextDisplayState(
    usage,
    resetKey,
    modelContextWindow,
  );

  const [open, setOpen] = useState(false);
  if (!hasUsage) return null;

  return (
    <ContextDisplayContext.Provider value={contextValue}>
      <TooltipProvider>
        <TouchContext.Provider value={() => setOpen((value) => !value)}>
          <Tooltip open={open} onOpenChange={setOpen}>
            {children}
          </Tooltip>
        </TouchContext.Provider>
      </TooltipProvider>
    </ContextDisplayContext.Provider>
  );
}
function ContextDisplayTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<"button">) {
  const toggleTouch = useContext(TouchContext);
  return (
    <TooltipTrigger asChild>
      <button
        type="button"
        data-slot="context-display-trigger"
        className={cn(
          "inline-flex items-center rounded-md transition-colors",
          className,
        )}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") {
            event.preventDefault();
            toggleTouch();
          }
        }}
        {...props}
      >
        {children}
      </button>
    </TooltipTrigger>
  );
}

function ContextDisplayContent({
  side = "top",
  className,
  details,
}: {
  details?: ReactNode;
  side?: "top" | "bottom" | "left" | "right" | undefined;
  className?: string;
}) {
  const { usage, totalTokens, percent, modelContextWindow } =
    useContextDisplay();
  const segments = getContextSegments(usage);

  return (
    <TooltipContent
      side={side}
      sideOffset={8}
      data-slot="context-display-popover"
      className={cn(
        "bg-popover text-popover-foreground block w-56 border p-3 text-left [&_[data-slot=tooltip-arrow]]:hidden",
        className,
      )}
    >
      <div className="text-xs">
        {details}
        <div className="flex items-baseline justify-between gap-6 whitespace-nowrap">
          <span className={getPercentColor(percent)}>
            {Math.round(percent)}% 已使用
          </span>
          <span className="font-mono tabular-nums">
            {formatTokenCount(Math.min(totalTokens, modelContextWindow))} /{" "}
            {formatTokenCount(modelContextWindow)}
          </span>
        </div>
        <div
          data-slot="context-display-track"
          className="bg-muted inset-ring-border mt-2.5 h-1 overflow-hidden rounded-full inset-ring forced-colors:border"
        >
          <div
            className={cn(
              "h-full w-(--usage-width) rounded-full transition-[width] duration-300 forced-color-adjust-none",
              totalTokens > 0 && "min-w-1",
              getBarColor(percent),
            )}
            style={{ "--usage-width": `${percent}%` } as React.CSSProperties}
          />
        </div>
        {segments.length > 0 && (
          <div className="mt-3 grid gap-1.5">
            {segments.map((segment) => (
              <div
                key={segment.label}
                className="flex items-baseline justify-between gap-6"
              >
                <span className="text-muted-foreground">{segment.label}</span>
                <span className="font-mono tabular-nums">
                  {formatTokenCount(segment.tokens)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </TooltipContent>
  );
}

const RING_SIZE = 18;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function RingVisual() {
  const { percent } = useContextDisplay();

  return (
    <svg
      aria-hidden="true"
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className="-rotate-90"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        className="stroke-border"
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={
          RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE
        }
        className={cn(
          "transition-[stroke-dashoffset,stroke] duration-300",
          getStrokeColor(percent),
        )}
      />
    </svg>
  );
}

function RingPercentLabel() {
  const { percent } = useContextDisplay();
  return <span className="font-mono tabular-nums">{Math.round(percent)}%</span>;
}
const ContextDisplayRing: FC<PresetProps> = ({
  modelContextWindow,
  className,
  side,
  usage,
  resetKey,
  details,
}) => (
  <ContextDisplayRoot
    modelContextWindow={modelContextWindow}
    usage={usage}
    resetKey={resetKey}
  >
    <ContextDisplayTrigger
      className={cn(
        "text-muted-foreground hover:text-foreground gap-1.5 px-1.5 py-1 text-xs",
        className,
      )}
      aria-label="上下文用量"
    >
      <RingVisual />
      <RingPercentLabel />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} details={details} />
  </ContextDisplayRoot>
);

export { ContextDisplayRing };
