package com.example.llm.model;

// ChatResponse只表示统一的模型回复中内容部分
public class ChatResponse {
    private String content;
    private String finishReason;
    private final TokenUsage usage;

    public ChatResponse(String content, String finishReason, TokenUsage usage) {
        this.content = content;
        this.finishReason = finishReason;
        this.usage = usage;
    }

    public TokenUsage getUsage() { return usage; }

    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }

    public String getFinishReason() {
        return finishReason;
    }

    public void setFinishReason(String finishReason) {
        this.finishReason = finishReason;
    }

}
