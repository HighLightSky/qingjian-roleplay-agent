package com.example.llm;

import com.example.llm.model.ChatRequest;
import com.example.llm.model.ChatResponse;

import java.io.IOException;
import java.util.function.Consumer;

public interface LLMClient {
    // 非流式请求
    ChatResponse chat(ChatRequest request) throws IOException, InterruptedException;

    // 流式请求，Consumer<String> onTextDelta 表示“收到文本增量时”要执行的回调
    String chatStream(ChatRequest request, Consumer<String> onTextDelta)
            throws IOException, InterruptedException;
}
