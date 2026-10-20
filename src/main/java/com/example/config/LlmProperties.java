package com.example.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "roleplay.llm")
public record LlmProperties(
        String baseUrl,
        String apiKey,
        String model,
        double temperature,
        int maxTokens,
        int timeoutSeconds
) {  
}
