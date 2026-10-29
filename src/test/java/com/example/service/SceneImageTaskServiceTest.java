package com.example.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.net.*;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.ImageIO;
import com.sun.net.httpserver.*;
import org.junit.jupiter.api.*;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import com.example.TestRequests;
import com.example.config.ImageGenerationProperties;
import com.example.image.QwenImageClient;
import com.example.web.*;
import com.example.web.dto.*;
import com.example.web.dto.SceneImageDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;

@Timeout(15)
class SceneImageTaskServiceTest {
    HttpServer remote;
    SceneImageTaskService tasks;
    ImageCache cache;
    ImageGenerationValidation validation;
    MockMvc mvc;
    final ObjectMapper mapper = new ObjectMapper();
    final CountDownLatch received = new CountDownLatch(1), finish = new CountDownLatch(1);
    final AtomicInteger edits = new AtomicInteger(), cancels = new AtomicInteger(), searches = new AtomicInteger(), readyChecks = new AtomicInteger();
    volatile int readyStatus = 200, searchStatus = 200, editStatus = 200;
    volatile String searchBody, searchToken;
    volatile String searchResponse = "{\"matches\":[]}";
    volatile String editContentType = "image/png";
    volatile byte[] editOutput;
    volatile int cancelStatus = 202;
    volatile boolean cancelled;
    volatile boolean successAfterCancel;
    final CountDownLatch controlEntered = new CountDownLatch(1);
    volatile CountDownLatch controlRelease = new CountDownLatch(0);
    volatile String taskId, multipart, token, cancelToken;
    volatile int generationPort, cancellationPort;
    byte[] png;
    volatile byte[] multipartBytes;

