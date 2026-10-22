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

import com.example.llm.model.ChatRequest;
import com.example.llm.model.ChatStreamResult;
import com.example.llm.model.Message;
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
            byte[] data = ("data: {\"choices\":[{\"delta\":{\"content\":\"[台\"}}]}\n\n"
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
            ChatStreamResult result = client(http, server).chatStream(request(), chunks::add);
            assertEquals("stop", result.finishReason());
            assertEquals(15L, result.usage().inputTokens());
            assertEquals(18L, result.usage().outputTokens());
            assertEquals(33L, result.usage().totalTokens());
            assertEquals(List.of("[台", "词]你好"), chunks);
            assertTrue(new ObjectMapper().readTree(requestBody.get()).path("stream").asBoolean());
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
                    Message.Part.text("什么颜色"), Message.Part.image("data:image/png;base64,test")))), 800, 0.0);
            assertEquals("红色", client(http, server).chat(request).getContent());
            var json = new ObjectMapper().readTree(sent.get());
            assertTrue(json.path("messages").get(0).path("content").isTextual());
            var content = json.path("messages").get(1).path("content");
            assertEquals("text", content.get(0).path("type").asText());
            assertEquals("image_url", content.get(1).path("type").asText());
            assertEquals("data:image/png;base64,test", content.get(1).path("image_url").path("url").asText());
        } finally { server.stop(0); }
    }

    @Test
    void perCallDeadlineClosesAStreamWhoseHeadersHaveAlreadyArrived() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var release = new CountDownLatch(1);
        var stopped = new CountDownLatch(1);
        var failure = new AtomicReference<Exception>();
        server.createContext("/chat", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (var body = exchange.getResponseBody()) {
                body.write("data: {\"choices\":[{\"delta\":{\"content\":\"部分内容\"}}]}\n\n".getBytes(StandardCharsets.UTF_8));
                body.flush();
                release.await();
            } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        });
        server.start();
        try (var http = HttpClient.newHttpClient()) {
            var mapper = new ObjectMapper();
            var llm = new com.example.config.LlmProperties("", "", "test", .8, 800, 1);
            var client = new OpenAiClient(http, mapper, "http://127.0.0.1:" + server.getAddress().getPort() + "/chat",
                    "test", Duration.ofMillis(300), new LlmRequestMapper(mapper, llm));
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

    private OpenAiClient client(HttpClient http, HttpServer server) {
        return new OpenAiClient(http, new ObjectMapper(),
                "http://127.0.0.1:" + server.getAddress().getPort() + "/chat",
                "test-key", Duration.ofSeconds(5), new LlmRequestMapper(new ObjectMapper(),
                new com.example.config.LlmProperties("", "", "test-model", .8, 800, 5)));
    }

    private ChatRequest request() {
        return new ChatRequest(List.of(new Message("user", "你好")), 800, 0.8);
    }
}
