package com.example.service;

import java.io.IOException;
import java.net.http.HttpTimeoutException;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.*;
import jakarta.annotation.PreDestroy;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import com.example.config.DispatchProperties;
import com.example.config.LlmProperties;
import com.example.llm.model.ChatStreamResult;
import com.example.web.dto.*;
import com.example.web.dto.DispatchDtos.*;
import com.example.web.dto.StateDtos.*;
import com.example.web.dto.VisualDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;

/** 任务拥有模型调用，HTTP 连接只是可替换的订阅者。 */
@Service
public class ChatDispatchService {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(ChatDispatchService.class);
    private final Map<String, Task> tasks = new HashMap<>();
    private final DispatchProperties config;
    private final Clock clock;
    private final ObjectMapper mapper;
    private final ImageCache cache;
    private final ModelGate gate;
    private final ChatService chat;
    private final VisualSelectionService selection;
    private final StateUpdateService state;
    private final ScheduledThreadPoolExecutor scheduler = new ScheduledThreadPoolExecutor(1,
            Thread.ofPlatform().daemon().name("dispatch-cleanup").factory());

    public ChatDispatchService(DispatchProperties config, Clock clock, ObjectMapper mapper,
            ImageCache cache, ModelGate gate, ChatService chat, VisualSelectionService selection,
            StateUpdateService state) {
        this.config = config;

        this.clock = clock;
        this.mapper = mapper;
        this.cache = cache;
        this.gate = gate;
        this.chat = chat;
        this.selection = selection;
        this.state = state;
        scheduler.setRemoveOnCancelPolicy(true);
        scheduler.scheduleWithFixedDelay(this::cleanup, config.cleanupSeconds(), config.cleanupSeconds(),
                TimeUnit.SECONDS);
    }

    public synchronized SseEmitter start(Request request) {
        StateValidation.id(request.runId());
        cleanup();
        Task existing = tasks.get(request.runId());
        if (existing != null)
            return existing.subscribe();
        if (tasks.size() >= config.maxResults())
            throw new DispatchException(HttpStatus.INSUFFICIENT_STORAGE, "RESULT_BUFFER_FULL", "未确认结果缓存已满，请先取回结果");
        chat.validateRequest(request.context());
        validateMeta(request.user());
        validateMeta(request.assistant());
        if (request.assistant().seq() <= request.user().seq()
                || request.context().history().stream().anyMatch(m -> m.seq() >= request.user().seq()))
            throw new IllegalArgumentException("本轮消息序号必须位于历史之后");
        if (request.context().visual() != null && (request.context().visual().plan() != null
                || !request.context().visual().imagePayloads().isEmpty()))
            throw new IllegalArgumentException("生成请求只接受缓存引用，不接受选图计划或原图载荷");
        Set<String> expected = new HashSet<>(ImageValidationService.newIds(request.context()));
        ImageValidationService.catalog(request.context()).forEach(a -> expected.add(a.assetId()));
        if (!expected.equals(new HashSet<>(request.images().stream().map(ImageRef::assetId).toList())))
            throw new IllegalArgumentException("缓存引用必须完整覆盖本轮图片与候选目录");
        var permit = gate.acquire();
        ImageCache.Lease images;
        try {
            images = cache.pin(request.images());
        } catch (RuntimeException e) {
            permit.close();
            throw e;
        }
        try {
            images.validateCatalog(request.context());
        } catch (RuntimeException e) {
            images.close();
            permit.close();
            throw e;
        }
        Task task = new Task(request.runId());
        tasks.put(request.runId(), task);
        SseEmitter emitter = task.subscribe();
        task.worker = Thread.ofVirtual().name("chat-" + request.runId()).unstarted(() -> {
            task.cancellation = UpstreamCancellation.install();
            try (permit; images) {
                task.execute(request, images);
            } finally {
                UpstreamCancellation.clear();
                task.finish();
            }
        });
        task.deadline = scheduler.schedule(() -> task.cancel("后台生成超时：超过全流程时间限制"),
                config.taskTimeoutSeconds(), TimeUnit.SECONDS);
        task.worker.start();
        return emitter;
    }

    public synchronized SseEmitter subscribe(String runId) {
        return require(runId).subscribe();
    }

    public void cancel(String runId) {
        Task task;
        synchronized (this) {
            task = require(runId);
        }
        Thread worker = task.worker;
        task.cancel("已停止，保留已收到的内容。");
        try {
            if (worker != null)
                worker.join();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("取消等待被中断", e);
        }
    }

    public synchronized void acknowledge(String runId) {
        Task task = tasks.get(runId);
        if (task == null)
            return;
        synchronized (task) {
            if (!task.terminal)
                throw new DispatchException(HttpStatus.CONFLICT, "TASK_RUNNING", "任务仍在运行，不能确认删除");
        }
        tasks.remove(runId);
    }