    @BeforeEach
    void setup() throws Exception {
        var bytes = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(32, 32, BufferedImage.TYPE_INT_RGB), "png", bytes);
        png = bytes.toByteArray();
        remote = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        remote.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        remote.createContext("/api/image/edit", this::handle);
        remote.createContext("/ready", exchange -> {
            readyChecks.incrementAndGet();
            assertEquals("Bearer test-token", exchange.getRequestHeaders().getFirst("Authorization"));
            json(exchange, readyStatus, readyStatus == 200 ? "{\"status\":\"ready\"}"
                    : "{\"error\":{\"code\":\"NOT_READY\",\"message\":\"模型尚未就绪\"},\"request_id\":\"ready-error\"}");
            exchange.close();
        });
        remote.createContext("/api/pose/search", exchange -> {
            searches.incrementAndGet();
            searchToken = exchange.getRequestHeaders().getFirst("Authorization");
            searchBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            json(exchange, searchStatus, searchResponse);
            exchange.close();
        });
        remote.start();
        var config = TestRequests.generation("http://127.0.0.1:" + remote.getAddress().getPort());
        var poses = new PoseValidation(config, mapper);
        validation = new ImageGenerationValidation(config, TestRequests.vision(), poses);
        cache = new ImageCache(TestRequests.dispatch(), TestRequests.vision(), Clock.systemUTC());
        cache.put(ImageValidationService.sha256(png), png);
        var client = new QwenImageClient(HttpClient.newHttpClient(), mapper, config);
        tasks = new SceneImageTaskService(config, client,
                validation, cache, Clock.systemUTC());
        mvc = MockMvcBuilders.standaloneSetup(new SceneImageController(tasks, cache, config, new PoseSearchService(client, poses, config)))
                .setControllerAdvice(new ApiExceptionHandler()).build();
    }

    void handle(HttpExchange exchange) throws IOException {
        try {
            if (exchange.getRequestURI().getPath().endsWith("/cancel")) {
                cancels.incrementAndGet();
                cancellationPort = exchange.getRemoteAddress().getPort();
                controlEntered.countDown();
                controlRelease.await(3, TimeUnit.SECONDS);
                cancelToken = exchange.getRequestHeaders().getFirst("Authorization");
                assertEquals("/api/image/edit/" + taskId + "/cancel", exchange.getRequestURI().getPath());
                if (cancelStatus == 202) {
                    cancelled = true;
                    json(exchange, 202, "{\"task_id\":\"" + taskId + "\",\"status\":\"cancelling\"}");
                } else
                    json(exchange, cancelStatus, "{\"error\":{\"code\":\"TASK_NOT_FOUND\",\"message\":\"尚未入队\"}}");
            } else {
                edits.incrementAndGet();
                generationPort = exchange.getRemoteAddress().getPort();
                taskId = exchange.getRequestHeaders().getFirst("X-Task-ID");
                token = exchange.getRequestHeaders().getFirst("Authorization");
                multipartBytes = exchange.getRequestBody().readAllBytes();
                multipart = new String(multipartBytes, StandardCharsets.UTF_8);
                received.countDown();
                if (!finish.await(10, TimeUnit.SECONDS))
                    throw new IOException("测试生成未被释放");
                if (cancelled && !successAfterCancel)
                    json(exchange, 409, "{\"error\":{\"code\":\"TASK_CANCELLED\",\"message\":\"任务已取消\"}}");
                else {
                    byte[] output = editOutput == null ? png : editOutput;
                    exchange.getResponseHeaders().set("Content-Type", editContentType);
                    exchange.sendResponseHeaders(editStatus, output.length);
                    exchange.getResponseBody().write(output);
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            exchange.close();
        }
    }

    void json(HttpExchange exchange, int status, String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    @AfterEach
    void close() {
        finish.countDown();
        tasks.close();
        remote.stop(0);
    }

    GenerationRequest request() {
        String hash = ImageValidationService.sha256(png);
        return new GenerationRequest(UUID.randomUUID().toString(), new Source("plan", "session", "assistant", 2, 1),
                "参考 img1 的人物，林溪穿白裙坐在木椅上微笑。", 256, 512,
                List.of(new InputImage("img1", "人物身份", hash, hash, null)), false, null, null, null);
    }

    TaskSnapshot terminal(String id) throws Exception {
        for (int i = 0; i < 300; i++) {
            var snapshot = tasks.snapshot(id);
            if (snapshot.terminal())
                return snapshot;
            Thread.sleep(10);
        }
        throw new AssertionError("任务未结束");
    }

    @Test
    void directGenerationKeepsOriginalPromptAndFirstImageAndSharesPermit() throws Exception {
        String hash = ImageValidationService.sha256(png);
        var request = new DirectGenerationRequest(UUID.randomUUID().toString(), "将<image1>背景改成蓝色。",
                List.of(new InputImage("img1", "编辑目标", hash, hash, null)));
        mvc.perform(post("/api/scene-images/direct").contentType("application/json")
                .content(mapper.writeValueAsBytes(request)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.submission.effectivePrompt").value(request.prompt()));
        assertTrue(received.await(3, TimeUnit.SECONDS));
        assertTrue(multipart.contains(request.prompt()));
        assertFalse(multipart.contains("纯黑画布"));
        assertFalse(multipart.contains("image2.png"));
        String wire = new String(multipartBytes, StandardCharsets.ISO_8859_1);
        int firstPng = wire.indexOf("\u0089PNG\r\n\u001a\n");
        var target = ImageIO.read(new ByteArrayInputStream(multipartBytes, firstPng, multipartBytes.length - firstPng));
        assertEquals(32, target.getWidth());
        assertEquals(32, target.getHeight());
        assertThrows(DispatchException.class, () -> tasks.start(request()));
        tasks.startDirect(request);
        assertEquals(1, edits.get());
        finish.countDown();
        assertEquals("succeeded", terminal(request.runId()).status());
        mvc.perform(get("/api/scene-images/" + request.runId() + "/result"))
                .andExpect(status().isOk()).andExpect(content().bytes(png));
        mvc.perform(post("/api/scene-images/" + request.runId() + "/ack")).andExpect(status().isOk());
    }

    @Test
    void directGenerationValidatesRequiredImagesCountAndPromptAtEntry() throws Exception {
        String hash = ImageValidationService.sha256(png);
        var reference = new InputImage("img1", "编辑目标", hash, hash, null);
        var requests = List.of(
                new DirectGenerationRequest("empty", "提示词", List.of()),
                new DirectGenerationRequest("blank", " ", List.of(reference)),
                new DirectGenerationRequest("long", "字".repeat(16385), List.of(reference)),
                new DirectGenerationRequest("many", "提示词", Collections.nCopies(11, reference)),
                new DirectGenerationRequest("duplicate", "提示词", List.of(reference, reference)));
        for (var request : requests)
            mvc.perform(post("/api/scene-images/direct").contentType("application/json")
                    .content(mapper.writeValueAsBytes(request))).andExpect(status().isBadRequest());
        assertEquals(0, edits.get());
    }

    @Test
    void explicitClickUploadsOrderedFilesOnceAndAckReleasesResult() throws Exception {
        var request = request();
        mvc.perform(
                post("/api/scene-images").contentType("application/json").content(mapper.writeValueAsBytes(request)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("running"));
        assertTrue(received.await(3, TimeUnit.SECONDS));
        UUID.fromString(taskId);
        assertEquals("Bearer test-token", token);
        assertTrue(multipart.contains("name=\"images\""));
        assertTrue(multipart.contains("name=\"prompt\""));
        assertTrue(multipart.contains("<image2>用于人物身份"));
        assertTrue(multipart.contains("纯黑画布"));
        assertTrue(multipart.contains("林溪穿白裙"));
        String wire = new String(multipartBytes, StandardCharsets.ISO_8859_1);
        int firstPng = wire.indexOf("\u0089PNG\r\n\u001a\n");
        assertTrue(firstPng > wire.indexOf("image1.png"));
        assertTrue(firstPng < wire.indexOf("image2.png"));
        var canvas = ImageIO.read(new ByteArrayInputStream(multipartBytes, firstPng, multipartBytes.length - firstPng));
        assertEquals(256, canvas.getWidth());
        assertEquals(512, canvas.getHeight());
        assertEquals(0xff000000, canvas.getRGB(128, 256));

        tasks.start(request);
        assertEquals(1, edits.get());
        finish.countDown();
        assertEquals("succeeded", terminal(request.runId()).status());
        mvc.perform(get("/api/scene-images/" + request.runId() + "/result")).andExpect(status().isOk())
                .andExpect(content().bytes(png));
        tasks.acknowledge(request.runId());
        tasks.acknowledge(request.runId());
        assertThrows(DispatchException.class, () -> tasks.snapshot(request.runId()));
    }

    @Test
    void acceptedCancellationKeepsOriginalRequestAndPermitUntil409() throws Exception {
        var request = posedRequest("坐姿");
        tasks.start(request);
        assertTrue(received.await(3, TimeUnit.SECONDS));
        mvc.perform(post("/api/scene-images/" + request.runId() + "/cancel")).andExpect(status().isAccepted());
        assertEquals(token, cancelToken);
        assertNotEquals(generationPort, cancellationPort);
        assertEquals("cancelling", tasks.snapshot(request.runId()).status());
        tasks.cancel(request.runId());
        assertEquals(1, cancels.get());
        assertThrows(DispatchException.class, () -> tasks.start(request()));
        assertEquals(1, cache.stats(List.of(ImageValidationService.sha256(png))).inUseImageCount());
        finish.countDown();
        assertEquals("cancelled", terminal(request.runId()).status());
        assertThrows(DispatchException.class, () -> tasks.result(request.runId()));
    }

    @Test
    void notEnqueuedCancellationDoesNotDisconnectOrAutoRetry() throws Exception {
        cancelStatus = 404;
        var request = request();
        tasks.start(request);
        assertTrue(received.await(3, TimeUnit.SECONDS));
        mvc.perform(post("/api/scene-images/" + request.runId() + "/cancel")).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("GENERATION_CANCEL_NOT_READY"));
        assertEquals("running", tasks.snapshot(request.runId()).status());
        assertEquals(1, cancels.get());
        finish.countDown();
        assertEquals("succeeded", terminal(request.runId()).status());
        assertArrayEquals(png, tasks.result(request.runId()));
    }

    @Test
    void failedOrTimedOutCancellationKeepsWaitingForOriginalSuccess() throws Exception {
        cancelStatus = 500;
        var request = request();
        tasks.start(request);
        assertTrue(received.await(3, TimeUnit.SECONDS));
        mvc.perform(post("/api/scene-images/" + request.runId() + "/cancel")).andExpect(status().isBadGateway())
                .andExpect(jsonPath("$.code").value("GENERATION_CANCEL_FAILED"));
        assertEquals("running", tasks.snapshot(request.runId()).status());
        controlRelease = new CountDownLatch(1);
        mvc.perform(post("/api/scene-images/" + request.runId() + "/cancel")).andExpect(status().isBadGateway())
                .andExpect(jsonPath("$.code").value("GENERATION_CANCEL_FAILED"));
        assertEquals("running", tasks.snapshot(request.runId()).status());
        assertThrows(DispatchException.class, () -> tasks.start(request()));
        controlRelease.countDown();
        finish.countDown();
        assertEquals("succeeded", terminal(request.runId()).status());
    }

    @Test
    void disconnectedSubscriptionDoesNotCancelGeneration() throws Exception {
        var request = request();
        tasks.start(request);
        assertTrue(received.await(3, TimeUnit.SECONDS));
        var emitter = tasks.subscribe(request.runId());
        emitter.complete();
        finish.countDown();
        assertEquals("succeeded", terminal(request.runId()).status());
        assertEquals(0, cancels.get());
    }

    @Test
    void duplicateCancellationSharesControlConnectionAndSuccessIsAuthoritative() throws Exception {
        successAfterCancel = true;
        controlRelease = new CountDownLatch(1);
        var request = request();
        tasks.start(request);
        assertTrue(received.await(3, TimeUnit.SECONDS));
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> tasks.cancel(request.runId()));
            assertTrue(controlEntered.await(1, TimeUnit.SECONDS));
            var second = executor.submit(() -> tasks.cancel(request.runId()));
            controlRelease.countDown();
            assertEquals("cancelling", first.get(2, TimeUnit.SECONDS).status());
            assertEquals("cancelling", second.get(2, TimeUnit.SECONDS).status());
            assertEquals(1, cancels.get());
            finish.countDown();
            assertEquals("succeeded", terminal(request.runId()).status());
            assertArrayEquals(png, tasks.result(request.runId()));
            assertEquals("succeeded", tasks.cancel(request.runId()).status());
        }
    }

    @Test
    void lateNotFoundControlResponseCannotOverwriteSuccess() throws Exception {
        cancelStatus = 404;
        controlRelease = new CountDownLatch(1);
        var request = request();
        tasks.start(request);
        assertTrue(received.await(3, TimeUnit.SECONDS));
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var control = executor.submit(() -> tasks.cancel(request.runId()));
            assertTrue(controlEntered.await(1, TimeUnit.SECONDS));
            finish.countDown();
            assertEquals("succeeded", terminal(request.runId()).status());
            controlRelease.countDown();
            assertEquals("succeeded", control.get(2, TimeUnit.SECONDS).status());
        }
    }

    @Test
    void blackOnlyAlignedCanvasAndFreeTextWorkWithoutIdentityOrPreviousImage() throws Exception {
        var request = new GenerationRequest(UUID.randomUUID().toString(),
                new Source("plan", "session", "assistant", 2, 1), "李白站在瀑布旁，无需固定段落或图片编号。", 255, 511, List.of(), false, null, null, null);
        var snapshot = tasks.start(request);
        assertEquals(256, snapshot.submission().width());
        assertEquals(512, snapshot.submission().height());
        assertTrue(received.await(3, TimeUnit.SECONDS));
        assertEquals(1, multipart.split("filename=", -1).length - 1);
        finish.countDown();
        assertEquals("succeeded", terminal(request.runId()).status());
    }

    @Test
    void inputLimitsAndCorruptPngStillFailAtBoundary() throws Exception {
        var request = request();
        assertThrows(IOException.class, () -> validation.validateOutput(Arrays.copyOf(png, png.length - 8)));
        assertThrows(IllegalArgumentException.class, () -> tasks.start(
                new GenerationRequest(request.runId(), request.source(), "画面", Integer.MAX_VALUE, 512, List.of(), false, null, null, null)));
        var input = request.referenceImages().getFirst();
        assertThrows(DispatchException.class,
                () -> tasks.start(new GenerationRequest(request.runId(), request.source(), request.prompt(), 256, 512,
                        List.of(new InputImage(input.assetId(), input.scope(), "f".repeat(64),
                                input.sourceSha256(), null)), false, null, null, null)));
        assertEquals(0, edits.get());
    }

    @Test
    void blackCanvasConsumesReferenceSlotAndPixelBudget() throws Exception {
        var refs = new ArrayList<InputImage>();
        String hash = ImageValidationService.sha256(png);
        for (int i = 1; i <= TestRequests.vision().getMaxImages(); i++)
            refs.add(new InputImage("img" + i, "参考", hash, hash, null));
        var request = request();
        assertThrows(IllegalArgumentException.class, () -> tasks
                .start(new GenerationRequest(request.runId(), request.source(), request.prompt(), 256, 512, refs, false, null, null, null)));
        var submission = validation
                .validateRequest(new GenerationRequest(request.runId(), request.source(), "画面", 256, 512, List.of(), false, null, null, null));
        var canvas = validation.blackCanvas(submission);
        var decoded = ImageIO.read(new ByteArrayInputStream(canvas.bytes()));
        assertEquals(256, decoded.getWidth());
        assertEquals(512, decoded.getHeight());
        assertFalse(decoded.getColorModel().hasAlpha());
        for (int y = 0; y < decoded.getHeight(); y++)
            for (int x = 0; x < decoded.getWidth(); x++)
                assertEquals(0xff000000, decoded.getRGB(x, y));
    }

    @Test
    void blackPixelsCountTowardActualTotalAndFailBeforeRemoteCall() throws Exception {
        var bytes = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(2048, 2048, BufferedImage.TYPE_INT_RGB), "png", bytes);
        String hash = ImageValidationService.sha256(bytes.toByteArray());
        cache.putGenerationInput(hash, bytes.toByteArray(), 16777216, 4194304);
        var refs = new ArrayList<InputImage>();
        for (int i = 1; i <= 4; i++)
            refs.add(new InputImage("img" + i, "人物", hash, hash, null));
        var request = request();
        assertThrows(IllegalArgumentException.class,
                () -> tasks.start(new GenerationRequest(request.runId(), request.source(), "画面", 256, 512, refs, false, null, null, null)));
        assertEquals(0, edits.get());
        assertEquals(0, cache.stats(List.of(hash)).inUseImageCount());
    }


    PoseSelection selection(String id) throws Exception {
        return new PoseSelection(id, 0.12, new PoseDescription("双手撑在身后，正面坐姿", "Sitting with hands behind"),
                mapper.readTree("""
                        {"schema_version":3,"active_character_id":"hero","activeTab":"pose1",
                        "characters":[{"id":"hero","poses":{"pose1":{"bones":{"leftArm":[1,2,3]}}}}],
                        "camera":{"position":[2,3,4],"zoom":1.5},"old_prompt":"保留但不使用"}
                        """));
    }

    GenerationRequest posedRequest(String id) throws Exception {
        var request = request();
        return new GenerationRequest(request.runId(), request.source(), "根据<image2>保留脸、发型与服装，草地日光。",
                257, 513, request.referenceImages(), true, "坐在地上，双手撑在身后", "img1", selection(id));
    }

    @Test
    void poseSearchChecksReadyAndReturnsCompleteCandidatesWithoutScoreThreshold() throws Exception {
        var pose = selection("seated");
        var wire = mapper.createObjectNode();
        var match = wire.putArray("matches").addObject();
        match.put("pose_id", pose.poseId()).put("score", pose.score());
        match.set("description", mapper.valueToTree(pose.description()));
        match.set("pose", pose.pose());
        searchResponse = wire.toString();
        var response = mvc.perform(post("/api/scene-images/poses/search").contentType("application/json")
                .content("{\"query\":\"坐姿，双手撑在身后\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.matches[0].poseId").value("seated"))
                .andExpect(jsonPath("$.matches[0].score").value(.12)).andReturn();
        var result = mapper.readTree(response.getResponse().getContentAsByteArray());
        assertEquals(pose.pose(), result.path("matches").get(0).get("pose"));
        assertEquals("Bearer test-token", searchToken);
        assertEquals(3, mapper.readTree(searchBody).path("top_k").asInt());
        assertEquals("坐姿，双手撑在身后", mapper.readTree(searchBody).path("query").asText());
        assertEquals(1, readyChecks.get());
        assertEquals(0, edits.get());
    }

    @Test
    void poseSearchErrorsRetainCodeAndRequestIdAndDoNotRetry() throws Exception {
        searchStatus = 429;
        searchResponse = "{\"error\":{\"code\":\"POSE_SEARCH_BUSY\",\"message\":\"检索繁忙\"},\"request_id\":\"search-123\"}";
        mvc.perform(post("/api/scene-images/poses/search").contentType("application/json")
                .content("{\"query\":\"站立\"}"))
                .andExpect(status().isTooManyRequests()).andExpect(jsonPath("$.code").value("POSE_SEARCH_BUSY"))
                .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("search-123")));
        assertEquals(1, searches.get());
        assertEquals(0, edits.get());
    }

    @Test
    void readinessFailurePreventsBothSearchAndGeneration() throws Exception {
        readyStatus = 503;
        mvc.perform(post("/api/scene-images/poses/search").contentType("application/json")
                .content("{\"query\":\"拳击\"}"))
                .andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("NOT_READY"));
        var request = posedRequest("boxing");
        tasks.start(request);
        assertEquals("failed", terminal(request.runId()).status());
        assertEquals("NOT_READY", tasks.snapshot(request.runId()).errorCode());
        assertEquals(0, searches.get());
        assertEquals(0, edits.get());
    }

    @Test
    void selectedPoseIsTextPartAndSnapshotsKeepCameraCharactersAndAlignedCanvas() throws Exception {
        var base = posedRequest("jump");
        var reference = base.referenceImages().getFirst();
        var request = new GenerationRequest(base.runId(), base.source(), base.prompt(), base.width(), base.height(),
                List.of(reference, new InputImage("img2", "服装参考", reference.sha256(), reference.sourceSha256(), null)),
                true, base.poseQuery(), "img1", base.poseSelection());
        var snapshot = tasks.start(request);
        assertTrue(received.await(3, TimeUnit.SECONDS));
        assertEquals(288, snapshot.submission().width());
        assertEquals(544, snapshot.submission().height());
        assertEquals(request.poseSelection(), snapshot.submission().poseSelection());
        assertTrue(multipart.contains("name=\"pose\"\r\n"));
        assertFalse(multipart.contains("filename=\"pose"));
        assertTrue(multipart.contains("image3.png"));
        String wire = new String(multipartBytes, StandardCharsets.ISO_8859_1);
        int firstPng = wire.indexOf("\u0089PNG\r\n\u001a\n");
        var canvas = ImageIO.read(new ByteArrayInputStream(multipartBytes, firstPng, multipartBytes.length - firstPng));
        assertEquals(288, canvas.getWidth());
        assertEquals(544, canvas.getHeight());
        assertTrue(multipart.contains(mapper.writeValueAsString(request.poseSelection().pose())));
        assertTrue(multipart.contains("image1>用于姿态参考"));
        assertFalse(multipart.contains("纯黑画布"));
        assertFalse(multipart.contains("Draw character from image2"));
        assertFalse(snapshot.submission().effectivePrompt().contains("坐在地上"));
        var exposed = (com.fasterxml.jackson.databind.node.ObjectNode) request.poseSelection().pose();
        exposed.remove("camera");
        assertTrue(snapshot.submission().poseSelection().pose().has("camera"));
        var reordered = mapper.createObjectNode();
        var original = request.poseSelection().pose();
        original.properties().stream().sorted(Map.Entry.<String, com.fasterxml.jackson.databind.JsonNode>comparingByKey().reversed())
                .forEach(entry -> reordered.set(entry.getKey(), entry.getValue()));
        var same = new GenerationRequest(request.runId(), request.source(), request.prompt(), request.width(), request.height(),
                request.referenceImages(), true, request.poseQuery(), "img1", new PoseSelection("jump", .12,
                request.poseSelection().description(), reordered));
        tasks.start(same);
        assertEquals(1, edits.get());
        var changed = new GenerationRequest(request.runId(), request.source(), request.prompt(), request.width(), request.height(),
                request.referenceImages(), true, request.poseQuery(), "img1", selection("other"));
        assertThrows(DispatchException.class, () -> tasks.start(changed));
        finish.countDown();
        assertEquals("succeeded", terminal(request.runId()).status());
    }

    @Test
    void poseRequestLimitsAndRequiredIdentityAreValidatedBeforeRemoteCalls() throws Exception {
        var request = posedRequest("sit");
        for (var invalid : List.of(
                new GenerationRequest(request.runId(), request.source(), request.prompt(), 256, 512,
                        request.referenceImages(), true, request.poseQuery(), "img9", request.poseSelection()),
                new GenerationRequest(request.runId(), request.source(), request.prompt(), 256, 512,
                        request.referenceImages(), true, request.poseQuery(), "img1", null),
                new GenerationRequest(request.runId(), request.source(), request.prompt(), 256, 512,
                        request.referenceImages(), false, request.poseQuery(), "img1", request.poseSelection()),
                new GenerationRequest(request.runId(), request.source(), request.prompt(), 256, 512,
                        request.referenceImages(), true, request.poseQuery(), "img1",
                        new PoseSelection("large", .5, request.poseSelection().description(),
                                mapper.createObjectNode().put("data", "字".repeat(400000)))))) {
            mvc.perform(post("/api/scene-images").contentType("application/json")
                    .content(mapper.writeValueAsBytes(invalid))).andExpect(status().isBadRequest());
        }
        mvc.perform(post("/api/scene-images/poses/search").contentType("application/json")
                .content(mapper.writeValueAsBytes(Map.of("query", "字".repeat(23000)))))
                .andExpect(status().isBadRequest());
        assertEquals(0, readyChecks.get());
        assertEquals(0, edits.get());
    }

    @Test
    void disabledPoseAddsActionToOrdinaryPromptWithoutPosePart() throws Exception {
        var base = request();
        var request = new GenerationRequest(base.runId(), base.source(), "保持参考人物外观，窗边日光。", 256, 512,
                base.referenceImages(), false, "人物站立，双手自然下垂。", null, null);
        tasks.start(request);
        assertTrue(received.await(3, TimeUnit.SECONDS));
        assertTrue(multipart.contains("姿态要求：人物站立，双手自然下垂。"));
        assertTrue(multipart.contains("纯黑画布"));
        assertFalse(multipart.contains("name=\"pose\""));
        finish.countDown();
        assertEquals("succeeded", terminal(request.runId()).status());
    }

    @Test
    void upstreamJsonErrorNeverBecomesPngOrTriggersResubmission() throws Exception {
        editStatus = 502;
        editContentType = "application/json";
        editOutput = "{\"error\":{\"code\":\"POSE_RENDER_FAILED\",\"message\":\"人偶渲染失败\"},\"request_id\":\"render-1\"}"
                .getBytes(StandardCharsets.UTF_8);
        var request = posedRequest("sit");
        tasks.start(request);
        finish.countDown();
        assertEquals("failed", terminal(request.runId()).status());
        assertEquals("POSE_RENDER_FAILED", tasks.snapshot(request.runId()).errorCode());
        assertTrue(tasks.snapshot(request.runId()).error().contains("render-1"));
        mvc.perform(get("/api/scene-images/" + request.runId() + "/result")).andExpect(status().isConflict());
        assertEquals(1, edits.get());
    }

}
