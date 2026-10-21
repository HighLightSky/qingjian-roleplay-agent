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
import java.util.ArrayList;
import java.util.List;
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
import com.example.llm.model.ChatStreamResult;
import com.example.llm.model.TokenUsage;
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

    @MockitoBean
    private com.example.service.LlamaTokenCounter counter;

    @org.junit.jupiter.api.BeforeEach
    void counts() throws Exception {
        org.mockito.Mockito.when(counter.count(any())).thenReturn(
                new com.example.web.dto.ContextDtos.TokenCount(100, "exact", "test", "fingerprint"));
    }

    @Test
    void streamsBeforeGenerationCompletesAndThenSendsDone() throws Exception {
        CountDownLatch continueGeneration = new CountDownLatch(1);
        doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("[台词]“你好。”");
            assertTrue(continueGeneration.await(5, TimeUnit.SECONDS));
            onText.accept("\n[描写]（她挥手。）");
            return new ChatStreamResult("stop", TokenUsage.unavailable());
        }).when(llmClient).chatStream(any(), any());

        try (HttpClient client = HttpClient.newHttpClient()) {
            HttpResponse<InputStream> response = client.send(request(validJson()), HttpResponse.BodyHandlers.ofInputStream());
            assertEquals(200, response.statusCode());
            assertTrue(response.headers().firstValue("Content-Type").orElseThrow().startsWith("text/event-stream"));
            assertEquals("no-store", response.headers().firstValue("Cache-Control").orElseThrow());
            assertEquals("no", response.headers().firstValue("X-Accel-Buffering").orElseThrow());
            try (BufferedReader reader = reader(response)) {
                // 模型尚未结束时已经能读到首个事件，证明没有缓冲整段回复。
                String contextEvent = readEvent(reader);
                assertTrue(contextEvent.contains("event:context"), contextEvent);
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
    void sendsModelErrorAfterContextWithUpstreamDetails() throws Exception {
        doAnswer(invocation -> { throw new IOException("模型接口返回 HTTP 503"); })
                .when(llmClient).chatStream(any(), any());
        HttpResponse<String> response = post(validJson());
        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("event:context"));
        assertTrue(response.body().contains("MODEL_ERROR"));
        assertTrue(response.body().contains("模型接口返回 HTTP 503"));
    }

    @Test
    void sendsTimeoutAfterContext() throws Exception {
        doAnswer(invocation -> { throw new HttpTimeoutException("upstream timed out"); })
                .when(llmClient).chatStream(any(), any());
        var response = post(validJson());
        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("MODEL_TIMEOUT"));
        assertTrue(response.body().contains("upstream timed out"));
    }

    @Test
    void sendsErrorInsteadOfDoneAfterPartialOutput() throws Exception {
        doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("[描写]部分内容");
            throw new IOException("模型事件流读取失败", new IOException("连接已重置"));
        }).when(llmClient).chatStream(any(), any());
        HttpResponse<String> response = post(validJson());
        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("event:delta"));
        assertTrue(response.body().contains("event:error"));
        assertTrue(response.body().contains("MODEL_ERROR"));
        assertFalse(response.body().contains("event:done"));
        assertTrue(response.body().contains("模型事件流读取失败"));
        assertTrue(response.body().contains("连接已重置"));
    }

    @Test
    void deadlineAfterContextSendsTimeoutAndInterruptsWorker() throws Exception {
        CountDownLatch stopped = new CountDownLatch(1);
        blockModel(false, stopped);
        var response = post(validJson());
        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("MODEL_TIMEOUT"));
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
                assertTrue(readEvent(reader).contains("event:context"));
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
                return new ChatStreamResult("stop", TokenUsage.unavailable());
            } finally {
                stopped.countDown();
            }
        }).when(llmClient).chatStream(any(), any());
    }

    @Test
    void rejectsMissingNullAndUnknownInteractionSettingsWithoutCallingModel() throws Exception {
        List<ObjectNode> invalid = new ArrayList<>();
        ObjectNode missing = (ObjectNode) objectMapper.readTree(validJson());
        missing.remove("interactionSettings");
        invalid.add(missing);
        ObjectNode nullSettings = (ObjectNode) objectMapper.readTree(validJson());
        nullSettings.putNull("interactionSettings");
        invalid.add(nullSettings);
        for (String field : List.of("replyLength", "narrativeMode")) {
            for (String value : new String[] {null, "unknown", "auto", "STANDARD", "", "1"}) {
                ObjectNode body = (ObjectNode) objectMapper.readTree(validJson());
                ((ObjectNode) body.get("interactionSettings")).put(field, value);
                invalid.add(body);
            }
            ObjectNode body = (ObjectNode) objectMapper.readTree(validJson());
            ((ObjectNode) body.get("interactionSettings")).remove(field);
            invalid.add(body);
        }
        for (ObjectNode body : invalid) {
            assertJsonError(post(body.toString()), 400, "BAD_REQUEST");
        }
        verifyNoInteractions(llmClient);
    }

    @Test
    void acceptsEverySettingsCombinationAndPassesItToThePrompt() throws Exception {
        doAnswer(invocation -> {
            com.example.llm.model.ChatRequest modelRequest = invocation.getArgument(0);
            String prompt = modelRequest.getMessages().getFirst().getContent();
            assertTrue(prompt.contains("【回复长度】"));
            assertTrue(prompt.contains("【叙事推进】"));
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("[台词]我来看看地图。\n[描写]她展开地图。");
            return new ChatStreamResult("stop", TokenUsage.unavailable());
        }).when(llmClient).chatStream(any(), any());
        for (String length : List.of("short", "standard", "detailed")) {
            for (String mode : List.of("interactive", "scene")) {
                ObjectNode body = (ObjectNode) objectMapper.readTree(validJson());
                ObjectNode settings = (ObjectNode) body.get("interactionSettings");
                settings.put("replyLength", length).put("narrativeMode", mode);
                HttpResponse<String> response = post(body.toString());
                assertEquals(200, response.statusCode());
                assertTrue(response.body().contains("event:done"));
                assertFalse(response.body().contains("event:error"));
            }
        }
    }

    @Test
    void validatesCharacterAtChatAndSelectionEntriesBeforeCallingModel() throws Exception {
        List<ObjectNode> invalid = new ArrayList<>();
        for (String field : List.of("name", "identity", "description")) {
            ObjectNode missing = (ObjectNode) objectMapper.readTree(validJson());
            ((ObjectNode) missing.get("character")).remove(field);
            invalid.add(missing);
            ObjectNode nullField = (ObjectNode) objectMapper.readTree(validJson());
            ((ObjectNode) nullField.get("character")).putNull(field);
            invalid.add(nullField);
            int length = switch (field) {
                case "name" -> 61;
                case "identity" -> 2001;
                default -> 8001;
            };
            ObjectNode oversized = (ObjectNode) objectMapper.readTree(validJson());
            ((ObjectNode) oversized.get("character")).put(field, "字".repeat(length));
            invalid.add(oversized);
        }
        ObjectNode blank = (ObjectNode) objectMapper.readTree(validJson());
        ((ObjectNode) blank.get("character")).put("name", " ");
        invalid.add(blank);
        try (HttpClient client = HttpClient.newHttpClient()) {
            for (String path : List.of("/api/chat", "/api/context/inspect")) {
                for (ObjectNode body : invalid) {
                    var response = client.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(body.toString())).build(),
                            HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                    assertJsonError(response, 400, "BAD_REQUEST");
                    assertTrue(response.body().contains("角色"));
                }
            }
        }
        verifyNoInteractions(llmClient);
    }

    @Test
    void acceptsNameOnlyAndExactCharacterLimits() throws Exception {
        doAnswer(invocation -> new ChatStreamResult("stop", TokenUsage.unavailable())).when(llmClient).chatStream(any(), any());
        for (boolean full : List.of(false, true)) {
            ObjectNode body = (ObjectNode) objectMapper.readTree(validJson());
            ((ObjectNode) body.get("character")).put("name", "名".repeat(full ? 60 : 1))
                    .put("identity", full ? "身".repeat(2000) : "")
                    .put("description", full ? "描".repeat(8000) : "");
            HttpResponse<String> response = post(body.toString());
            assertEquals(200, response.statusCode(), response.body());
            assertTrue(response.body().contains("event:done"));
        }
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
                {"character":{"profileVersion":1,"name":"林溪","identity":"老板","description":"好奇，说话简短，生活在山城。"},
                "operationId":"operation","state":{"sessionId":"session","characterId":"character","sessionVersion":0,"memoryVersion":0,"processedThroughSeq":0,
                "story":{"location":"","storyTime":"","characterState":"","userState":"","presentCharacters":[],"relationships":[],"items":[],"openThreads":[]},"memories":[],"goals":[]},"summary":{"text":"","throughSeq":0,"version":0},"history":[],"input":{"text":"你好"},
                "interactionSettings":{"replyLength":"standard","narrativeMode":"scene"}}
                """;
    }
}
