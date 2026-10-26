package com.example.llm.model;

/** 上游分别返回思考与正文；缺省字段在协议边界归一为空字符串。 */
public record StreamDelta(String reasoningContent, String content) {
    public StreamDelta {
        reasoningContent = reasoningContent == null ? "" : reasoningContent;
        content = content == null ? "" : content;
    }
}