    private Task require(String id) {
        cleanup();
        Task task = tasks.get(id);
        if (task == null)
            throw new DispatchException(HttpStatus.NOT_FOUND, "RESULT_EXPIRED", "任务不存在或结果已过期，已保留本地检查点");
        return task;
    }

    public synchronized void cleanup() {
        tasks.values().removeIf(task -> {
            synchronized (task) {
                return task.terminal && clock.millis() - task.finishedAt >= config.resultRetentionSeconds() * 1000L;
            }
        });
        cache.cleanup();
    }

    @PreDestroy
    public void close() {
        List<Task> active;
        synchronized (this) {
            active = List.copyOf(tasks.values());
        }
        active.forEach(t -> t.cancel("后端正在停止"));
        scheduler.shutdownNow();
    }

    private static void validateMeta(MessageMeta meta) {
        if (meta == null || meta.seq() < 1)
            throw new IllegalArgumentException("本轮消息元数据缺失或无效");
        StateValidation.id(meta.id());
        StateValidation.date(meta.createdAt());
    }

    public static ChatApiRequest withImages(ChatApiRequest context, Plan plan, List<Payload> payloads) {
        return new ChatApiRequest(context.character(), context.state(), context.summary(), context.history(),
                context.input(), context.interactionSettings(), new Context(context.state().sessionId(),
                        ImageValidationService.catalog(context), plan, payloads),
                context.operationId());
    }

    private final class Task {
        final String id;
        final List<SegmentDelta> segments = new ArrayList<>();
        final Map<String, Stage> stages = new LinkedHashMap<>();
        final List<Subscription> subscribers = new ArrayList<>();
        long revision, finishedAt;
        boolean terminal, cancelled;
        String error;
        ContextDtos.ContextBudget budget;
        Plan plan;
        ChatStreamResult body;
        Result result;
        volatile Thread worker;
        volatile UpstreamCancellation cancellation;
        ScheduledFuture<?> deadline;

        Task(String id) {
            this.id = id;
        }

        synchronized DispatchDtos.Snapshot snapshot() {
            return new DispatchDtos.Snapshot(id, revision, List.copyOf(segments), Map.copyOf(stages), budget, plan,
                    body, result, terminal, error);
        }

        synchronized SseEmitter subscribe() {
            Subscription subscription = new Subscription();
            subscription.offer("snapshot", snapshot());
            if (terminal)
                subscription.offer("done", new Event(revision, snapshot()));
            else
                subscribers.add(subscription);
            subscription.start();
            return subscription.emitter;
        }

        synchronized void emit(String name, Object value) {
            revision++;
            subscribers.removeIf(s -> !s.offer(name, new Event(revision, value)));
        }

        synchronized void stage(String name, String status, String message) {
            Stage update = new Stage(name, status, message, "selection".equals(name) ? plan : null);
            stages.put(name, update);
            emit("stage", update);
        }

        void execute(Request request, ImageCache.Lease images) {
            String phase = "selection";
            try {
                checkCancelled();
                phaseStart(phase);
                Plan selected = selection.select(request.context());
                synchronized (this) {
                    plan = selected;
                }
                if (!"ready".equals(selected.status()))
                    throw new IllegalArgumentException(selected.message());
                stage(phase, "committed", null);
                var required = new LinkedHashSet<>(ImageValidationService.requiredIds(request.context()));
                selected.selectedHistoricalImages().forEach(s -> required.add(s.assetId()));
                ChatApiRequest prepared = withImages(request.context(), selected, images.payloads(required));
                phase = "body";
                checkCancelled();
                phaseStart(phase);
                ChatStreamResult generated = chat.chatStream(prepared, delta -> {
                    checkCancelled();
                    synchronized (this) {
                        segments.add(delta);
                        try {
                            if (mapper.writeValueAsBytes(snapshot()).length > config.resultCacheBytes()
                                    / config.maxResults()) {
                                segments.removeLast();
                                throw new IllegalArgumentException("单个任务结果超过缓存资源上限");
                            }
                        } catch (IOException e) {
                            throw new IllegalStateException("生成结果无法序列化", e);
                        }
                        emit("delta", delta);
                    }
                }, value -> {
                    synchronized (this) {
                        budget = value;
                        emit("context", value);
                    }
                });
                synchronized (this) {
                    body = generated;
                    emit("body_done", generated);
                }
                String text;
                synchronized (this) {
                    StringBuilder plain = new StringBuilder();
                    String previousKind = "";
                    for (SegmentDelta segment : segments) {
                        if (!previousKind.isEmpty() && !previousKind.equals(segment.kind()))
                            plain.append('\n');
                        plain.append(segment.text());
                        previousKind = segment.kind();
                    }
                    text = plain.toString();
                }
                validateBody(generated, text);
                stage(phase, "committed", null);
                phase = "state_update";
                checkCancelled();
                phaseStart(phase);
                String input = request.context().input().textOf();
                if (input.isBlank())
                    input = "图片输入：" + String.join("、", ImageValidationService.newIds(prepared));
                var update = new UpdateRequest("state:" + request.assistant().id(),
                        new ChatApiRequest(prepared.character(), prepared.state(), prepared.summary(),
                                prepared.history(),
                                prepared.input(), prepared.interactionSettings(), prepared.visual(),
                                "state:" + request.assistant().id()),
                        request.user().seq() - 1, request.assistant().seq(), List.of(
                                new SourceMessage(request.user().id(), request.user().seq(), "user", input, "complete",
                                        request.user().createdAt()),
                                new SourceMessage(request.assistant().id(), request.assistant().seq(), "assistant",
                                        text, "complete", request.assistant().createdAt())));
                state.validateRequest(update);
                Result computed = state.update(update);
                checkCancelled();
                synchronized (this) {
                    if (mapper.writeValueAsBytes(computed).length + mapper.writeValueAsBytes(snapshot()).length > config
                            .resultCacheBytes() / config.maxResults())
                        throw new IllegalArgumentException("整理结果超过缓存资源上限");
                    result = computed;
                    emit("state_result", computed);
                }
                stage(phase, "committed", null);
            } catch (Exception e) {
                synchronized (this) {
                    error = cancelled ? error : e.toString();
                    stage(phase, cancelled ? "cancelled" : "failed", error);
                    if (!cancelled)
                        log.error("后台生成失败：任务={}，阶段={}，异常类型={}", id, phase, e.getClass().getName());
                }
                if (e instanceof InterruptedException)
                    Thread.currentThread().interrupt();
            }
        }

