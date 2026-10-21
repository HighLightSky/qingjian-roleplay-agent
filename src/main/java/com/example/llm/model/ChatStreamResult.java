package com.example.llm.model;

public record ChatStreamResult(String finishReason, TokenUsage usage) {}
