package com.example.llm;

import com.example.llm.model.ChatRequest;
import com.example.llm.model.ChatResponse;
import com.example.llm.model.ChatStreamResult;
import com.example.llm.model.StreamDelta;

import java.io.IOException;
import java.util.function.Consumer;

public interface LLMClient {
    // 非流式请求
    ChatResponse chat(ChatRequest request) throws IOException, InterruptedException;

    // 流式请求分别提供思考与正文增量。
    ChatStreamResult chatStream(ChatRequest request, Consumer<StreamDelta> onDelta)
            throws IOException, InterruptedException;
}
