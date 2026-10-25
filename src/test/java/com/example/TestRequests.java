package com.example;

import java.util.*;
import com.example.web.dto.StateDtos.*;

/** 测试使用与浏览器一致的完整领域快照。 */
public final class TestRequests {
    private static final int MAX_IMAGES = configuredMaxImages();

    private static int configuredMaxImages() {
        var yaml = new org.springframework.beans.factory.config.YamlPropertiesFactoryBean();
        yaml.setResources(new org.springframework.core.io.ClassPathResource("application.yml"));
        return Integer.parseInt(Objects.requireNonNull(yaml.getObject()).getProperty("roleplay.vision.max-images"));
    }

    public static com.example.config.VisionProperties vision() {
        var properties = new com.example.config.VisionProperties();
        properties.setMaxImages(MAX_IMAGES);
        return properties;
    }

    public static com.example.config.ImageGenerationProperties generation(String baseUrl) {
        return new com.example.config.ImageGenerationProperties(baseUrl, "test-token", 5, 1, 6, 7200, 2, 140000000,
                16777216, 4194304, 8192, 16777216, 134217728, 16384, 67108864, 20000000, 1024, .85, 256, 512, 32);
    }

    public static com.example.config.DispatchProperties dispatch() {
        return new com.example.config.DispatchProperties(536870912, 1800, 7200, 600, 7200, 32, 67108864, 60, 4096, 8192);
    }
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
        var vision = vision();
        var llm = new com.example.config.LlmProperties("", "", "test-model", .8, 800, 120);
        return new com.example.service.ContextBudgetService(counter, new com.example.prompt.PromptBuilder(llm, com.example.TestRequests.vision()),
                contextProperties(), vision, new com.example.service.ContextValidation(),
                new com.example.service.ImageValidationService(vision), mapper);
    }
    public static com.example.service.AuxiliaryContextService auxiliaryContexts() {
        var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        var counter = org.mockito.Mockito.mock(com.example.service.LlamaTokenCounter.class);
        try {
            var count = new com.example.web.dto.ContextDtos.TokenCount(100, "exact", "test-model", "test-fingerprint");
            org.mockito.Mockito.when(counter.count(org.mockito.ArgumentMatchers.any())).thenReturn(count);
            org.mockito.Mockito.when(counter.countTextOnly(org.mockito.ArgumentMatchers.any())).thenReturn(count);
            org.mockito.Mockito.when(counter.tokenize(org.mockito.ArgumentMatchers.anyString())).thenAnswer(i ->
                    (long) ((String) i.getArgument(0)).codePointCount(0, ((String) i.getArgument(0)).length()));
        } catch (Exception e) { throw new AssertionError(e); }
        return new com.example.service.AuxiliaryContextService(mapper, counter, contextProperties(),
                new com.example.config.AuxiliaryContextProperties(4, 8192, 8192, 32768, 32768, 2048, 2048));
    }
    public static Snapshot state(List<String> contents) {
        List<Memory> memories = new ArrayList<>();
        for (int i = 0; i < contents.size(); i++) {
            memories.add(new Memory("memory-" + i, "character", "session",
                    new MemoryValue(contents.get(i), "session", "fact", "established", "active"),
                    1, "manual", "session", List.of(), "2000-01-01T00:00:00Z"));
        }
        return new Snapshot("session", "character", 0, 0,
                new Story("", "", "", "", List.of(), List.of(), List.of(), List.of()), Map.of(), memories, List.of(), com.example.web.dto.StateDtos.VisualState.empty(), java.util.Map.of());
    }
}
