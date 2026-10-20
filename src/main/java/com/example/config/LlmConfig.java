package com.example.config;

import java.net.http.HttpClient;
import java.time.Duration;

import com.example.llm.LLMClient;
import com.example.llm.OpenAiClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class LlmConfig {

    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);

    @Bean
    public HttpClient httpClient() {
        return HttpClient.newBuilder()
                .connectTimeout(CONNECT_TIMEOUT)
                .build();
    }

    @Bean
    public LLMClient llmClient(
            HttpClient httpClient,
            ObjectMapper objectMapper,
            LlmProperties properties) {

        return new OpenAiClient(
                httpClient,
                objectMapper,
                properties.baseUrl(),
                properties.apiKey(),
                properties.model(),
                Duration.ofSeconds(properties.timeoutSeconds()));
    }
}
