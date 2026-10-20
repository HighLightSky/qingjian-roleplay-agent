package com.example.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.verifyNoInteractions;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import com.example.llm.LLMClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** 使用真实 HTTP 连接验证 SSE，而不调用外部模型服务。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"roleplay.llm.timeout-seconds=2", "logging.level.org.springframework=WARN"})
@Timeout(15)
class ChatControllerTest {
    @LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper objectMapper;

    @MockitoBean
    private LLMClient llmClient;

    @Test
    void streamsBeforeGenerationCompletesAndThenSendsDone() throws Exception {
        CountDownLatch continueGeneration = new CountDownLatch(1);
        doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("[台词]“你好。”");
            assertTrue(continueGeneration.await(5, TimeUnit.SECONDS));
            onText.accept("\n[描写]（她挥手。）");
            return "stop";
        }).when(llmClient).chatStream(any(), any());

        try (HttpClient client = HttpClient.newHttpClient()) {
            HttpResponse<InputStream> response = client.send(request(validJson()), HttpResponse.BodyHandlers.ofInputStream());
            assertEquals(200, response.statusCode());
            assertTrue(response.headers().firstValue("Content-Type").orElseThrow().startsWith("text/event-stream"));
            assertEquals("no-store", response.headers().firstValue("Cache-Control").orElseThrow());
            assertEquals("no", response.headers().firstValue("X-Accel-Buffering").orElseThrow());
            try (BufferedReader reader = reader(response)) {
                // 模型尚未结束时已经能读到首个事件，证明没有缓冲整段回复。
                String firstEvent = readEvent(reader);
                assertTrue(firstEvent.contains("event:delta"), firstEvent);
                assertTrue(firstEvent.contains("\"kind\":\"dialogue\""), firstEvent);
                continueGeneration.countDown();
                String remaining = readRemaining(reader);
                assertTrue(remaining.contains("\"kind\":\"narration\""), remaining);
                assertTrue(remaining.contains("event:done"), remaining);
                assertTrue(remaining.contains("\"finishReason\":\"stop\""), remaining);
                assertFalse(remaining.contains("event:error"), remaining);
            } finally {
                continueGeneration.countDown();
            }
        }
    }

    @Test
    void rejectsInvalidInputWithJsonEvenWhenAcceptingSse() throws Exception {
        ObjectNode blank = (ObjectNode) objectMapper.readTree(validJson());
        ((ObjectNode) blank.get("input")).put("text", "  ");
        ObjectNode invalidRole = (ObjectNode) objectMapper.readTree(validJson());
        invalidRole.withArray("history").addObject().put("role", "system").put("text", "不合法");
        ObjectNode oversized = (ObjectNode) objectMapper.readTree(validJson());
        ((ObjectNode) oversized.get("input")).put("text", "字".repeat(2001));

        for (String body : new String[] { blank.toString(), invalidRole.toString(), oversized.toString(), "{", "" }) {
            HttpResponse<String> response = post(body);
            assertJsonError(response, 400, "BAD_REQUEST");
        }
        verifyNoInteractions(llmClient);
    }

    @Test
    void returns502JsonBeforeFirstEventWithoutLeakingUpstreamDetails() throws Exception {
        doAnswer(invocation -> { throw new IOException("secret-api-key upstream body"); })
                .when(llmClient).chatStream(any(), any());
        HttpResponse<String> response = post(validJson());
        assertJsonError(response, 502, "MODEL_ERROR");
        assertFalse(response.body().contains("secret"));
    }

    @Test
    void returns504JsonForUpstreamTimeoutBeforeFirstEvent() throws Exception {
        doAnswer(invocation -> { throw new HttpTimeoutException("upstream timed out"); })
                .when(llmClient).chatStream(any(), any());
        assertJsonError(post(validJson()), 504, "MODEL_TIMEOUT");
    }

    @Test
    void sendsErrorInsteadOfDoneAfterPartialOutput() throws Exception {
        doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("[描写]部分内容");
            throw new IOException("upstream secret");
        }).when(llmClient).chatStream(any(), any());
        HttpResponse<String> response = post(validJson());
        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("event:delta"));
        assertTrue(response.body().contains("event:error"));
        assertTrue(response.body().contains("MODEL_ERROR"));
        assertFalse(response.body().contains("event:done"));
        assertFalse(response.body().contains("secret"));
    }

    @Test
    void deadlineBeforeFirstEventReturns504AndInterruptsWorker() throws Exception {
        CountDownLatch stopped = new CountDownLatch(1);
        blockModel(false, stopped);
        assertJsonError(post(validJson()), 504, "MODEL_TIMEOUT");
        assertTrue(stopped.await(3, TimeUnit.SECONDS));
    }

    @Test
    void deadlineAfterFirstEventSendsErrorAndInterruptsWorker() throws Exception {
        CountDownLatch stopped = new CountDownLatch(1);
        blockModel(true, stopped);
        HttpResponse<String> response = post(validJson());
        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("event:delta"));
        assertTrue(response.body().contains("event:error"));
        assertTrue(response.body().contains("MODEL_TIMEOUT"));
        assertFalse(response.body().contains("event:done"));
        assertTrue(stopped.await(3, TimeUnit.SECONDS));
    }

    @Test
    void closingClientConnectionStopsGeneration() throws Exception {
        CountDownLatch stopped = new CountDownLatch(1);
        doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            try {
                onText.accept("[台词]开始");
                while (true) {
                    Thread.sleep(20);
                    onText.accept("继续");
                }
            } finally {
                stopped.countDown();
            }
        }).when(llmClient).chatStream(any(), any());

        try (HttpClient client = HttpClient.newHttpClient()) {
            HttpResponse<InputStream> response = client.send(request(validJson()), HttpResponse.BodyHandlers.ofInputStream());
            try (BufferedReader reader = reader(response)) {
                assertTrue(readEvent(reader).contains("event:delta"));
            }
            assertTrue(stopped.await(1, TimeUnit.SECONDS), "连接断开后应停止生成，无需等待两秒截止时间");
        }
    }

    private void blockModel(boolean emitFirst, CountDownLatch stopped) throws Exception {
        doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            try {
                if (emitFirst) {
                    onText.accept("[台词]部分回复");
                }
                new CountDownLatch(1).await();
                return "stop";
            } finally {
                stopped.countDown();
            }
        }).when(llmClient).chatStream(any(), any());
    }

    private HttpResponse<String> post(String body) throws Exception {
        try (HttpClient client = HttpClient.newHttpClient()) {
            return client.send(request(body), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        }
    }

    private HttpRequest request(String body) {
        return HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/chat"))
                .timeout(Duration.ofSeconds(8))
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
    }

    private void assertJsonError(HttpResponse<String> response, int status, String code) throws Exception {
        assertEquals(status, response.statusCode(), response.body());
        assertTrue(response.headers().firstValue("Content-Type").orElseThrow().startsWith("application/json"));
        assertEquals(code, objectMapper.readTree(response.body()).path("code").asText());
    }

    private BufferedReader reader(HttpResponse<InputStream> response) {
        return new BufferedReader(new InputStreamReader(response.body(), StandardCharsets.UTF_8));
    }

    private String readEvent(BufferedReader reader) throws IOException {
        StringBuilder event = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null && !line.isEmpty()) {
            event.append(line).append('\n');
        }
        return event.toString();
    }

    private String readRemaining(BufferedReader reader) throws IOException {
        StringBuilder result = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            result.append(line).append('\n');
        }
        return result.toString();
    }

    private String validJson() {
        return """
                {"character":{"name":"林溪","description":"老板","personality":"好奇",
                "speakingStyle":"简短","worldSetting":"山城","openingScene":"雨夜"},
                "memories":[],"summary":"","history":[],"input":{"text":"你好"}}
                """;
    }
}
