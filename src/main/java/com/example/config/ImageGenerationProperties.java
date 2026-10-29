package com.example.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "roleplay.image-generation")
public record ImageGenerationProperties(String baseUrl, String apiToken, int timeoutSeconds, int cancelTimeoutSeconds,
        int taskTimeoutSeconds, int resultRetentionSeconds, int maxResults, long resultCacheBytes, long maxImageBytes,
        long maxPixels, int maxEdge, long maxTotalPixels, long maxRequestBytes, int maxPromptCharacters,
        long maxOutputBytes, long maxOutputPixels, int referenceMaxEdge, double referenceJpegQuality, int defaultWidth,
        int defaultHeight, int dimensionAlignment, int readyTimeoutSeconds, int poseSearchTimeoutSeconds,
        int poseMaxBytes, int poseSearchMaxResponseBytes, int poseSearchMaxRequestBytes, int poseSearchTopK) {
    public ImageGenerationProperties {
        if (baseUrl == null || baseUrl.isBlank() || apiToken == null || timeoutSeconds < 1 || cancelTimeoutSeconds < 1
                || taskTimeoutSeconds <= timeoutSeconds || resultRetentionSeconds < 1 || maxResults < 1
                || maxOutputBytes < 1 || resultCacheBytes / maxResults < maxOutputBytes + 65536 || maxImageBytes < 1
                || maxPixels < 1 || maxEdge < 1 || maxTotalPixels < maxPixels || maxRequestBytes < maxImageBytes
                || maxPromptCharacters < 1 || maxOutputPixels < 1 || referenceMaxEdge < 1 || referenceJpegQuality <= 0
                || referenceJpegQuality > 1 || defaultWidth < 1 || defaultHeight < 1 || dimensionAlignment < 1
                || readyTimeoutSeconds < 1 || poseSearchTimeoutSeconds < 1 || poseMaxBytes < 1
                || poseSearchMaxResponseBytes < poseMaxBytes || poseSearchMaxRequestBytes < 1 || poseSearchTopK < 1
                || defaultWidth > maxEdge || defaultHeight > maxEdge || (long) defaultWidth * defaultHeight > maxPixels)
            throw new IllegalArgumentException("生图服务限制与结果预留配置无效");
    }
}
