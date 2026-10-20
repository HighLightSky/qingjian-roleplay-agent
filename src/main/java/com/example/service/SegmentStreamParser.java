package com.example.service;

import java.util.Objects;
import java.util.function.Consumer;

import com.example.web.dto.SegmentDelta;

/**
 * 判断当前流式文本类型是台词还是描写的解析器
 * 接收模型不断返回的文本块,识别 [台词]、[描写] 标记
 * 只将 LF（\n）识别为换行。每次聊天创建一个实例，通过回调输出 SegmentDelta，不在多个请求之间共享。
*/
public class SegmentStreamParser {
    private static final String DIALOGUE_MARKER = "[台词]";
    private static final String NARRATION_MARKER = "[描写]";

    private final Consumer<SegmentDelta> onDelta;

    // 行首类型未确定时，缓存前置空白及可能尚未接收完整的标记。
    private final StringBuilder prefix = new StringBuilder();
    // 类型确定后，缓存本次可以输出的正文。
    private final StringBuilder content = new StringBuilder();
    // null 表示当前行尚未识别类型。
    private String kind;
    private boolean lineHasContent;

    /** 保存解析结果的接收函数，此处不开始解析。 */
    public SegmentStreamParser(Consumer<SegmentDelta> onDelta) {
        this.onDelta = Objects.requireNonNull(onDelta, "onDelta 不能为空");
    }

    /** 每收到一个模型文本块调用一次，不要求文本块包含完整标记或完整行。 */
    public void feed(String chunk) {
        Objects.requireNonNull(chunk, "chunk 不能为空");

        for (int i = 0; i < chunk.length(); i++) {
            char ch = chunk.charAt(i);

            if (ch == '\n') {
                endLine(true);
            } else if (kind == null) {
                prefix.append(ch);
                detectKind();
            } else {
                content.append(ch);
            }
        }

        // 已识别类型的正文立即输出，无须等待下一次换行。
        flushContent();
    }

    /** 模型正常输出结束后调用，输出最后一行及无法组成完整标记的残留文本。 */
    public void finish() {
        endLine(false);
    }

    /** 只在行首识别类型，允许标记前有空白。 */
    private void detectKind() {
        String candidate = prefix.toString().stripLeading();
        if (candidate.isEmpty()) {
            return;
        }

        if (DIALOGUE_MARKER.equals(candidate) || NARRATION_MARKER.equals(candidate)) {
            kind = DIALOGUE_MARKER.equals(candidate) ? "dialogue" : "narration";
            prefix.setLength(0);
        } else if (DIALOGUE_MARKER.startsWith(candidate)
                || NARRATION_MARKER.startsWith(candidate)) {
            // 例如只收到了 "[台"，继续等待后续字符。
            return;
        } else {
            // 如果无合法标记时按描写保留原文。
            kind = "narration";
            content.append(prefix);
            prefix.setLength(0);
        }
    }

    /** 结束当前行，并重置行首识别状态。 */
    private void endLine(boolean withNewline) {
        if (kind == null) {
            // 到行尾或流结束仍未识别出标记时，按描写保留原文，例如 "[台"。
            kind = "narration";
            content.append(prefix);
            prefix.setLength(0);
        }

        // 保留有效正文的换行，避免前端合并同类型增量后把两行粘在一起。
        if (withNewline && (lineHasContent || !content.toString().isBlank())) {
            content.append('\n');
        }
        flushContent();

        kind = null;
        lineHasContent = false;
        content.setLength(0);
    }

    private void flushContent() {
        if (kind == null || content.isEmpty()) {
            return;
        }
        // 行首或标记后的纯空白先缓存，避免空白行、只有标记的行产生空段。
        if (!lineHasContent && content.toString().isBlank()) {
            return;
        }

        String text = content.toString();
        content.setLength(0);
        lineHasContent = true;
        onDelta.accept(new SegmentDelta(kind, text));
    }
}
