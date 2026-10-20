package com.example.service;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

import com.example.web.dto.SegmentDelta;

class SegmentStreamParserTest {

    @Test
    void emitsTextBeforeLineEndsAndWaitsForSplitMarker() {
        List<SegmentDelta> deltas = new ArrayList<>();
        SegmentStreamParser parser = new SegmentStreamParser(deltas::add);

        parser.feed("[台");
        assertEquals(List.of(), deltas);

        parser.feed("词]“你");
        assertEquals(List.of(new SegmentDelta("dialogue", "“你")), deltas);

        parser.feed("来了。”");
        parser.finish();
        assertEquals(List.of(new SegmentDelta("dialogue", "“你来了。”")), merge(deltas));
    }

    @Test
    void handlesEveryChunkSizeIncludingLfAndLeadingWhitespace() {
        assertForEveryChunkSize(
                "  [描写]（她抬头。）\n\t[台词]“你好。”\n[描写]（她挥手。）",
                List.of(
                        new SegmentDelta("narration", "（她抬头。）\n"),
                        new SegmentDelta("dialogue", "“你好。”\n"),
                        new SegmentDelta("narration", "（她挥手。）")));
    }

    @Test
    void preservesUnmarkedTextAsNarrationEvenWithOpeningQuote() {
        assertForEveryChunkSize(
                "  普通描写[台词]仍是正文\n  “没有标记的台词。”\n[未知]保留原文",
                List.of(
                        new SegmentDelta("narration",
                                "  普通描写[台词]仍是正文\n  “没有标记的台词。”\n[未知]保留原文")));
    }

    @Test
    void flushesIncompleteMarkerAtLineEndAndStreamEnd() {
        assertForEveryChunkSize("[台\n  [描", List.of(
                new SegmentDelta("narration", "[台\n  [描")));
    }

    @Test
    void ignoresBlankAndMarkerOnlyLinesButPreservesBodyWhitespace() {
        assertForEveryChunkSize(
                " \n[台词]\n[描写]  \n[台词]  你好  \n[描写] ",
                List.of(new SegmentDelta("dialogue", "  你好  \n")));
    }

    @Test
    void emptyInputAndRepeatedFinishDoNotEmitAnything() {
        List<SegmentDelta> deltas = new ArrayList<>();
        SegmentStreamParser parser = new SegmentStreamParser(deltas::add);
        parser.feed("");
        parser.finish();
        parser.finish();
        assertEquals(List.of(), deltas);
    }

    private void assertForEveryChunkSize(String input, List<SegmentDelta> expected) {
        for (int size = 1; size <= input.length(); size++) {
            List<SegmentDelta> deltas = new ArrayList<>();
            SegmentStreamParser parser = new SegmentStreamParser(deltas::add);
            for (int offset = 0; offset < input.length(); offset += size) {
                parser.feed(input.substring(offset, Math.min(offset + size, input.length())));
            }
            parser.finish();
            assertEquals(expected, merge(deltas), "文本块大小：" + size);
        }
    }

    private List<SegmentDelta> merge(List<SegmentDelta> deltas) {
        List<SegmentDelta> result = new ArrayList<>();
        for (SegmentDelta delta : deltas) {
            if (!result.isEmpty() && result.getLast().kind().equals(delta.kind())) {
                SegmentDelta last = result.removeLast();
                result.add(new SegmentDelta(last.kind(), last.text() + delta.text()));
            } else {
                result.add(delta);
            }
        }
        return result;
    }
}
