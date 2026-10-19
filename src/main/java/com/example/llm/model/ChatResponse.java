package com.example.llm.model;

// ChatResponse只表示统一的模型回复中内容部分
public class ChatResponse {
    private String content;
    private String finishReason;

    public ChatResponse(String content, String finishReason) {
        this.content = content;
        this.finishReason = finishReason;
    }

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
