type Event = { name: string; data: string };
/** Incremental SSE lines: CR, LF and CRLF may themselves cross network chunks. */
export class SSEParser {
  private line = "";
  private afterCR = false;
  private name = "";
  private data: string[] = [];
  private size = 0;
  constructor(private emit: (event: Event) => void) {}
  feed(text: string) {
    for (const char of text) {
      if (this.afterCR) {
        this.afterCR = false;
        if (char === "\n") continue;
      }
      if (char === "\r" || char === "\n") {
        this.consumeLine();
        this.afterCR = char === "\r";
      } else {
        this.line += char;
        if (++this.size > 1_000_000) throw new Error("服务器事件过大。");
      }
    }
  }
  private consumeLine() {
    const line = this.line;
    this.line = "";
    if (!line) {
      if (this.data.length)
        this.emit({ name: this.name || "message", data: this.data.join("\n") });
      this.name = "";
      this.data = [];
      this.size = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.name = value;
    if (field === "data") this.data.push(value);
  }
}
