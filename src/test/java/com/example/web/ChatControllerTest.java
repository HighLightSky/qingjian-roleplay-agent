package com.example.web;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import com.example.TestRequests;
import com.example.llm.LLMClient;
import com.example.llm.model.*;
import com.example.service.*;
import com.example.web.dto.*;
import com.example.web.dto.DispatchDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"roleplay.llm.timeout-seconds=3", "roleplay.dispatch.task-timeout-seconds=4", "roleplay.dispatch.max-results=4", "logging.level.root=ERROR", "logging.level.com.example.service.SegmentStreamParser=WARN", "logging.level.com.example.service.ChatDispatchService=WARN"})
@Timeout(20)
@ExtendWith(OutputCaptureExtension.class)
class ChatControllerTest {
    @LocalServerPort int port;
    @Autowired ObjectMapper mapper;
    @Autowired ChatDispatchService dispatch;
    @MockitoBean LLMClient model;
    @MockitoBean LlamaTokenCounter counter;
    @MockitoBean Clock clock;
    final AtomicLong time = new AtomicLong(1000);
    final List<String> ids = new ArrayList<>();
    static final String EMPTY = "{\"visualObservations\":[],\"storyChanges\":[],\"memoryChanges\":[],\"goalChanges\":[]}";
    @BeforeEach void setup() throws Exception {
        when(clock.millis()).thenAnswer(i -> time.get());
        when(counter.count(any())).thenReturn(new ContextDtos.TokenCount(100, "exact", "test", "fp"));
        when(model.chat(any())).thenReturn(new ChatResponse(EMPTY, "stop", TokenUsage.unavailable()));
        doAnswer(i -> { Consumer<String> out = i.getArgument(1); out.accept("[台词]你好\n[描写]她挥手。");
            return new ChatStreamResult("stop", TokenUsage.unavailable()); }).when(model).chatStream(any(), any());
    }
    @AfterEach void cleanup() throws Exception {
        for (String id : ids) {
            try { dispatch.cancel(id); dispatch.acknowledge(id); } catch (DispatchException ignored) { }
        }
        ids.clear();
    }
    private Request request(String text) {
        String id = UUID.randomUUID().toString(); ids.add(id);
        var context = new ChatApiRequest(new CharacterDto("林溪", "", "", null, 1), TestRequests.state(List.of()),
                TestRequests.summary(), List.of(), new InputDto(text, null),
                new InteractionSettingsDto(InteractionSettingsDto.ReplyLength.STANDARD, InteractionSettingsDto.NarrativeMode.SCENE), null, id);
        return new Request(id, context, new MessageMeta("user-" + id, 1, "2026-10-22T00:00:00Z"),
                new MessageMeta("assistant-" + id, 2, "2026-10-22T00:00:01Z"), List.of());
    }
    private HttpRequest postRequest(String path, Object value) throws Exception {
        return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(value))).build();
    }
    private HttpResponse<String> post(String path, Object value) throws Exception {
        try (var client = HttpClient.newHttpClient()) { return client.send(postRequest(path, value), HttpResponse.BodyHandlers.ofString()); }
    }
    private String resume(String id) throws Exception {
        try (var client = HttpClient.newHttpClient()) {
            return client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/chat/" + id + "/events"))
                    .timeout(Duration.ofSeconds(10)).GET().build(), HttpResponse.BodyHandlers.ofString()).body();
        }
    }
    @Test void oneRequestRunsBodyAndStateAndAckDeletesOnlyAfterCompletion() throws Exception {
        var request = request("字".repeat(3000));
        var response = post("/api/chat", request);
        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("event:delta"));
        assertTrue(response.body().contains("event:body_done"));
        assertTrue(response.body().contains("event:state_result"));
        assertTrue(response.body().contains("event:done"));
        verify(model).chatStream(any(), any()); verify(model).chat(any());
        assertTrue(resume(request.runId()).contains("你好"));
        assertEquals(200, post("/api/chat/" + request.runId() + "/ack", Map.of()).statusCode());
        assertTrue(resume(request.runId()).contains("RESULT_EXPIRED"));
        assertEquals(200, post("/api/chat/" + request.runId() + "/ack", Map.of()).statusCode());
    }
    @Test void disconnectDoesNotCancelAndResubscribeDoesNotRestartTheModel() throws Exception {
        var release = new CountDownLatch(1); var started = new CountDownLatch(1);
        doAnswer(i -> { Consumer<String> out = i.getArgument(1); out.accept("[台词]先说\n"); started.countDown();
            release.await(); out.accept("[描写]然后继续。"); return new ChatStreamResult("stop", TokenUsage.unavailable());
        }).when(model).chatStream(any(), any());
        var request = request("继续");
        try (var client = HttpClient.newHttpClient()) {
            var response = client.send(postRequest("/api/chat", request), HttpResponse.BodyHandlers.ofInputStream());
            assertTrue(started.await(2, TimeUnit.SECONDS));
            response.body().close();
            assertEquals(409, post("/api/chat", request("另一个任务")).statusCode());
            release.countDown();
            assertTrue(resume(request.runId()).contains("然后继续"));
            verify(model).chatStream(any(), any());
            assertTrue(post("/api/chat", request).body().contains("然后继续"));
            verify(model).chatStream(any(), any());
        } finally { release.countDown(); }
    }
    @Test void failedStateKeepsBodyAndDoesNotBlockNextRequest(CapturedOutput logs) throws Exception {
        when(model.chat(any())).thenThrow(new IOException("整理连接失败"));
        var request = request("第一轮");
        String first = post("/api/chat", request).body();
        assertTrue(first.contains("body_done")); assertTrue(first.contains("整理连接失败"));
        assertTrue(logs.getAll().contains("后台生成失败：任务=" + request.runId() + "，阶段=state_update，异常类型=java.io.IOException"));
        assertTrue(post("/api/chat", request("第二轮")).body().contains("body_done"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"", " \n\t", "[台词]\n[描写] "})
    void emptyBodyWithStopReportsActualCauseAndSkipsStateUpdate(String content, CapturedOutput logs) throws Exception {
        doAnswer(i -> {
            Consumer<String> out = i.getArgument(1);
            out.accept(content);
            return new ChatStreamResult("stop", new TokenUsage("reported", 100L, 12L, 112L));
        }).when(model).chatStream(any(), any());
        var request = request("继续");
        String output = post("/api/chat", request).body();
        String lastEvent = output.lines().filter(line -> line.startsWith("data:"))
                .map(line -> line.substring(5)).toList().getLast();
        var terminal = mapper.readTree(lastEvent).path("value");
        assertTrue(terminal.path("terminal").asBoolean());
        assertEquals("failed", terminal.path("stages").path("body").path("status").asText());
        assertFalse(terminal.path("stages").has("state_update"));
        assertEquals("stop", terminal.path("body").path("finishReason").asText());
        assertEquals(12L, terminal.path("body").path("usage").path("outputTokens").asLong());
        String error = terminal.path("error").asText();
        assertTrue(error.contains("模型正常结束，但正文为空"), error);
        assertTrue(error.contains("finish_reason=stop"), error);
        assertTrue(error.contains("本次输出上限=8192 token"), error);
        assertTrue(error.contains("输入 token=100；输出 token=12；总 token=112"), error);
        assertTrue(error.contains("已返回正文=0 字符"), error);
        assertTrue(logs.getAll().contains("模型正常结束，但正文为空"));
        assertTrue(logs.getAll().contains("后台生成失败：任务=" + request.runId() + "，阶段=body，异常类型=java.io.IOException"));
        verify(model, never()).chat(any());
        assertTrue(resume(request.runId()).contains("正文为空"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"length", "content_filter"})
    void incompleteBodyPreservesPartialTextAndUnknownUsage(String finishReason, CapturedOutput logs) throws Exception {
        String content = "未完成的私密正文";
        doAnswer(i -> {
            Consumer<String> out = i.getArgument(1);
            out.accept("[描写]" + content);
            return new ChatStreamResult(finishReason, TokenUsage.unavailable());
        }).when(model).chatStream(any(), any());
        String output = post("/api/chat", request("继续")).body();
        assertTrue(output.contains(content));
        String expected = "length".equals(finishReason) ? "模型因长度限制停止生成" : "模型未正常结束";
        assertTrue(output.contains(expected), output);
        assertTrue(output.contains("finish_reason=" + finishReason), output);
        assertTrue(output.contains("token 用量=上游未提供"), output);
        assertTrue(output.contains("已返回正文=" + content.length() + " 字符"), output);
        assertTrue(logs.getAll().contains(expected));
        assertFalse(logs.getAll().contains(content));
        verify(model, never()).chat(any());
    }

    @Test void disconnectDuringStateUpdateRetainsResultForResubscription() throws Exception {
        var started = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        when(model.chat(any())).thenAnswer(i -> {
            started.countDown();
            release.await();
            return new ChatResponse(EMPTY, "stop", TokenUsage.unavailable());
        });
        var request = request("继续整理");
        try (var client = HttpClient.newHttpClient()) {
            var response = client.send(postRequest("/api/chat", request), HttpResponse.BodyHandlers.ofInputStream());
            assertTrue(started.await(2, TimeUnit.SECONDS));
            response.body().close();
            release.countDown();

            String resumed = resume(request.runId());
            String lastEvent = resumed.lines().filter(line -> line.startsWith("data:"))
                    .map(line -> line.substring(5)).toList().getLast();
            var terminal = mapper.readTree(lastEvent).path("value");
            assertTrue(terminal.path("terminal").asBoolean(), resumed);
            assertEquals("committed", terminal.path("stages").path("state_update").path("status").asText());
            assertEquals("state:" + request.assistant().id(), terminal.path("state").path("operationId").asText());
            assertTrue(terminal.path("error").isNull(), resumed);
            verify(model).chatStream(any(), any());
            verify(model).chat(any());
        } finally {
            release.countDown();
        }
    }
    @Test void resultReadsDoNotRenewRetentionAndCleanupReclaimsIt() throws Exception {
        var request = request("继续"); post("/api/chat", request);
        time.addAndGet(Duration.ofMinutes(119).toMillis());
        assertTrue(resume(request.runId()).contains("你好"));
        time.addAndGet(Duration.ofMinutes(1).toMillis()); dispatch.cleanup();
        assertTrue(resume(request.runId()).contains("RESULT_EXPIRED"));
    }
    @Test void explicitCancelInterruptsModelAndRetainsPartialResult(CapturedOutput logs) throws Exception {
        var started = new CountDownLatch(1); var interrupted = new CountDownLatch(1);
        doAnswer(i -> { Consumer<String> out = i.getArgument(1); out.accept("[台词]已有内容\n"); started.countDown();
            try { new CountDownLatch(1).await(); } finally { interrupted.countDown(); }
            return null;
        }).when(model).chatStream(any(), any());
        var request = request("继续");
        try (var client = HttpClient.newHttpClient()) {
            var response = client.send(postRequest("/api/chat", request), HttpResponse.BodyHandlers.ofInputStream());
            assertTrue(started.await(2, TimeUnit.SECONDS));
            assertEquals(200, post("/api/chat/" + request.runId() + "/cancel", Map.of()).statusCode());
            assertTrue(interrupted.await(1, TimeUnit.SECONDS));
            response.body().close();
            assertTrue(resume(request.runId()).contains("已有内容"));
            assertTrue(resume(request.runId()).contains("cancelled"));
            assertFalse(logs.getAll().contains("后台生成失败：任务=" + request.runId()));
        }
    }
    @Test void deadlineInterruptsWithoutDeletingPartialResult() throws Exception {
        doAnswer(i -> { Consumer<String> out = i.getArgument(1); out.accept("[台词]尚未结束\n"); new CountDownLatch(1).await(); return null; })
                .when(model).chatStream(any(), any());
        var request = request("继续");
        String output = post("/api/chat", request).body();
        assertTrue(output.contains("超时")); assertTrue(resume(request.runId()).contains("尚未结束"));
    }
    @Test void tokenCapacityIsCheckedBeforeGeneration() throws Exception {
        when(counter.count(any())).thenReturn(new ContextDtos.TokenCount(193024, "exact", "test", "fp"));
        String output = post("/api/chat", request("继续")).body();
        assertTrue(output.contains("超过窗口")); verify(model, never()).chatStream(any(), any());
    }
    @Test void cachedOriginalIsReadByBodyAndStateWithoutAnotherUpload() throws Exception {
        var bytes = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(new java.awt.image.BufferedImage(3, 2, java.awt.image.BufferedImage.TYPE_INT_RGB), "png", bytes);
        String hash = ImageValidationService.sha256(bytes.toByteArray());
        try (var client = HttpClient.newHttpClient()) {
            var upload = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/images/" + hash))
                    .PUT(HttpRequest.BodyPublishers.ofByteArray(bytes.toByteArray())).build();
            assertEquals(200, client.send(upload, HttpResponse.BodyHandlers.ofString()).statusCode());
        }
        assertTrue(post("/api/images/missing", Map.of("hashes", List.of(hash))).body().contains("[]"));
        var base = request("看图");
        var context = base.context();
        var visual = new VisualDtos.Context("session", List.of(), null, List.of());
        var input = new InputDto("看图", List.of(ContentPartDto.text("看图"), new ContentPartDto("image", null, "img1")));
        var imageRequest = new Request(base.runId(), new ChatApiRequest(context.character(), context.state(), context.summary(),
                context.history(), input, context.interactionSettings(), visual, context.operationId()), base.user(), base.assistant(), List.of(new ImageRef("img1", hash)));
        when(model.chat(any())).thenReturn(new ChatResponse(EMPTY.replace("\"visualObservations\":[]", "\"visualObservations\":[{\"assetId\":\"img1\",\"summary\":\"黑色图片\",\"visibleDetails\":[],\"extractedText\":[],\"uncertainDetails\":[]}]"), "stop", TokenUsage.unavailable()));
        String output = post("/api/chat", imageRequest).body();
        assertTrue(output.contains("event:state_result"), output);
        var bodyCall = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        var stateCall = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chatStream(bodyCall.capture(), any()); verify(model).chat(stateCall.capture());
        for (var call : List.of(bodyCall.getValue(), stateCall.getValue()))
            assertTrue(call.getMessages().stream().filter(m -> m.getParts() != null).flatMap(m -> m.getParts().stream())
                    .anyMatch(part -> "image_url".equals(part.type()) && part.imageUrl().contains(Base64.getEncoder().encodeToString(bytes.toByteArray()))));
        post("/api/chat/" + imageRequest.runId() + "/ack", Map.of());
        assertTrue(post("/api/images/missing", Map.of("hashes", List.of(hash))).body().contains("[]"));
    }
    @Test void resultCapacityRejectsNewTasksWithoutEvictingUnreadResults() throws Exception {
        var retained = new ArrayList<Request>();
        for (int i = 0; i < 4; i++) {
            var request = request("保留结果"); retained.add(request);
            assertEquals(200, post("/api/chat", request).statusCode());
        }
        assertEquals(507, post("/api/chat", request("超过数量")).statusCode());
        assertTrue(resume(retained.getFirst().runId()).contains("你好"));
        post("/api/chat/" + retained.getFirst().runId() + "/ack", Map.of());
        assertEquals(200, post("/api/chat", request("释放后继续")).statusCode());
    }

    @Test void missingRequiredFieldsFailBeforeAnyModelCall() throws Exception {
        var request = request("  ");
        assertEquals(400, post("/api/chat", request).statusCode());
        verifyNoInteractions(model);
    }
}
