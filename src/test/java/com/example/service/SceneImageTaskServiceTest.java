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
    SceneImagePlanService plans;
    ImageGenerationValidation validation;
    MockMvc mvc;
    final ObjectMapper mapper = new ObjectMapper();
    final CountDownLatch received = new CountDownLatch(1), finish = new CountDownLatch(1);
    final AtomicInteger edits = new AtomicInteger(), cancels = new AtomicInteger();
    volatile int cancelStatus = 202;
    volatile boolean cancelled;
    volatile boolean successAfterCancel;
    final CountDownLatch controlEntered = new CountDownLatch(1);
    volatile CountDownLatch controlRelease = new CountDownLatch(0);
    volatile String taskId, multipart, token, cancelToken;
    volatile int generationPort, cancellationPort;
    byte[] png;

    @BeforeEach
    void setup() throws Exception {
        var bytes = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(32, 32, BufferedImage.TYPE_INT_RGB), "png", bytes);
        png = bytes.toByteArray();
        remote = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        remote.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        remote.createContext("/api/image/edit", this::handle);
        remote.start();
        var config = TestRequests.generation("http://127.0.0.1:" + remote.getAddress().getPort());
        plans = new SceneImagePlanService(mapper, TestRequests.vision(), config);
        validation = new ImageGenerationValidation(config, plans);
        cache = new ImageCache(TestRequests.dispatch(), TestRequests.vision(), Clock.systemUTC());
        cache.put(ImageValidationService.sha256(png), png);
        tasks = new SceneImageTaskService(config, new QwenImageClient(HttpClient.newHttpClient(), mapper, config),
                validation, cache, mapper, Clock.systemUTC());
        mvc = MockMvcBuilders.standaloneSetup(new SceneImageController(tasks, cache, config))
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
                multipart = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                received.countDown();
                if (!finish.await(10, TimeUnit.SECONDS))
                    throw new IOException("测试生成未被释放");
                if (cancelled && !successAfterCancel)
                    json(exchange, 409, "{\"error\":{\"code\":\"TASK_CANCELLED\",\"message\":\"任务已取消\"}}");
                else {
                    exchange.getResponseHeaders().set("Content-Type", "image/png");
                    exchange.sendResponseHeaders(200, png.length);
                    exchange.getResponseBody().write(png);
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
        String prompt = "[参考图说明]以 <image1> 为底图和人物身份参考，服装按主体段。\n[主体]林溪穿白裙坐在木椅上，微笑。\n[环境]室内窗边。\n[光线]午后自然光。\n[材质]棉布裙。\n[构图]半身。\n[风格]写实。\n[画面摘要]林溪穿白裙坐在室内木椅上微笑，午后自然光，写实半身像。";
        var ref = new Reference("img1", List.of("base", "identity"), "人物身份", hash, null);
        var target = Map.of("subject", "林溪", "outfit", "白裙", "pose", "坐姿微笑", "environment", "室内", "light", "午后",
                "material", "棉布", "composition", "半身", "style", "写实");
        var initial = new Plan("plan", "session", "assistant", 2, 1, 1, "scene", "", "new_scene", target, List.of(ref),
                prompt, SceneImagePromptAssembler.summary(prompt), "", "ready", null);
        var plan = new Plan(initial.id(), initial.sessionId(), initial.assistantMessageId(), initial.sourceSeq(),
                initial.sourceCheckpointVersion(), initial.profileVersion(), initial.sceneId(),
                initial.previousPlanId(), initial.continuity(), initial.target(), initial.referenceImages(),
                initial.prompt(), initial.summary(), plans.fingerprint(initial), initial.status(), null);
        return new GenerationRequest(UUID.randomUUID().toString(), plan, new CharacterDto("林溪", "", "", "img1", 1),
                List.of(new InputImage("img1", hash, hash)));
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
        assertTrue(multipart.contains("<image1>"));
        assertTrue(multipart.contains("林溪穿白裙"));
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
        var request = request();
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
    void untrustedPromptReferencesAndTruncatedPngAreRejected() throws Exception {
        var request = request();
        assertThrows(IllegalArgumentException.class,
                () -> plans.validatePrompt(request.plan().prompt().replace("<image1>", "<image2>"),
                        request.plan().referenceImages()));
        assertThrows(IOException.class, () -> validation.validateOutput(Arrays.copyOf(png, png.length - 8)));
        var input = request.images().getFirst();
        assertThrows(IllegalArgumentException.class,
                () -> tasks.start(new GenerationRequest(request.runId(), request.plan(), request.character(),
                        List.of(new InputImage(input.assetId(), "f".repeat(64), input.sourceSha256())))));
        assertEquals(0, edits.get());
    }
}
