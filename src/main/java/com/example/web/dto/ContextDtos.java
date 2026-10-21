package com.example.web.dto;

import java.util.List;

public final class ContextDtos {
    private ContextDtos() {}

    public record HistorySummary(String text, int throughSeq, int version) {
        public HistorySummary {
            if (text == null || throughSeq < 0 || version < 0
                    || (throughSeq == 0 ? !text.isEmpty() || version != 0 : text.isBlank() || version == 0))
                throw new IllegalArgumentException("历史摘要正文、覆盖终点或版本无效");
        }
    }

    public record ImageMetadata(String assetId, int width, int height) {}
    public record BudgetRequest(ChatApiRequest context, String mode, List<ImageMetadata> images) {
        public BudgetRequest { images = images == null ? List.of() : List.copyOf(images); }
    }
    public record TokenCount(long inputTokens, String accuracy, String modelFingerprint, String requestFingerprint) {}
    public record ContextBudget(long inputTokens, int contextWindowTokens, double usageRatio,
            int outputReserveTokens, int safetyTokens, String accuracy, boolean needsCompaction,
            boolean fits, String requestFingerprint, int compactThroughSeq) {}
    public record CompactionRequest(String operationId, ChatApiRequest context) {}
    public record CompactionResult(String operationId, String sessionId, int baseSessionVersion,
            int baseMemoryVersion, int baseSummaryVersion, int fromExclusiveSeq, int throughSeq,
            HistorySummary summary, long beforeTokens, long afterTokens, List<String> sourceMessageIds,
            String sourceFingerprint) {}
}
