package com.example.llm.model;

import java.io.IOException;
import com.fasterxml.jackson.databind.JsonNode;

/** 未实报的用量保留未知状态，不以估算或零替代。 */
public record TokenUsage(String status, Long inputTokens, Long outputTokens, Long totalTokens) {
    public static TokenUsage unavailable() {
        return new TokenUsage("unavailable", null, null, null);
    }

    public static TokenUsage read(JsonNode node) throws IOException {
        if (node.isMissingNode() || node.isNull()) return unavailable();
        for (String name : java.util.List.of("prompt_tokens", "completion_tokens", "total_tokens")) {
            if (!node.path(name).isIntegralNumber() || !node.path(name).canConvertToLong()
                    || node.path(name).longValue() < 0) {
                throw new IOException("模型用量字段无效：" + name);
            }
        }
        long input = node.path("prompt_tokens").longValue();
        long output = node.path("completion_tokens").longValue();
        long total = node.path("total_tokens").longValue();
        if (input > Long.MAX_VALUE - output || input + output != total)
            throw new IOException("模型用量总数与输入输出不一致");
        return new TokenUsage("reported", input, output, total);
    }
}
