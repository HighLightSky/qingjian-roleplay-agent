package com.example.llm;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import com.example.llm.model.ChatRequest;
import com.example.llm.model.ChatStreamResult;
import com.example.llm.model.Message;
import com.example.llm.model.StreamDelta;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;

/** 用本地模拟模型服务验证真实 HTTP 流读取，不访问配置中的外部服务。 */
@Timeout(10)
class OpenAiClientStreamTest {
    @Test
    void readsActualUpstreamSseAndFinishReason() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<String> requestBody = new AtomicReference<>();
        server.createContext("/chat", exchange -> {
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] data = ("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"先考虑角色状态\"}}]}\n\n"
                    + "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"，再回复\",\"content\":\"[台\"}}]}\n\n"
                    + "data: {\"choices\":[{\"delta\":{\"content\":\"词]你好\"}}]}\n\n"
                    + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                    + "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":15,\"completion_tokens\":18,\"total_tokens\":33,\"prompt_tokens_details\":{\"cached_tokens\":11}}}\n\n"
                    + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (var body = exchange.getResponseBody()) {
                body.write(data);
            }
        });
        server.start();
        try (HttpClient http = HttpClient.newHttpClient()) {
            List<String> chunks = new ArrayList<>();
            List<String> thoughts = new ArrayList<>();
            ChatStreamResult result = client(http, server).chatStream(request(), delta -> {
                if (!delta.content().isEmpty()) chunks.add(delta.content());
                if (!delta.reasoningContent().isEmpty()) thoughts.add(delta.reasoningContent());
            });
            assertEquals(List.of("先考虑角色状态", "，再回复"), thoughts);
            assertEquals("stop", result.finishReason());
            assertEquals(15L, result.usage().inputTokens());
            assertEquals(18L, result.usage().outputTokens());
            assertEquals(33L, result.usage().totalTokens());
            assertEquals(List.of("[台", "词]你好"), chunks);
            var sent = new ObjectMapper().readTree(requestBody.get());
            assertEquals("deepseek", sent.path("reasoning_format").asText());
            assertEquals(2048, sent.path("reasoning_budget_tokens").asInt());
            assertEquals(10272, sent.path("max_completion_tokens").asInt());
            assertTrue(sent.path("stream").asBoolean());
            assertTrue(new ObjectMapper().readTree(requestBody.get()).path("stream_options").path("include_usage").asBoolean());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void preservesLengthUsageAndDistinguishesUnknownUsageFromBrokenStreams() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<String> payload = new AtomicReference<>();
        server.createContext("/chat", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] bytes = payload.get().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, bytes.length);
            try (var body = exchange.getResponseBody()) { body.write(bytes); }
        });
        server.start();
        try (HttpClient http = HttpClient.newHttpClient()) {
            String finish = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n";
            String usage = "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":10,\"total_tokens\":30}}\n\n";
            payload.set(finish + usage + usage + "data: [DONE]\n\n");
            var result = client(http, server).chatStream(request(), text -> {});
            assertEquals("length", result.finishReason());
            assertEquals(30L, result.usage().totalTokens());
            payload.set(finish + "data: [DONE]\n\n");
            assertEquals("unavailable", client(http, server).chatStream(request(), text -> {}).usage().status());
            payload.set(finish + usage);
            assertThrows(IOException.class, () -> client(http, server).chatStream(request(), text -> {}));
        } finally { server.stop(0); }
    }

    @Test
    void interruptStopsBlockedHttpResponseBodyRead() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        CountDownLatch releaseServer = new CountDownLatch(1);
        CountDownLatch receivedText = new CountDownLatch(1);
        CountDownLatch workerStopped = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        server.createContext("/chat", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (var body = exchange.getResponseBody()) {
                body.write("data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n"
                        .getBytes(StandardCharsets.UTF_8));
                body.flush();
                releaseServer.await();
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
            }
        });
        server.start();
        try (HttpClient http = HttpClient.newHttpClient()) {
            OpenAiClient client = client(http, server);
            Thread worker = Thread.ofVirtual().start(() -> {
                try {
                    client.chatStream(request(), text -> receivedText.countDown());
                } catch (Exception exception) {
                    failure.set(exception);
                } finally {
                    workerStopped.countDown();
                }
            });
            try {
                assertTrue(receivedText.await(3, TimeUnit.SECONDS));
                // 此时上游仍保持连接且不再发数据，模拟生成期间的阻塞读取。
                worker.interrupt();
                assertTrue(workerStopped.await(3, TimeUnit.SECONDS));
                assertTrue(failure.get() instanceof IOException || failure.get() instanceof InterruptedException);
            } finally {
                worker.interrupt();
                releaseServer.countDown();
            }
        } finally {
            releaseServer.countDown();
            server.stop(0);
        }
    }

    @Test
    void serializesMultimodalBlocksInsteadOfPuttingBase64InText() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<String> sent = new AtomicReference<>();
        server.createContext("/chat", exchange -> {
            sent.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] data = "{\"choices\":[{\"message\":{\"content\":\"红色\"},\"finish_reason\":\"stop\"}]}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, data.length);
            try (var body = exchange.getResponseBody()) { body.write(data); }
        });
        server.start();
        try (HttpClient http = HttpClient.newHttpClient()) {
            var request = new ChatRequest(List.of(new Message("system", "看图"), new Message("user", List.of(
                    Message.Part.text("什么颜色"), Message.Part.image("data:image/png;base64,test")))), 800, 0.0, true);
            assertEquals("红色", client(http, server).chat(request).getContent());
            var json = new ObjectMapper().readTree(sent.get());
            assertTrue(json.path("chat_template_kwargs").path("enable_thinking").asBoolean());
            assertEquals(false, json.has("response_format"));
            assertTrue(json.path("messages").get(0).path("content").isTextual());
            var content = json.path("messages").get(1).path("content");
            assertEquals("text", content.get(0).path("type").asText());
            assertEquals("image_url", content.get(1).path("type").asText());
            assertEquals("data:image/png;base64,test", content.get(1).path("image_url").path("url").asText());
        } finally { server.stop(0); }
    }

    @Test
    void sendsStrictResponseSchemaToTheActualHttpEndpoint() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<String> sent = new AtomicReference<>();
        server.createContext("/chat", exchange -> {
            sent.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] data = "{\"choices\":[{\"message\":{\"content\":\"{\\\"answer\\\":\\\"img1\\\"}\"},\"finish_reason\":\"stop\"}]}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, data.length);
            try (var body = exchange.getResponseBody()) { body.write(data); }
        });
        server.start();
        try (HttpClient http = HttpClient.newHttpClient()) {
            var mapper = new ObjectMapper();
            var request = new ChatRequest(List.of(new Message("user", "请选择图片")), 800, 0.0, false);
            request.setResponseSchema(mapper.readTree("{\"type\":\"object\",\"properties\":{\"answer\":{\"type\":\"string\"}},\"required\":[\"answer\"],\"additionalProperties\":false}"));
            assertEquals("img1", mapper.readTree(client(http, server).chat(request).getContent()).path("answer").asText());
            var json = mapper.readTree(sent.get());
            assertEquals("json_schema", json.path("response_format").path("type").asText());
            assertTrue(json.path("response_format").path("json_schema").path("strict").asBoolean());
            assertEquals(request.getResponseSchema(), json.path("response_format").path("json_schema").path("schema"));
            assertEquals(false, json.path("chat_template_kwargs").path("enable_thinking").asBoolean());
        } finally { server.stop(0); }
    }

    @Test
    void firstTokenDeadlineIgnoresEmptyEventsAfterHeadersArrive() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var release = new CountDownLatch(1);
        var stopped = new CountDownLatch(1);
        var failure = new AtomicReference<Exception>();
        server.createContext("/chat", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (var body = exchange.getResponseBody()) {
                body.write((": keepalive\n\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\",\"reasoning_content\":null}}]}\n\n").getBytes(StandardCharsets.UTF_8));
                body.flush();
                release.await();
            } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        });
        server.start();
        try (var http = HttpClient.newHttpClient()) {
            var mapper = new ObjectMapper();
            var llm = new com.example.config.LlmProperties("", "", "test", .8, 800, 1, 60, 2048, 32);
            var client = new OpenAiClient(http, mapper, "http://127.0.0.1:" + server.getAddress().getPort() + "/chat",
                    "test", Duration.ofSeconds(5), Duration.ofMillis(300), new LlmRequestMapper(mapper, llm));
            Thread worker = Thread.ofVirtual().start(() -> {
                try { client.chatStream(request(), ignored -> {}); }
                catch (Exception e) { failure.set(e); }
                finally { stopped.countDown(); }
            });
            try {
                assertTrue(stopped.await(3, TimeUnit.SECONDS));
                assertTrue(failure.get() instanceof java.net.http.HttpTimeoutException, String.valueOf(failure.get()));
            } finally { worker.interrupt(); release.countDown(); }
        } finally { release.countDown(); server.stop(0); }
    }

    @ParameterizedTest
    @ValueSource(strings = {"content", "reasoning_content"})
    void firstRealDeltaCancelsAllStreamTiming(String field) throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/chat", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(200, 0);
            try (var body = exchange.getResponseBody()) {
                body.write(("data: {\"choices\":[{\"delta\":{\"" + field + "\":\"开始\"}}]}\n\n")
                        .getBytes(StandardCharsets.UTF_8));
                body.flush();
                Thread.sleep(800);
                body.write(("data: {\"choices\":[{\"delta\":{\"content\":\"正文\"},\"finish_reason\":\"stop\"}]}\n\n"
                        + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8));
            } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        });
        server.start();
        try (var http = HttpClient.newHttpClient()) {
            var mapper = new ObjectMapper();
            var properties = new com.example.config.LlmProperties("", "", "test", .8, 8192, 120, 60, 2048, 32);
            var client = new OpenAiClient(http, mapper, "http://127.0.0.1:" + server.getAddress().getPort() + "/chat",
                    "test", Duration.ofMillis(100), Duration.ofMillis(500), new LlmRequestMapper(mapper, properties));
            var deltas = new ArrayList<StreamDelta>();
            assertEquals("stop", client.chatStream(request(), deltas::add).finishReason());
            assertEquals(2, deltas.size());
            assertEquals("正文", deltas.getLast().content());
            assertEquals(field.equals("reasoning_content") ? "开始" : "", deltas.getFirst().reasoningContent());
        } finally { server.stop(0); }
    }

    @Test
    void firstTokenTimeoutIncludesWaitingForHeaders() throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var release = new CountDownLatch(1);
        server.createContext("/chat", exchange -> {
            exchange.getRequestBody().readAllBytes();
            try { release.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            exchange.close();
        });
        server.start();
        try (var http = HttpClient.newHttpClient()) {
            var mapper = new ObjectMapper();
            var properties = new com.example.config.LlmProperties("", "", "test", .8, 8192, 120, 60, 2048, 32);
            var client = new OpenAiClient(http, mapper, "http://127.0.0.1:" + server.getAddress().getPort() + "/chat",
                    "test", Duration.ofSeconds(5), Duration.ofMillis(300), new LlmRequestMapper(mapper, properties));
            var error = assertThrows(java.net.http.HttpTimeoutException.class,
                    () -> client.chatStream(request(), delta -> {}));
            assertTrue(error.getMessage().contains("首增量"));
        } finally { release.countDown(); server.stop(0); }
    }

    @Test
    void nonStreamingCallUsesItsOwnTimeoutOverride() throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/chat", exchange -> {
            exchange.getRequestBody().readAllBytes();
            try { Thread.sleep(300); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            byte[] bytes = "{\"choices\":[{\"message\":{\"content\":\"整理完成\"},\"finish_reason\":\"stop\"}]}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, bytes.length);
            try (var body = exchange.getResponseBody()) { body.write(bytes); }
        });
        server.start();
        try (var http = HttpClient.newHttpClient()) {
            var mapper = new ObjectMapper();
            var properties = new com.example.config.LlmProperties("", "", "test", .8, 8192, 120, 60, 2048, 32);
            var client = new OpenAiClient(http, mapper, "http://127.0.0.1:" + server.getAddress().getPort() + "/chat",
                    "test", Duration.ofMillis(100), Duration.ofSeconds(5), new LlmRequestMapper(mapper, properties));
            var request = request();
            request.setTimeout(Duration.ofSeconds(2));
            assertEquals("整理完成", client.chat(request).getContent());
        } finally { server.stop(0); }
    }

    private OpenAiClient client(HttpClient http, HttpServer server) {
        return new OpenAiClient(http, new ObjectMapper(),
                "http://127.0.0.1:" + server.getAddress().getPort() + "/chat",
                "test-key", Duration.ofSeconds(5), Duration.ofSeconds(5), new LlmRequestMapper(new ObjectMapper(),
                new com.example.config.LlmProperties("", "", "test-model", .8, 800, 5, 60, 2048, 32)));
    }

    private ChatRequest request() {
        var request = new ChatRequest(List.of(new Message("user", "你好")), 10272, 0.8, true);
        request.setReasoningBudgetTokens(2048);
        return request;
    }
}
