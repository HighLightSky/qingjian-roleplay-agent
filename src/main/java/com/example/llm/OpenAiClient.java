package com.example.llm;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Objects;

import com.example.llm.model.ChatRequest;
import com.example.llm.model.ChatResponse;
import com.example.llm.model.Message;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Sends a non-streaming chat request to an OpenAI-compatible Chat Completions endpoint. */
public class OpenAiClient implements LLMClient {
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final URI apiUri;
    private final String apiKey;
    private final String model;

    public OpenAiClient(
            HttpClient httpClient,
            ObjectMapper objectMapper,
            String apiUrl,
            String apiKey,
            String model) {
        this.httpClient = Objects.requireNonNull(httpClient, "httpClient must not be null");
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper must not be null");
        this.apiUri = URI.create(requireNonBlank(apiUrl, "apiUrl"));
        this.apiKey = requireNonBlank(apiKey, "apiKey");
        this.model = requireNonBlank(model, "model");
    }

    @Override
    public ChatResponse chat(ChatRequest request) throws IOException, InterruptedException {
        // 1. 构造消息json
        Objects.requireNonNull(request, "request must not be null");
        ObjectNode jsonRequest = objectMapper.createObjectNode();
        jsonRequest.put("model", model);
        ArrayNode messages = jsonRequest.putArray("messages");

        for (Message message : request.getMessages()) {
            Objects.requireNonNull(message, "messages must not contain null entries");
            Objects.requireNonNull(message.getRole(), "message role must not be null");
            Objects.requireNonNull(message.getContent(), "message content must not be null");

            ObjectNode item = messages.addObject();
            item.put("role", message.getRole());
            item.put("content", message.getContent());
        }

        if (request.getMaxTokens() != null) {
            jsonRequest.put("max_completion_tokens", request.getMaxTokens());
        }
        if (request.getTemperature() != null) {
            jsonRequest.put("temperature", request.getTemperature());
        }
        jsonRequest.put("stream", false);

        // 2. 发送请求
        // 构造请求
        HttpRequest httpRequest = HttpRequest.newBuilder(apiUri)
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(jsonRequest)))
                .build();
        // 发送请求，并说明响应正文解析为字符串
        HttpResponse<String> httpResponse = httpClient.send(
                httpRequest,
                HttpResponse.BodyHandlers.ofString());

        if (httpResponse.statusCode() < 200 || httpResponse.statusCode() >= 300) {
            throw new IOException("Chat API returned HTTP " + httpResponse.statusCode()
                    + ": " + httpResponse.body());
        }

        // 3. 解析响应
        // 解析成JSON树结构
        JsonNode responseJson = objectMapper.readTree(httpResponse.body());
        JsonNode choices = responseJson.path("choices");
        if (!choices.isArray() || choices.isEmpty()) {
            throw new IOException("Chat API response does not contain any choices");
        }

        JsonNode firstMessage = choices.path(0).path("message");
        JsonNode content = firstMessage.path("content");
        if (!content.isTextual()) {
            throw new IOException("Chat API response does not contain text message content");
        }

        JsonNode finishReason = choices.path(0).path("finish_reason");
        return new ChatResponse(
                content.asText(),
                finishReason.isNull() || finishReason.isMissingNode() ? null : finishReason.asText());
    }

    private static String requireNonBlank(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value;
    }
}
