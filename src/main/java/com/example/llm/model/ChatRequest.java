package com.example.llm.model;

import java.util.List;

// 定义发送给LLM model的消息
public class ChatRequest {
    private List<Message> messages;
    private Integer maxTokens;  // 使用包装类型，可以为null
    private Double temperature;

    public ChatRequest(List<Message> messages, Integer maxTokens, Double temperature) {
        this.messages = messages;
        this.maxTokens = maxTokens;
        this.temperature = temperature;
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
