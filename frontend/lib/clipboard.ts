export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
    } catch (cause) {
      throw new Error("复制失败：浏览器拒绝写入剪贴板，请检查站点权限。", {
        cause,
      });
    }
    return;
  }
  const focused = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i),
      )
    : [];
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;top:0;left:-9999px";
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand("copy"))
      throw new Error(
        "复制失败：浏览器不支持当前页面的剪贴板写入，请使用 HTTPS 或手动复制。",
      );
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    selection?.removeAllRanges();
    ranges.forEach((range) => selection?.addRange(range));
  }
}
