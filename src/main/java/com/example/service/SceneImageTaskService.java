package com.example.service;

import java.io.IOException;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import jakarta.annotation.PreDestroy;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import com.example.config.ImageGenerationProperties;
import com.example.image.QwenImageClient;
import com.example.image.QwenImageClient.ServiceError;
import com.example.web.dto.DispatchDtos.ImageRef;
import com.example.web.dto.SceneImageDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;

/** 只保留短期任务与结果，浏览器断开不影响执行线程。 */
@Service
public class SceneImageTaskService {
    private static final Set<String> TERMINAL = Set.of("succeeded", "failed", "cancelled", "unknown");
    private final Map<String, Task> tasks = new LinkedHashMap<>();
    private final ImageGenerationProperties config;
    private final QwenImageClient client;
    private final ImageGenerationValidation validation;
    private final ImageCache cache;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final ScheduledExecutorService cleanup = Executors
            .newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().factory());
    private Task active;

    private static final class Task {
        final String runId, fingerprint, taskId = UUID.randomUUID().toString();
        String status = "running", errorCode, error;
        long revision = 1, finishedAt;
        byte[] result;
        CompletableFuture<TaskSnapshot> cancellation;
        int subscribers;
        ScheduledFuture<?> deadline;
        Task(String runId, String fingerprint) {
            this.runId = runId;
            this.fingerprint = fingerprint;
        }
        TaskSnapshot snapshot() {
            return new TaskSnapshot(runId, revision, status, errorCode, error, TERMINAL.contains(status));
        }
    }

    public SceneImageTaskService(ImageGenerationProperties config, QwenImageClient client,
            ImageGenerationValidation validation, ImageCache cache, ObjectMapper mapper, Clock clock) {
        this.config = config;
        this.client = client;
        this.validation = validation;
        this.cache = cache;
        this.mapper = mapper;
        this.clock = clock;
        cleanup.scheduleWithFixedDelay(this::cleanup, config.resultRetentionSeconds(), config.resultRetentionSeconds(),
                TimeUnit.SECONDS);
    }

    public synchronized TaskSnapshot start(GenerationRequest request) throws IOException {
        validation.validateRequest(request);
        if (config.apiToken().isBlank())
            throw new DispatchException(HttpStatus.SERVICE_UNAVAILABLE, "GENERATION_NOT_CONFIGURED", "未配置生图服务 Token");
        String fingerprint = ImageValidationService.sha256(mapper.writeValueAsBytes(request));
        Task previous = tasks.get(request.runId());
        if (previous != null) {
            if (!previous.fingerprint.equals(fingerprint))
                throw conflict("RUN_ID_CONFLICT", "相同任务 ID 的请求内容不同");
            return previous.snapshot();
        }
        cleanup();
        if (active != null)
            throw conflict("GENERATION_BUSY", "已有图片正在生成或取消，请等待结束");
        if (tasks.size() >= config.maxResults())
            throw conflict("GENERATION_RESULTS_FULL", "生图结果额度已满，请先取回结果");
        var lease = cache.pin(request.images().stream().map(i -> new ImageRef(i.assetId(), i.sha256())).toList());
        List<QwenImageClient.Image> images;
        try {
            images = lease.binaryImages(request.images().stream().map(InputImage::assetId).toList());
            validation.validateInputImages(images);
        } catch (RuntimeException e) {
            lease.close();
            throw e;
        }
        Task task = new Task(request.runId(), fingerprint);
        active = task;
        tasks.put(task.runId, task);
        var worker = Thread.ofVirtual().unstarted(() -> {
            byte[] output = null;
            String status, code = null, error = null;
            try (lease) {
                output = client.edit(task.taskId, request.plan().prompt(), images);
                try {
                    validation.validateOutput(output);
                } catch (IOException e) {
                    throw new ServiceError(502, "INVALID_OUTPUT", e.getMessage());
                }
                status = "succeeded";
            } catch (ServiceError e) {
                status = e.status() == 409 && "TASK_CANCELLED".equals(e.code()) ? "cancelled" : "failed";
                code = e.code();
                error = e.getMessage();
            } catch (java.net.http.HttpTimeoutException e) {
                status = "unknown";
                code = "GENERATION_TIMEOUT";
                error = "生图响应超时，结果未知：" + e.getMessage();
            } catch (Exception e) {
                status = "unknown";
                code = "GENERATION_RESULT_UNKNOWN";
                error = "生图响应未完整取得：" + e.getMessage();
            }
            synchronized (this) {
                task.result = "succeeded".equals(status) ? output : null;
                if (active == task)
                    active = null;
                complete(task, status, code, error);
            }
        });
        // 系统截止时间独立于聊天；用户 cancel 不触碰线程或连接。
        task.deadline = cleanup.schedule(worker::interrupt, config.taskTimeoutSeconds(), TimeUnit.SECONDS);
        worker.start();
        return task.snapshot();
    }

    private synchronized void complete(Task task, String status, String code, String error) {
        if (TERMINAL.contains(task.status))
            return;
        task.status = status;
        task.errorCode = code;
        task.error = error;
        task.finishedAt = clock.millis();
        task.deadline.cancel(false);
        task.revision++;
        notifyAll();
    }

    public synchronized TaskSnapshot snapshot(String runId) {
        return find(runId).snapshot();
    }

    public TaskSnapshot cancel(String runId) throws IOException, InterruptedException {
        CompletableFuture<TaskSnapshot> pending;
        synchronized (this) {
            Task task = find(runId);
            if (TERMINAL.contains(task.status) || task.status.equals("cancelling"))
                return task.snapshot();
            if (task.cancellation == null) {
                task.cancellation = new CompletableFuture<>();
                var completion = task.cancellation;
                Thread.startVirtualThread(() -> requestCancellation(task, completion));
            }
            pending = task.cancellation;
        }
        try {
            return pending.get();
        } catch (ExecutionException e) {
            if (e.getCause() instanceof IOException io)
                throw io;
            if (e.getCause() instanceof RuntimeException runtime)
                throw runtime;
            throw new IOException("取消请求失败", e.getCause());
        }
    }

    private void requestCancellation(Task task, CompletableFuture<TaskSnapshot> completion) {
        try {
            client.cancel(task.taskId);
            synchronized (this) {
                if (!TERMINAL.contains(task.status)) {
                    task.status = "cancelling";
                    task.revision++;
                    notifyAll();
                }
                completion.complete(task.snapshot());
            }
        } catch (Exception e) {
            synchronized (this) {
                if (TERMINAL.contains(task.status))
                    completion.complete(task.snapshot());
                else if (e instanceof ServiceError remote && remote.status() == 404
                        && "TASK_NOT_FOUND".equals(remote.code()))
                    completion.completeExceptionally(conflict("GENERATION_CANCEL_NOT_READY", "任务尚未就绪或已结束，可稍后再试"));
                else
                    completion.completeExceptionally(new DispatchException(HttpStatus.BAD_GATEWAY,
                            "GENERATION_CANCEL_FAILED", "停止请求失败，原生成继续：" + e.getMessage()));
                task.cancellation = null;
            }
        }
    }

    public synchronized byte[] result(String runId) {
        Task task = find(runId);
        if (!"succeeded".equals(task.status))
            throw conflict("GENERATION_NOT_SUCCEEDED", "任务尚无成功图片");
        return task.result;
    }

    public synchronized void acknowledge(String runId) {
        Task task = tasks.get(runId);
        if (task == null)
            return;
        if (!TERMINAL.contains(task.status))
            throw conflict("GENERATION_ACTIVE", "运行中的任务不能确认释放");
        tasks.remove(runId);
    }

    public synchronized SseEmitter subscribe(String runId) {
        Task task = find(runId);
        if (task.subscribers >= config.maxResults())
            throw conflict("TOO_MANY_SUBSCRIPTIONS", "生图任务订阅数量超限");
        task.subscribers++;
        var emitter = new SseEmitter(0L);
        var detached = new AtomicBoolean();
        Runnable detach = () -> {
            synchronized (this) {
                detached.set(true);
                notifyAll();
            }
        };
        emitter.onCompletion(detach);
        emitter.onTimeout(detach);
        emitter.onError(e -> detach.run());
        Thread.startVirtualThread(() -> {
            long revision = -1;
            try {
                while (!detached.get()) {
                    TaskSnapshot snapshot;
                    synchronized (this) {
                        if (revision == task.revision)
                            wait(15000);
                        snapshot = task.snapshot();
                    }
                    if (detached.get())
                        break;
                    if (revision != snapshot.revision()) {
                        emitter.send(SseEmitter.event().name("snapshot").data(snapshot));
                        revision = snapshot.revision();
                    } else
                        emitter.send(SseEmitter.event().comment("keepalive"));
                    if (snapshot.terminal()) {
                        emitter.complete();
                        break;
                    }
                }
            } catch (Exception e) {
                emitter.completeWithError(e);
            } finally {
                synchronized (this) {
                    task.subscribers--;
                }
            }
        });
        return emitter;
    }

    public synchronized void cleanup() {
        tasks.values().removeIf(t -> TERMINAL.contains(t.status)
                && clock.millis() - t.finishedAt >= config.resultRetentionSeconds() * 1000L);
    }

    private Task find(String runId) {
        Task task = tasks.get(runId);
        if (task == null)
            throw new DispatchException(HttpStatus.NOT_FOUND, "GENERATION_NOT_FOUND", "生图任务不存在或结果已过期");
        return task;
    }

    private static DispatchException conflict(String code, String message) {
        return new DispatchException(HttpStatus.CONFLICT, code, message);
    }

    @PreDestroy
    public void close() {
        cleanup.shutdownNow();
    }
}
