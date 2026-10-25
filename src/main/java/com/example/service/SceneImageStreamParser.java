package com.example.service;

import java.util.function.Consumer;
import com.example.web.dto.SegmentDelta;

/** 画面尾部一旦开始便不能降级为正文，标记可以跨任意流块。 */
public final class SceneImageStreamParser {
    private static final String MARKER = "[画面计划]";
    private static final java.util.List<String> TAIL_MARKERS = java.util.stream.Stream
            .concat(java.util.stream.Stream.of(MARKER),
                    SceneImagePromptAssembler.SECTIONS.stream().map(s -> "[" + s + "]"))
            .toList();
    private final SegmentStreamParser body;
    private final Consumer<String> tail;
    private final StringBuilder prefix = new StringBuilder();
    private boolean bodyLine, inTail;

    public SceneImageStreamParser(Consumer<SegmentDelta> onBody, Consumer<String> onTail) {
        body = new SegmentStreamParser(onBody);
        tail = onTail;
    }

    public void feed(String chunk) {
        var text = new StringBuilder();
        var image = new StringBuilder();
        for (char ch : chunk.toCharArray()) {
            if (inTail) {
                image.append(ch);
                continue;
            }
            if (bodyLine) {
                text.append(ch);
                if (ch == '\n')
                    bodyLine = false;
                continue;
            }
            prefix.append(ch);
            String candidate = prefix.toString().stripLeading();
            if (TAIL_MARKERS.contains(candidate)) {
                inTail = true;
                image.append(candidate);
                prefix.setLength(0);
            } else if (!candidate.isEmpty() && TAIL_MARKERS.stream().noneMatch(marker -> marker.startsWith(candidate))
                    || ch == '\n') {
                text.append(prefix);
                prefix.setLength(0);
                bodyLine = ch != '\n';
            }
        }
        if (!text.isEmpty())
            body.feed(text.toString());
        if (!image.isEmpty())
            tail.accept(image.toString());
    }

    public void finish() {
        if (!prefix.isEmpty()) {
            // 截断的画面标记同样不能泄漏到剧情。
            if (prefix.toString().stripLeading().startsWith("[画面"))
                tail.accept(prefix.toString());
            else
                body.feed(prefix.toString());
        }
        body.finish();
    }
}
