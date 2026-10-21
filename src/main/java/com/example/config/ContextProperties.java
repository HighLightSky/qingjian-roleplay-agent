package com.example.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "roleplay.context")
public record ContextProperties(int contextWindowTokens, double compactionTriggerRatio,
        double compactionTargetRatio, int retainedTurns, int safetyTokens,
        int compactionBatchInputTokens, int compactionMaxOutputTokens, int summaryMaxTokens,
        int compactionMaxBatches, int visionGridPixels, int visionMinGrids,
        double visionTokenMultiplier, int visionTokenOverhead) {
    public ContextProperties {
        if (contextWindowTokens <= 0 || !Double.isFinite(compactionTargetRatio)
                || !Double.isFinite(compactionTriggerRatio) || !Double.isFinite(visionTokenMultiplier)
                || compactionTargetRatio <= 0
                || compactionTargetRatio >= compactionTriggerRatio || compactionTriggerRatio >= 1
                || retainedTurns < 1 || safetyTokens < 0 || compactionBatchInputTokens < 1
                || compactionMaxOutputTokens < 1 || summaryMaxTokens < 1
                || summaryMaxTokens >= compactionMaxOutputTokens || compactionMaxBatches < 1
                || compactionBatchInputTokens + (long) compactionMaxOutputTokens + safetyTokens > contextWindowTokens
                || visionGridPixels < 1 || visionMinGrids < 1 || visionTokenMultiplier < 1 || visionTokenOverhead < 0) {
            throw new IllegalArgumentException("上下文配置无效：请检查窗口、压缩阈值、批次预算和视觉估算参数");
        }
    }
}
