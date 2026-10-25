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
    final AtomicInteger edits = new AtomicInteger(), cancels = new AtomicInteger();
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
        remote.start();
        var config = TestRequests.generation("http://127.0.0.1:" + remote.getAddress().getPort());
        validation = new ImageGenerationValidation(config, TestRequests.vision());
        cache = new ImageCache(TestRequests.dispatch(), TestRequests.vision(), Clock.systemUTC());
        cache.put(ImageValidationService.sha256(png), png);
        tasks = new SceneImageTaskService(config, new QwenImageClient(HttpClient.newHttpClient(), mapper, config),
                validation, cache, Clock.systemUTC());
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
                multipartBytes = exchange.getRequestBody().readAllBytes();
                multipart = new String(multipartBytes, StandardCharsets.UTF_8);
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
        return new GenerationRequest(UUID.randomUUID().toString(), new Source("plan", "session", "assistant", 2, 1),
                "参考 img1 的人物，林溪穿白裙坐在木椅上微笑。", 256, 512,
                List.of(new InputImage("img1", "人物身份", hash, hash, null)));
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
    void blackOnlyAlignedCanvasAndFreeTextWorkWithoutIdentityOrPreviousImage() throws Exception {
        var request = new GenerationRequest(UUID.randomUUID().toString(),
                new Source("plan", "session", "assistant", 2, 1), "李白站在瀑布旁，无需固定段落或图片编号。", 255, 511, List.of());
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
                new GenerationRequest(request.runId(), request.source(), "画面", Integer.MAX_VALUE, 512, List.of())));
        var input = request.referenceImages().getFirst();
        assertThrows(DispatchException.class,
                () -> tasks.start(new GenerationRequest(request.runId(), request.source(), request.prompt(), 256, 512,
                        List.of(new InputImage(input.assetId(), input.scope(), "f".repeat(64),
                                input.sourceSha256(), null)))));
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
                .start(new GenerationRequest(request.runId(), request.source(), request.prompt(), 256, 512, refs)));
        var submission = validation
                .validateRequest(new GenerationRequest(request.runId(), request.source(), "画面", 256, 512, List.of()));
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
                () -> tasks.start(new GenerationRequest(request.runId(), request.source(), "画面", 256, 512, refs)));
        assertEquals(0, edits.get());
        assertEquals(0, cache.stats(List.of(hash)).inUseImageCount());
    }

}
