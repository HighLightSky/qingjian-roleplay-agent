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
import com.example.llm.model.StreamDelta;
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
    private final Duration firstTokenTimeout;

    // 非流式总超时与流式首增量超时分别配置。
    public OpenAiClient(
            HttpClient httpClient,
            ObjectMapper objectMapper,
            String apiUrl,
            String apiKey,
            Duration requestTimeout,
            Duration firstTokenTimeout,
            LlmRequestMapper requests) {
        this.httpClient = Objects.requireNonNull(httpClient, "httpClient must not be null");
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper must not be null");
        this.apiUri = URI.create(requireNonBlank(apiUrl, "apiUrl"));
        this.apiKey = requireNonBlank(apiKey, "apiKey");
        this.requests = Objects.requireNonNull(requests, "请求映射器不能为空");
        this.firstTokenTimeout = Objects.requireNonNull(firstTokenTimeout, "首增量超时不能为空");
        this.requestTimeout = Objects.requireNonNull(requestTimeout, "requestTimeout must not be null");
    }

    // 非流式请求实现
    @Override
    public ChatResponse chat(ChatRequest request) throws IOException, InterruptedException {
        ObjectNode jsonRequest = requests.chatBody(request, false);
        HttpRequest httpRequest = buildHttpRequest(jsonRequest, "application/json",
                Objects.requireNonNullElse(request.getTimeout(), requestTimeout));

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
    public ChatStreamResult chatStream(ChatRequest request, Consumer<StreamDelta> onDelta)
            throws IOException, InterruptedException {
        Objects.requireNonNull(onDelta, "流式回调不能为空");

        ObjectNode jsonRequest = requests.chatBody(request, true);
        HttpRequest httpRequest = buildHttpRequest(jsonRequest, "text/event-stream", firstTokenTimeout);

        long startedAt = System.nanoTime();
        HttpResponse<InputStream> httpResponse;
        try {
            httpResponse = httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofInputStream());
        } catch (java.net.http.HttpConnectTimeoutException e) {
            throw new java.net.http.HttpConnectTimeoutException("连接模型服务超时：" + e.getMessage());
        } catch (java.net.http.HttpTimeoutException e) {
            throw new java.net.http.HttpTimeoutException("模型首增量等待超时：未及时返回思考或正文");
        }

        com.example.service.UpstreamCancellation.register(httpResponse.body());
        String finishReason = null;
        TokenUsage usage = TokenUsage.unavailable();
        boolean ended = false;

        FirstTokenDeadline deadline = new FirstTokenDeadline(httpResponse.body(),
                Math.max(0, firstTokenTimeout.toNanos() - (System.nanoTime() - startedAt)));
        try (deadline; BufferedReader reader = new BufferedReader(
                new InputStreamReader(httpResponse.body(), StandardCharsets.UTF_8))) {
            if (!isSuccess(httpResponse.statusCode())) {
                String errorBody = new String(httpResponse.body().readAllBytes(), StandardCharsets.UTF_8);
                throw new IOException("模型接口返回 HTTP " + httpResponse.statusCode() + "：" + errorBody);
            }
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
                JsonNode delta = choice.path("delta");
                String reasoning = deltaText(delta, "reasoning_content");
                String content = deltaText(delta, "content");
                if (!reasoning.isEmpty() || !content.isEmpty()) {
                    deadline.close();
                    if (deadline.expired)
                        throw new java.net.http.HttpTimeoutException("模型首增量等待超时：未及时返回思考或正文");
                    onDelta.accept(new StreamDelta(reasoning, content));
                }

                JsonNode reason = choice.path("finish_reason");
                if (reason.isTextual()) {
                    finishReason = reason.asText();
                }
            }
        } catch (IOException e) {
            if (deadline.expired) {
                Thread.interrupted();
                throw new java.net.http.HttpTimeoutException("模型首增量等待超时：未及时返回思考或正文");
            }
            throw e;
        }

        if (deadline.expired) throw new java.net.http.HttpTimeoutException("模型首增量等待超时：未及时返回思考或正文");
        if (!ended) throw new IOException("模型事件流缺少结束标记，连接已中断");
        return new ChatStreamResult(finishReason, usage);
    }

    private static final class FirstTokenDeadline implements AutoCloseable {
        private final InputStream body;
        private final Thread target = Thread.currentThread();
        private final Thread timer;
        private boolean finished;
        private volatile boolean expired;
        FirstTokenDeadline(InputStream body, long nanos) {
            this.body = body;
            timer = Thread.ofVirtual().name("model-first-token-deadline").start(() -> {
                try {
                    Thread.sleep(Duration.ofNanos(nanos));
                    expire();
                } catch (InterruptedException ignored) {
                    // 首增量已到达或调用已结束，取消计时。
                }
            });
        }
        private synchronized void expire() {
            if (finished) return;
            expired = true;
            target.interrupt();
            try {
                body.close();
            } catch (IOException ignored) {
                // 连接已关闭。
            }
        }

        @Override
        public synchronized void close() {
            finished = true;
            timer.interrupt();
        }
    }

    private String deltaText(JsonNode delta, String field) throws IOException {
        JsonNode value = delta.path(field);
        if (value.isMissingNode() || value.isNull()) return "";
        if (!value.isTextual()) throw new IOException("模型增量字段必须为字符串：" + field);
        return value.textValue();
    }

    private HttpRequest buildHttpRequest(ObjectNode jsonRequest, String accept, Duration timeout) throws IOException {
        return HttpRequest.newBuilder(apiUri)
                .timeout(timeout)
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
