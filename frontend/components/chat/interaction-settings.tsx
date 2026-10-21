"use client";

import { useId, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  NARRATIVE_MODE_OPTIONS,
  REPLY_LENGTH_OPTIONS,
  type InteractionSettings,
} from "@/lib/domain";
import {
  report,
  updateInteractionSettings,
  useAppStore,
} from "@/stores/use-app-store";

function SettingMenu<T extends string>({
  label,
  value,
  options,
  disabled,
  descriptionId,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; description: string }[];
  disabled: boolean;
  descriptionId: string;
  onChange: (value: T) => void;
}) {
  const selected = options.find((option) => option.value === value)!;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`${label}：${selected.label}`}
          aria-describedby={descriptionId}
          title="所有会话共用，下次回复生效"
          className="h-8 gap-1 px-2 text-xs text-muted-foreground"
        >
          {selected.label}
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <DropdownMenu.Label className="px-2 py-1.5 text-xs text-muted-foreground">
            {label}
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => onChange(next as T)}
          >
            {options.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className="relative flex cursor-default select-none items-center gap-3 rounded-sm py-2 pr-3 pl-8 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
              >
                <DropdownMenu.ItemIndicator className="absolute left-2">
                  <CheckIcon className="size-4" />
                </DropdownMenu.ItemIndicator>
                <span>{option.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {option.description}
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {/* <p className="px-2 py-1.5 text-xs text-muted-foreground">
            所有会话共用，下次回复生效
          </p> */}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function InteractionSettingsControls() {
  const { settings, ready, readOnly, busy } = useAppStore(
    useShallow((state) => ({
      settings: state.interactionSettings,
      ready: state.ready,
      readOnly: state.readOnly,
      busy: state.busy,
    })),
  );
  const [saving, setSaving] = useState(false);
  const descriptionId = useId();
  const disabled = !ready || readOnly || busy || saving;
  const change = async (patch: Partial<InteractionSettings>) => {
    setSaving(true);
    try {
      await updateInteractionSettings(patch);
    } catch (error) {
      report(error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="flex flex-wrap items-center gap-0.5"
      aria-label="全局交互设置"
      aria-busy={saving}
    >
      {/* <span id={descriptionId} className="sr-only">
        所有会话共用，下次回复生效
      </span> */}
      <SettingMenu
        label="回复长度"
        value={settings.replyLength}
        options={REPLY_LENGTH_OPTIONS}
        disabled={disabled}
        descriptionId={descriptionId}
        onChange={(replyLength) => void change({ replyLength })}
      />
      <SettingMenu
        label="叙事推进"
        value={settings.narrativeMode}
        options={NARRATIVE_MODE_OPTIONS}
        disabled={disabled}
        descriptionId={descriptionId}
        onChange={(narrativeMode) => void change({ narrativeMode })}
      />
    </div>
  );
}