        private void validateBody(ChatStreamResult generated, String text) throws IOException {
            if ("stop".equals(generated.finishReason()) && !text.isBlank())
                return;
            String reason = switch (generated.finishReason()) {
                case "stop" -> "模型正常结束，但正文为空（未返回有效台词或描写）";
                case "length" -> "模型因长度限制停止生成";
                default -> "模型未正常结束";
            };
            var usage = generated.usage();
            String usageDetails = "reported".equals(usage.status())
                    ? "输入 token=" + usage.inputTokens() + "；输出 token=" + usage.outputTokens()
                            + "；总 token=" + usage.totalTokens()
                    : "token 用量=上游未提供";
            String message = "正文生成失败：" + reason + "；finish_reason=" + generated.finishReason()
                    + "；本次输出上限=" + budget.outputReserveTokens() + " token；" + usageDetails
                    + "；已返回正文=" + text.length() + " 字符";
            log.warn("任务={}，{}", id, message);
            throw new IOException(message);
        }

        private void phaseStart(String phase) {
            stage(phase, "running", null);
        }

        synchronized void checkCancelled() {
            if (cancelled || Thread.currentThread().isInterrupted())
                throw new CancellationException("任务已取消");
        }

        void cancel(String message) {
            synchronized (this) {
                if (terminal)
                    return;
                cancelled = true;
                error = message;
            }
            Thread thread = worker;
            if (thread != null)
                thread.interrupt();
            UpstreamCancellation upstream = cancellation;
            if (upstream != null)
                upstream.cancel();
        }

        synchronized void finish() {
            terminal = true;
            finishedAt = clock.millis();
            if (deadline != null)
                deadline.cancel(false);
            emit("done", snapshot());
            subscribers.clear();
            cancellation = null;
            worker = null;
            deadline = null;
        }
    }

    private record Outgoing(String name, Object data) {
    }

    private final class Subscription {
        final SseEmitter emitter = new SseEmitter(0L);
        final BlockingQueue<Outgoing> queue = new ArrayBlockingQueue<>(64);
        volatile boolean closed;
        volatile Thread sender;

        Subscription() {
            emitter.onCompletion(this::close);
            emitter.onError(e -> close());
        }

        boolean offer(String name, Object data) {
            if (closed)
                return false;
            if (queue.offer(new Outgoing(name, data)))
                return true;
            close();
            emitter.complete();
            return false;
        }

        void start() {
            sender = Thread.ofVirtual().name("chat-subscriber").start(() -> {
                try {
                    while (!closed) {
                        Outgoing next = queue.poll(15, TimeUnit.SECONDS);
                        if (next == null) {
                            emitter.send(SseEmitter.event().comment("keepalive"));
                            continue;
                        }
                        emitter.send(
                                SseEmitter.event().name(next.name()).data(next.data(), MediaType.APPLICATION_JSON));
                        if ("done".equals(next.name())) {
                            emitter.complete();
                            return;
                        }
                    }
                } catch (IOException e) {
                    // 写入失败由 Servlet 容器通知 Spring 收尾，不能再次完成响应。
                    log.debug("SSE 响应写入失败，关闭当前订阅，异常类型：{}", e.getClass().getName());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } catch (Exception e) {
                    emitter.completeWithError(e);
                } finally {
                    close();
                }
            });
        }

        void close() {
            closed = true;
            queue.clear();
            if (sender != null && sender != Thread.currentThread())
                sender.interrupt();
        }
    }
}
