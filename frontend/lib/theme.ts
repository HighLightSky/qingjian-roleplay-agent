export const THEME_COLORS = [
  { value: "teal", label: "青绿" },
  { value: "magenta", label: "洋红" },
  { value: "pink", label: "粉红" },
  { value: "violet", label: "靓紫" },
  { value: "blue", label: "亮蓝" },
  { value: "orange", label: "明橘" },
] as const;

export type ThemeColor = (typeof THEME_COLORS)[number]["value"];
export const DEFAULT_THEME_COLOR: ThemeColor = "teal";

export function parseThemeColor(value: string): ThemeColor {
  const color = THEME_COLORS.find((color) => color.value === value);
  if (!color) throw new Error(`主题色设置无效：${value}`);
  return color.value;
}
