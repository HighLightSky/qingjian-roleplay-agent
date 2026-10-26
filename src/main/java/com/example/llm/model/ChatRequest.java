package com.example.llm.model;

import java.util.List;
import java.time.Duration;
import com.fasterxml.jackson.databind.JsonNode;

// 定义发送给LLM model的消息
public class ChatRequest {
    private List<Message> messages;
    private Integer maxTokens;  // 使用包装类型，可以为null
    private Double temperature;
    private final boolean thinkingEnabled;
    private JsonNode responseSchema;
    private Integer reasoningBudgetTokens;
    private Duration timeout;

    public Integer getReasoningBudgetTokens() {
        return reasoningBudgetTokens;
    }

    public void setReasoningBudgetTokens(Integer value) {
        reasoningBudgetTokens = value;
    }

    public Duration getTimeout() {
        return timeout;
    }

    public void setTimeout(Duration value) {
        timeout = value;
    }

    public ChatRequest(List<Message> messages, Integer maxTokens, Double temperature, boolean thinkingEnabled) {
        this.messages = messages;
        this.maxTokens = maxTokens;
        this.temperature = temperature;
        this.thinkingEnabled = thinkingEnabled;
    }

    public boolean isThinkingEnabled() {
        return thinkingEnabled;
    }

    public JsonNode getResponseSchema() {
        return responseSchema;
    }

    public void setResponseSchema(JsonNode responseSchema) {
        this.responseSchema = responseSchema;
    }

    public List<Message> getMessages() {
        return messages;
    }

    public void setMessages(List<Message> messages) {
        this.messages = messages;
    }

    public Integer getMaxTokens() {
        return maxTokens;
    }

    public void setMaxTokens(Integer maxTokens) {
        this.maxTokens = maxTokens;
    }

    public Double getTemperature() {
        return temperature;
    }

    public void setTemperature(Double temperature) {
        this.temperature = temperature;
    }

}
