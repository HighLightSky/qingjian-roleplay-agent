package com.example.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "roleplay.llm")
public record LlmProperties(
        String baseUrl,
        String apiKey,
        String model,
        double temperature,
        int maxTokens,
        int timeoutSeconds,
        int firstTokenTimeoutSeconds,
        int reasoningBudgetTokens,
        int reasoningProtocolTokens
) {
    public LlmProperties {
        if (maxTokens < 1 || timeoutSeconds < 1 || firstTokenTimeoutSeconds < 1
                || reasoningBudgetTokens < 1 || reasoningProtocolTokens < 1
                || (long) maxTokens + reasoningBudgetTokens + reasoningProtocolTokens > Integer.MAX_VALUE)
            throw new IllegalArgumentException("模型输出额度和超时配置必须为有效正数");
    }

    public int generationMaxTokens() {
        return maxTokens + reasoningBudgetTokens + reasoningProtocolTokens;
    }
}
