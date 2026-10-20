package com.example.llm;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Objects;
import java.util.function.Consumer;

import com.example.llm.model.ChatRequest;
import com.example.llm.model.ChatResponse;
import com.example.llm.model.Message;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** 调用 OpenAI 兼容的 Chat Completions 接口，支持普通和流式两种请求。 */
public class OpenAiClient implements LLMClient {
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(120);

    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final URI apiUri;
    private final String apiKey;
    private final String model;
    private final Duration requestTimeout;

    // 如果不关心超时，使用默认超时
    public OpenAiClient(
            HttpClient httpClient,
            ObjectMapper objectMapper,
            String apiUrl,
            String apiKey,
            String model) {
        this(httpClient, objectMapper, apiUrl, apiKey, model, DEFAULT_TIMEOUT);
    }

    // 关心超时，需要提供超时参数
    public OpenAiClient(
            HttpClient httpClient,
            ObjectMapper objectMapper,
            String apiUrl,
            String apiKey,
            String model,
            Duration requestTimeout) {
        this.httpClient = Objects.requireNonNull(httpClient, "httpClient must not be null");
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper must not be null");
        this.apiUri = URI.create(requireNonBlank(apiUrl, "apiUrl"));
        this.apiKey = requireNonBlank(apiKey, "apiKey");
        this.model = requireNonBlank(model, "model");
        this.requestTimeout = Objects.requireNonNull(requestTimeout, "requestTimeout must not be null");
    }

    // 非流式请求实现
    @Override
    public ChatResponse chat(ChatRequest request) throws IOException, InterruptedException {
        ObjectNode jsonRequest = buildRequestBody(request, false);
        HttpRequest httpRequest = buildHttpRequest(jsonRequest, "application/json");

        HttpResponse<String> httpResponse = httpClient.send(
                httpRequest,
                HttpResponse.BodyHandlers.ofString());

        if (!isSuccess(httpResponse.statusCode())) {
            throw new IOException("Chat API returned HTTP " + httpResponse.statusCode()
                    + ": " + httpResponse.body());
        }

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

    // 流式请求实现
    @Override
    public String chatStream(ChatRequest request, Consumer<String> onTextDelta)
            throws IOException, InterruptedException {
        Objects.requireNonNull(onTextDelta, "onTextDelta must not be null");

        ObjectNode jsonRequest = buildRequestBody(request, true);
        HttpRequest httpRequest = buildHttpRequest(jsonRequest, "text/event-stream");

        HttpResponse<InputStream> httpResponse = httpClient.send(
                httpRequest,
                HttpResponse.BodyHandlers.ofInputStream());

        if (!isSuccess(httpResponse.statusCode())) {
            try (InputStream body = httpResponse.body()) {
                String errorBody = new String(body.readAllBytes(), StandardCharsets.UTF_8);
                throw new IOException("Chat API returned HTTP " + httpResponse.statusCode()
                        + ": " + errorBody);
            }
        }

        String finishReason = null;

        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(httpResponse.body(), StandardCharsets.UTF_8))) {

            String line;
            while ((line = reader.readLine()) != null) {
                // 只关心 data: 行，其他行（空行、event:、id: 等）一律跳过
                if (!line.startsWith("data:")) {
                    continue;
                }

                String data = line.substring(5).trim();
                if (data.isEmpty()) {
                    continue;
                }
                // [DONE] 是流结束标记，不是JSON
                if (data.equals("[DONE]")) {
                    break;
                }

                JsonNode responseJson = objectMapper.readTree(data);
                JsonNode choices = responseJson.path("choices");
                if (!choices.isArray() || choices.isEmpty()) {
                    continue;
                }

                JsonNode choice = choices.get(0);
                JsonNode content = choice.path("delta").path("content");
                if (content.isTextual() && !content.asText().isEmpty()) {
                    onTextDelta.accept(content.asText());
                }

                JsonNode reason = choice.path("finish_reason");
                if (reason.isTextual()) {
                    finishReason = reason.asText();
                }
            }
        }

        return finishReason;
    }

    /** 构造 OpenAI 兼容的请求体，普通和流式请求共用。 */
    private ObjectNode buildRequestBody(ChatRequest request, boolean stream) {
        Objects.requireNonNull(request, "request must not be null");
        Objects.requireNonNull(request.getMessages(), "messages must not be null");

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
        jsonRequest.put("stream", stream);

        return jsonRequest;
    }

    private HttpRequest buildHttpRequest(ObjectNode jsonRequest, String accept) throws IOException {
        return HttpRequest.newBuilder(apiUri)
                .timeout(requestTimeout)
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .header("Accept", accept)
                .POST(HttpRequest.BodyPublishers.ofString(
                        objectMapper.writeValueAsString(jsonRequest)))
                .build();
    }

    private static boolean isSuccess(int statusCode) {
        return statusCode >= 200 && statusCode < 300;
    }

    private static String requireNonBlank(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value;
    }
}
