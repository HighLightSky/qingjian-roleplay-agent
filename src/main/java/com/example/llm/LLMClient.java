package com.example.llm;

import com.example.llm.model.ChatRequest;
import com.example.llm.model.ChatResponse;

import java.io.IOException;

public interface LLMClient {
    ChatResponse chat(ChatRequest request) throws IOException, InterruptedException;
    
}
