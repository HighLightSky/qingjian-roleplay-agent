"use client";

import { UserRoundIcon } from "lucide-react";

export function CharacterReference({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string | null;
  options: { id: string; label: string }[];
  disabled: boolean;
  onChange(value: string | null): void;
}) {
  return (
    <label className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <UserRoundIcon className="size-3.5" />
        人物参考
      </span>
      <select
        aria-label="人物参考图"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-9 min-w-0 max-w-full flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-ring"
      >
        <option value="">请选择人物参考图</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
