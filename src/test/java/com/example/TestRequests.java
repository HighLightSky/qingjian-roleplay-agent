package com.example;

import java.util.*;
import com.example.web.dto.StateDtos.*;

/** 测试使用与浏览器一致的完整领域快照。 */
public final class TestRequests {
    private TestRequests() {}
    public static com.example.web.dto.ContextDtos.HistorySummary summary() {
        return new com.example.web.dto.ContextDtos.HistorySummary("", 0, 0);
    }
    public static com.example.config.ContextProperties contextProperties() {
        return new com.example.config.ContextProperties(193024, .70, .50, 10, 1024, 32768, 8192, 4096, 8, 32, 9, 1.10, 64);
    }
    public static com.example.service.ContextBudgetService budgets() {
        var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        var counter = org.mockito.Mockito.mock(com.example.service.LlamaTokenCounter.class);
        try {
            var count = new com.example.web.dto.ContextDtos.TokenCount(100, "exact", "test-model", "test-fingerprint");
            org.mockito.Mockito.when(counter.count(org.mockito.ArgumentMatchers.any())).thenReturn(count);
            org.mockito.Mockito.when(counter.countText(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.anyList())).thenReturn(count);
        } catch (Exception e) { throw new AssertionError(e); }
        var vision = new com.example.config.VisionProperties();
        var llm = new com.example.config.LlmProperties("", "", "test-model", .8, 800, 120);
        return new com.example.service.ContextBudgetService(counter, new com.example.prompt.PromptBuilder(llm),
                contextProperties(), vision, new com.example.service.ContextValidation(mapper),
                new com.example.service.ImageValidationService(vision), mapper);
    }
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
