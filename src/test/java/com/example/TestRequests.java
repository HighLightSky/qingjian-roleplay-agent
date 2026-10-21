package com.example;

import java.util.*;
import com.example.web.dto.StateDtos.*;

/** 测试使用与浏览器一致的完整领域快照。 */
public final class TestRequests {
    private TestRequests() {}
    public static Snapshot state(List<String> contents) {
        List<Memory> memories = new ArrayList<>();
        for (int i = 0; i < contents.size(); i++) {
            memories.add(new Memory("memory-" + i, "character", "session",
                    new MemoryValue(contents.get(i), "session", "fact", "established", "active"),
                    1, "manual", "session", List.of(), "2000-01-01T00:00:00Z"));
        }
        return new Snapshot("session", "character", 0, 0, 0,
                new Story("", "", "", "", List.of(), List.of(), List.of(), List.of()), Map.of(), memories, List.of());
    }
}
