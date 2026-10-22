package com.example.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** 辅助调用的文字预算，独立于正文历史压缩策略。 */
@ConfigurationProperties(prefix = "roleplay.auxiliary")
public record AuxiliaryContextProperties(int recentTurns, int recentHistoryTokens, int currentMessagesTokens,
        int stateInputTokens, int selectionInputTokens, int catalogEntryTokens, int correctionTokens) {
    public AuxiliaryContextProperties {
        if (recentTurns < 1 || recentHistoryTokens < 1 || currentMessagesTokens < 1 || stateInputTokens < 1
                || selectionInputTokens < 1 || catalogEntryTokens < 1 || correctionTokens < 1)
            throw new IllegalArgumentException("辅助上下文的轮次和 token 预算必须为正数");
    }
}
