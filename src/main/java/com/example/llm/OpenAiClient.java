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
import com.example.llm.model.ChatStreamResult;
import com.example.llm.model.TokenUsage;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** 调用 OpenAI 兼容的 Chat Completions 接口，支持普通和流式两种请求。 */
public class OpenAiClient implements LLMClient {

    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final URI apiUri;
    private final String apiKey;
    private final LlmRequestMapper requests;
    private final Duration requestTimeout;

    // 关心超时，需要提供超时参数
    public OpenAiClient(
            HttpClient httpClient,
            ObjectMapper objectMapper,
            String apiUrl,
            String apiKey,
            Duration requestTimeout,
            LlmRequestMapper requests) {
        this.httpClient = Objects.requireNonNull(httpClient, "httpClient must not be null");
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper must not be null");
        this.apiUri = URI.create(requireNonBlank(apiUrl, "apiUrl"));
        this.apiKey = requireNonBlank(apiKey, "apiKey");
        this.requests = Objects.requireNonNull(requests, "请求映射器不能为空");
        this.requestTimeout = Objects.requireNonNull(requestTimeout, "requestTimeout must not be null");
    }

    // 非流式请求实现
    @Override
    public ChatResponse chat(ChatRequest request) throws IOException, InterruptedException {
        ObjectNode jsonRequest = requests.chatBody(request, false);
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
                finishReason.isNull() || finishReason.isMissingNode() ? null : finishReason.asText(),
                TokenUsage.read(responseJson.path("usage")));
    }

    // 流式请求实现
    @Override
    public ChatStreamResult chatStream(ChatRequest request, Consumer<String> onTextDelta)
            throws IOException, InterruptedException {
        Objects.requireNonNull(onTextDelta, "onTextDelta must not be null");

        ObjectNode jsonRequest = requests.chatBody(request, true);
        HttpRequest httpRequest = buildHttpRequest(jsonRequest, "text/event-stream");

        long startedAt = System.nanoTime();
        HttpResponse<InputStream> httpResponse = httpClient.send(
                httpRequest,
                HttpResponse.BodyHandlers.ofInputStream());

        com.example.service.UpstreamCancellation.register(httpResponse.body());
        if (!isSuccess(httpResponse.statusCode())) {
            try (InputStream body = httpResponse.body()) {
                String errorBody = new String(body.readAllBytes(), StandardCharsets.UTF_8);
                throw new IOException("Chat API returned HTTP " + httpResponse.statusCode()
                        + ": " + errorBody);
            }
        }

        String finishReason = null;
        TokenUsage usage = TokenUsage.unavailable();
        boolean ended = false;

        StreamDeadline deadline = new StreamDeadline(httpResponse.body(),
                Math.max(0, requestTimeout.toNanos() - (System.nanoTime() - startedAt)));
        try (deadline; BufferedReader reader = new BufferedReader(
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
                    ended = true;
                    break;
                }

                JsonNode responseJson = objectMapper.readTree(data);
                if (!responseJson.path("usage").isMissingNode() && !responseJson.path("usage").isNull())
                    usage = TokenUsage.read(responseJson.path("usage"));
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
        } catch (IOException e) {
            if (deadline.expired) throw new java.net.http.HttpTimeoutException("模型流式请求超过单次调用时间限制");
            throw e;
        }


        if (deadline.expired) throw new java.net.http.HttpTimeoutException("模型流式请求超过单次调用时间限制");
        if (!ended) throw new IOException("模型事件流缺少结束标记，连接已中断");
        return new ChatStreamResult(finishReason, usage);
    }

    private static final class StreamDeadline implements AutoCloseable {
        private final InputStream body;
        private final Thread target = Thread.currentThread();
        private final Thread timer;
        private boolean finished;
        private volatile boolean expired;
        StreamDeadline(InputStream body, long nanos) {
            this.body = body;
            timer = Thread.ofVirtual().name("model-stream-deadline").start(() -> {
                try {
                    Thread.sleep(Duration.ofNanos(nanos));
                    expire();
                } catch (InterruptedException ignored) {
                    // 调用已完成，取消截止计时。
                }
            });
        }
        private synchronized void expire() {
            if (finished) return;
            expired = true;
            target.interrupt();
            try { body.close(); } catch (IOException ignored) { /* 连接已关闭。 */ }
        }
        @Override public synchronized void close() {
            finished = true;
            timer.interrupt();
        }
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
