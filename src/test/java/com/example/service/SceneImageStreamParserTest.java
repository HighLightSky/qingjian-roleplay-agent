package com.example.service;

import static org.junit.jupiter.api.Assertions.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import com.example.web.dto.SegmentDelta;

class SceneImageStreamParserTest {
    @Test
    void arbitraryChunkBoundariesKeepPromptOutOfBody() {
        var body = new ArrayList<SegmentDelta>();
        var prompt = new StringBuilder();
        var parser = new SceneImageStreamParser(body::add, prompt::append);
        String tail = "[画面计划]{\"referenceImages\":[]}\n[参考图说明]参考 <image1>\n[主体]白裙人物\n[画面摘要]白裙人物坐在窗边";
        String text = "[台词]你好\n[描写]她坐下。\n" + tail;
        for (char ch : text.toCharArray())
            parser.feed(String.valueOf(ch));
        parser.finish();
        assertEquals("你好\n她坐下。\n", body.stream().map(SegmentDelta::text).reduce("", String::concat));
        assertEquals(tail, prompt.toString());
    }

    @Test
    void malformedTailAndTruncatedMarkerCannotBecomeNarration() {
        for (String tail : List.of("[参考图说明]漏了画面 JSON", "[画面计")) {
            var body = new StringBuilder();
            var prompt = new StringBuilder();
            var parser = new SceneImageStreamParser(delta -> body.append(delta.text()), prompt::append);
            parser.feed("[台词]你好\n" + tail);
            parser.finish();
            assertEquals("你好\n", body.toString());
            assertEquals(tail, prompt.toString());
        }
    }
}
