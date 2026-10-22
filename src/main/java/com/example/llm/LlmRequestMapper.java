package com.example.llm;

import com.example.config.LlmProperties;
import com.example.llm.model.ChatRequest;
import com.example.llm.model.Message;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Component;

/** 计数和正式调用共用消息序列化，避免模板材料与实际输入分叉。 */
@Component
public class LlmRequestMapper {
    private final ObjectMapper mapper;
    private final LlmProperties properties;

    public LlmRequestMapper(ObjectMapper mapper, LlmProperties properties) {
        this.mapper = mapper;
        this.properties = properties;
    }

    public ArrayNode messages(ChatRequest request) {
        ArrayNode messages = mapper.createArrayNode();
        for (Message message : request.getMessages()) {
            ObjectNode item = messages.addObject().put("role", message.getRole());
            if (message.getParts() == null) {
                item.put("content", message.getContent());
            } else {
                ArrayNode parts = item.putArray("content");
                for (Message.Part part : message.getParts()) {
                    ObjectNode block = parts.addObject().put("type", part.type());
                    switch (part.type()) {
                        case "text" -> block.put("text", part.text());
                        case "image_url" -> block.putObject("image_url").put("url", part.imageUrl());
                        default -> throw new IllegalArgumentException("未知模型内容块：" + part.type());
                    }
                }
            }
        }
        return messages;
    }

    public ObjectNode templateBody(ChatRequest request) {
        ObjectNode body = mapper.createObjectNode().put("model", properties.model());
        body.set("messages", messages(request));
        body.put("add_generation_prompt", true);
        body.putObject("chat_template_kwargs").put("enable_thinking", request.isThinkingEnabled());
        appendResponseFormat(body, request);
        return body;
    }

    public ObjectNode chatBody(ChatRequest request, boolean stream) {
        ObjectNode body = mapper.createObjectNode().put("model", properties.model());
        body.set("messages", messages(request));
        body.put("max_completion_tokens", request.getMaxTokens());
        body.put("temperature", request.getTemperature());
        body.put("stream", stream);
        body.putObject("chat_template_kwargs").put("enable_thinking", request.isThinkingEnabled());
        appendResponseFormat(body, request);
        if (stream) body.putObject("stream_options").put("include_usage", true);
        return body;
    }

    private void appendResponseFormat(ObjectNode body, ChatRequest request) {
        if (request.getResponseSchema() != null) {
            var format = body.putObject("response_format").put("type", "json_schema");
            format.putObject("json_schema").put("name", "structured_output").put("strict", true)
                    .set("schema", request.getResponseSchema());
        }
    }
}
