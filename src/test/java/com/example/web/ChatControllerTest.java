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
import com.example.SelectionFixtures;
import org.junit.jupiter.params.provider.MethodSource;
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
    static final String EMPTY = "{\"visualObservations\":[],\"visualChanges\":[],\"storyChanges\":[],\"memoryChanges\":[],\"sceneImage\":{\"prompt\":\"人物坐在椅子上阅读。\",\"additionalReferences\":[]},\"goalChanges\":[]}";
    @BeforeEach void setup() throws Exception {
        when(clock.millis()).thenAnswer(i -> time.get());
        when(counter.countTextOnly(any())).thenReturn(new ContextDtos.TokenCount(100, "exact", "test", "fp"));
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
        return new Request(id, context, new MessageMeta("user-" + id, 1, "2026-10-22T00:00:00Z", 1),
                new MessageMeta("assistant-" + id, 2, "2026-10-22T00:00:01Z", 1), List.of());
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
        assertTrue(response.body().indexOf("event:body_done") < response.body().indexOf("event:state_result"));
        assertFalse(response.body().contains("image_prompt"));
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
        when(counter.countTextOnly(any())).thenReturn(new ContextDtos.TokenCount(100, "exact", "test", "fp"));
        when(counter.count(any())).thenReturn(new ContextDtos.TokenCount(193024, "exact", "test", "fp"));
        String output = post("/api/chat", request("继续")).body();
        assertTrue(output.contains("超过窗口")); verify(model, never()).chatStream(any(), any());
    }
    @Test void observedUploadRemainsInBodyButNormalAndManualStateDoNotObserveAgain() throws Exception {
        byte[] png = Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP2kAAAAASUVORK5CYII=");
        String hash = ImageValidationService.sha256(png);
        try (var client = HttpClient.newHttpClient()) {
            var upload = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/images/" + hash))
                    .PUT(HttpRequest.BodyPublishers.ofByteArray(png)).build();
            assertEquals(200, client.send(upload, HttpResponse.BodyHandlers.ofString()).statusCode());
        }
        var original = request("再看这张图");
        var sources = List.<VisualDtos.Source>of(new VisualDtos.CharacterPhotoSource("character", 1));
        var observation = new VisualDtos.Observation("img1", "人物照片", List.of(), List.of(), List.of(), sources, 4);
        var asset = new VisualDtos.Asset("img1", hash, "image/png", png.length, 1, 1, sources, observation, List.of(), hash);
        var context = new ChatApiRequest(new CharacterDto("林溪", "", "", "img1", 1), original.context().state(),
                original.context().summary(), List.of(), new InputDto("再看这张图", List.of(new ContentPartDto("image", null, "img1"))),
                original.context().interactionSettings(), new VisualDtos.Context("session", List.of(asset), null, List.of(), List.of()), original.context().operationId());
        var request = new Request(original.runId(), context, original.user(), original.assistant(), List.of(new ImageRef("img1", hash)));
        String response = post("/api/chat", request).body();
        assertTrue(response.contains("state_result"), response);
        var calls = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chat(calls.capture());
        assertTrue(calls.getValue().getMessages().stream().filter(m -> m.getParts() != null).flatMap(m -> m.getParts().stream()).noneMatch(part -> "image_url".equals(part.type())));
        var update = new StateDtos.UpdateRequest(context.operationId(), context, 0, 2, 1, List.of(
                new StateDtos.SourceMessage(request.user().id(), 1, "user", "再看这张图", "complete", request.user().createdAt()),
                new StateDtos.SourceMessage(request.assistant().id(), 2, "assistant", "你好", "complete", request.assistant().createdAt())));
        var retry = post("/api/state/update", new Retry(update, request.images()));
        assertEquals(200, retry.statusCode(), retry.body());
        assertEquals(0, mapper.readTree(retry.body()).path("visualObservations").size());
        assertEquals(4, observation.version());
    }

    @ParameterizedTest
    @ValueSource(ints = {10, 11})
    void configuredImageLimitReachesBodyAndStateAndRejectsExcess(int imageCount) throws Exception {
        var parts = new ArrayList<ContentPartDto>();
        var refs = new ArrayList<ImageRef>();
        var observations = mapper.createArrayNode();
        try (var client = HttpClient.newHttpClient()) {
            var capabilities = client.send(HttpRequest.newBuilder(
                    URI.create("http://127.0.0.1:" + port + "/api/capabilities")).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(10, mapper.readTree(capabilities.body()).path("maxImages").asInt());
            for (int index = 1; index <= imageCount; index++) {
                String assetId = "img" + index;
                var image = new java.awt.image.BufferedImage(3, 2, java.awt.image.BufferedImage.TYPE_INT_RGB);
                image.setRGB(0, 0, index);
                var bytes = new ByteArrayOutputStream();
                javax.imageio.ImageIO.write(image, "png", bytes);
                String hash = ImageValidationService.sha256(bytes.toByteArray());
                var upload = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/images/" + hash))
                        .PUT(HttpRequest.BodyPublishers.ofByteArray(bytes.toByteArray())).build();
                assertEquals(200, client.send(upload, HttpResponse.BodyHandlers.ofString()).statusCode());
                parts.add(new ContentPartDto("image", null, assetId));
                refs.add(new ImageRef(assetId, hash));
                var observation = observations.addObject().put("assetId", assetId).put("summary", "有色图片");
                observation.putArray("visibleDetails");
                observation.putArray("extractedText");
                observation.putArray("uncertainDetails");
            }
        }
        when(model.chat(any())).thenReturn(new ChatResponse(
                EMPTY.replace("\"visualObservations\":[]", "\"visualObservations\":" + observations),
                "stop", TokenUsage.unavailable()));
        var base = request("查看这些图片");
        var context = base.context();
        var visual = new VisualDtos.Context("session", List.of(), null, List.of(), List.of());
        var input = new InputDto("查看这些图片", parts);
        var imageRequest = new Request(base.runId(), new ChatApiRequest(context.character(), context.state(),
                context.summary(), context.history(), input, context.interactionSettings(), visual, context.operationId()),
                base.user(), base.assistant(), refs);
        var response = post("/api/chat", imageRequest);
        assertEquals(200, response.statusCode(), response.body());
        if (imageCount > 10) {
            assertTrue(response.body().contains("本轮图片数量超限"), response.body());
            verifyNoInteractions(model);
            return;
        }
        assertTrue(response.body().contains("event:state_result"), response.body());
        var body = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        var state = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chatStream(body.capture(), any());
        verify(model).chat(state.capture());
        for (var call : List.of(body.getValue(), state.getValue())) {
            assertEquals(10, call.getMessages().stream().filter(message -> message.getParts() != null)
                    .flatMap(message -> message.getParts().stream())
                    .filter(part -> "image_url".equals(part.type())).count());
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void cachedOriginalIsReadByBodyAndStateWithoutAnotherUpload(boolean includesCurrentMetadata) throws Exception {
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
        var missing = new VisualDtos.MissingAsset("img2",
                List.of(new VisualDtos.MessageSource("missing-user", 1, "旧图", 1, 1)), null);
        var history = List.of(new HistoryMessageDto("user", "旧图", "missing-user",
                List.of(ContentPartDto.text("旧图"), new ContentPartDto("image", null, "img2")), 1, "complete", 1));
        var currentAsset = new VisualDtos.Asset("img1", hash, "image/png", bytes.size(), 3, 2,
                List.of(new VisualDtos.MessageSource(base.user().id(), 3, "看图", 1, 2)), null, List.of(), hash);
        var visual = new VisualDtos.Context("session", includesCurrentMetadata ? List.of(currentAsset) : List.of(),
                null, List.of(), List.of(missing));
        var input = new InputDto("看图", List.of(ContentPartDto.text("看图"), new ContentPartDto("image", null, "img1")));
        var imageRequest = new Request(base.runId(), new ChatApiRequest(context.character(), context.state(), context.summary(),
                history, input, context.interactionSettings(), visual, context.operationId()),
                new MessageMeta(base.user().id(), 3, base.user().createdAt(), 1),
                new MessageMeta(base.assistant().id(), 4, base.assistant().createdAt(), 1), List.of(new ImageRef("img1", hash)));
        when(model.chat(any())).thenReturn(new ChatResponse(EMPTY.replace("\"visualObservations\":[]", "\"visualObservations\":[{\"assetId\":\"img1\",\"summary\":\"黑色图片\",\"visibleDetails\":[],\"extractedText\":[],\"uncertainDetails\":[]}]"), "stop", TokenUsage.unavailable()));
        String output = post("/api/chat", imageRequest).body();
        assertTrue(output.contains("event:state_result"), output);
        assertTrue(output.contains("\"uploadIndex\":2"), output);
        assertFalse(output.contains("\"uploadIndex\":3"), output);
        var bodyCall = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        var stateCall = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chatStream(bodyCall.capture(), any()); verify(model).chat(stateCall.capture());
        for (var call : List.of(bodyCall.getValue(), stateCall.getValue()))
            assertTrue(call.getMessages().stream().filter(m -> m.getParts() != null).flatMap(m -> m.getParts().stream())
                    .anyMatch(part -> "image_url".equals(part.type()) && part.imageUrl().contains(Base64.getEncoder().encodeToString(bytes.toByteArray()))));
        post("/api/chat/" + imageRequest.runId() + "/ack", Map.of());
        assertTrue(post("/api/images/missing", Map.of("hashes", List.of(hash))).body().contains("[]"));
    }
    @ParameterizedTest
    @MethodSource("com.example.SelectionFixtures#cases")
    void selectionNeverBlocksValidHistoryAndPhotoCombinations(SelectionFixtures.History history,
            SelectionFixtures.Photo photo) throws Exception {
        var scenario = SelectionFixtures.scenario(history, photo);
        try (var client = HttpClient.newHttpClient()) {
            for (var image : scenario.images()) {
                var upload = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/images/" + image.sha256()))
                        .PUT(HttpRequest.BodyPublishers.ofByteArray(Base64.getDecoder()
                                .decode(image.dataUrl().substring(image.dataUrl().indexOf(',') + 1)))).build();
                assertEquals(200, client.send(upload, HttpResponse.BodyHandlers.ofString()).statusCode());
            }
        }
        var base = request(scenario.context().input().textOf());
        var original = scenario.context();
        var context = new ChatApiRequest(original.character(), original.state(), original.summary(), original.history(),
                original.input(), original.interactionSettings(), original.visual(), base.runId());
        int seq = context.history().size();
        var request = new Request(base.runId(), context,
                new MessageMeta(base.user().id(), seq + 1, base.user().createdAt(), 1),
                new MessageMeta(base.assistant().id(), seq + 2, base.assistant().createdAt(), 1),
                scenario.images().stream().map(image -> new ImageRef(image.assetId(), image.sha256())).toList());
        when(model.chat(any())).thenAnswer(invocation -> {
            ChatRequest call = invocation.getArgument(0);
            assertNotNull(call.getResponseSchema());
            if (call.getResponseSchema().path("properties").has("selectedHistoricalImages")) {
                assertFalse(call.isThinkingEnabled());
                var response = mapper.createObjectNode().put("status", "ready").put("message", "");
                response.putArray("candidateAssetIds");
                var selected = response.putArray("selectedHistoricalImages");
                scenario.expectedSelected().forEach(id -> selected.addObject().put("assetId", id).put("purpose", "核对未辨清的细节"));
                return new ChatResponse(response.toString(), "stop", TokenUsage.unavailable());
            }
            assertTrue(call.isThinkingEnabled());
            String text = call.getMessages().get(1).getParts().getFirst().text();
            var data = mapper.readTree(text.substring(text.indexOf('{')));
            var visualSchema = call.getResponseSchema().path("properties").path("visualObservations");
            assertEquals(data.path("actualImageAssetIds").size(), visualSchema.path("minItems").asInt());
            assertEquals(data.path("actualImageAssetIds").size(), visualSchema.path("maxItems").asInt());
            if (!data.path("actualImageAssetIds").isEmpty()) {
                assertEquals(data.path("actualImageAssetIds"),
                        visualSchema.path("items").path("properties").path("assetId").path("enum"));
            }
            var observations = mapper.createArrayNode();
            for (var id : data.path("actualImageAssetIds")) {
                var observation = observations.addObject().put("assetId", id.asText()).put("summary", "图片可见颜色");
                observation.putArray("visibleDetails");
                observation.putArray("extractedText");
                observation.putArray("uncertainDetails");
            }
            return new ChatResponse(EMPTY.replace("\"visualObservations\":[]", "\"visualObservations\":" + observations),
                    "stop", TokenUsage.unavailable());
        });
        String output = post("/api/chat", request).body();
        assertTrue(output.contains("event:body_done"), output);
        assertTrue(output.contains("event:state_result"), output);
        assertFalse(output.contains("\"status\":\"failed\""), output);
        verify(model).chatStream(any(), any());
        verify(model, times(ImageValidationService.selectableCatalog(context).isEmpty() ? 1 : 2)).chat(any());
        post("/api/chat/" + request.runId() + "/ack", Map.of());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void missingHistoricalImagesAndPhotosAllowBodyAndState(boolean archived) throws Exception {
        var scenario = SelectionFixtures.scenario(SelectionFixtures.History.IMAGE, SelectionFixtures.Photo.OBSERVED);
        var original = scenario.context();
        var missing = original.visual().assetCatalog().stream()
                .map(a -> new VisualDtos.MissingAsset(a.assetId(), a.sources(), a.observation())).toList();
        var base = request("继续对话");
        var context = new ChatApiRequest(original.character(), original.state(),
                archived ? new ContextDtos.HistorySummary("曾看过 img1 的地图", 2, 1) : original.summary(),
                archived ? List.of() : original.history(), base.context().input(), original.interactionSettings(),
                new VisualDtos.Context("session", List.of(), null, List.of(), missing), base.runId());
        var request = new Request(base.runId(), context,
                new MessageMeta(base.user().id(), 3, base.user().createdAt(), 1),
                new MessageMeta(base.assistant().id(), 4, base.assistant().createdAt(), 1), List.of());
        var response = post("/api/chat", request);
        assertEquals(200, response.statusCode(), response.body());
        assertTrue(response.body().contains("event:state_result"), response.body());
        assertFalse(response.body().contains("\"status\":\"failed\""), response.body());
        var body = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        var state = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chatStream(body.capture(), any());
        verify(model).chat(state.capture());
        for (var call : List.of(body.getValue(), state.getValue())) {
            String material = mapper.writeValueAsString(call.getMessages());
            assertTrue(material.contains("原件缺失，已跳过，本次无法复核"), material);
            assertTrue(material.contains("地图上标出了码头"), material);
            assertFalse(material.contains("image_url"), material);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"undeclared", "overlap", "new", "source", "duplicate", "photo"})
    void invalidMissingImageReferencesFailBeforeCallingModel(String kind) throws Exception {
        var scenario = SelectionFixtures.scenario(SelectionFixtures.History.IMAGE, SelectionFixtures.Photo.NONE);
        var original = scenario.context();
        var asset = original.visual().assetCatalog().getFirst();
        var source = new VisualDtos.MessageSource("old-user", 1, "地图", 2, 1);
        var missing = new VisualDtos.MissingAsset(asset.assetId(),
                kind.equals("source") ? List.of(source) : asset.sources(), null);
        var base = request("继续");
        var context = new ChatApiRequest(
                kind.equals("photo") ? new CharacterDto("林溪", "", "", "img2", 1) : original.character(),
                original.state(), original.summary(), original.history(),
                kind.equals("new") ? new InputDto("新图", List.of(new ContentPartDto("image", null, "img1"))) : base.context().input(),
                original.interactionSettings(), new VisualDtos.Context("session",
                        kind.equals("overlap") ? List.of(asset) : List.of(), null, List.of(),
                        kind.equals("undeclared") ? List.of() : kind.equals("duplicate") ? List.of(missing, missing) : List.of(missing)), base.runId());
        var response = post("/api/chat", new Request(base.runId(), context,
                new MessageMeta(base.user().id(), 3, base.user().createdAt(), 1),
                new MessageMeta(base.assistant().id(), 4, base.assistant().createdAt(), 1), List.of()));
        assertEquals(400, response.statusCode(), response.body());
        verifyNoInteractions(model);
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
