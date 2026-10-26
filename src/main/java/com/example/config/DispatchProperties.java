package com.example.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "roleplay.dispatch")
public record DispatchProperties(long imageCacheBytes, int imageIdleSeconds, int imageLifetimeSeconds,
        int stateTimeoutSeconds, int resultRetentionSeconds, int maxResults, long resultCacheBytes,
        int cleanupSeconds, int selectionOutputTokens, int stateOutputTokens) {
    public DispatchProperties {
        if (imageCacheBytes < 1 || imageIdleSeconds < 1 || imageLifetimeSeconds < 1 || stateTimeoutSeconds < 1
                || resultRetentionSeconds < 1 || maxResults < 1 || resultCacheBytes < 1 || cleanupSeconds < 1
                || selectionOutputTokens < 1 || stateOutputTokens < 1
                || imageIdleSeconds > imageLifetimeSeconds || resultCacheBytes < maxResults)
            throw new IllegalArgumentException("后台任务与缓存配置必须为正数");
    }
}
