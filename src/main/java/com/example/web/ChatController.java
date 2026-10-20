package com.example.web;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CancellationException;

import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.example.config.LlmProperties;
import com.example.service.ChatService;
import com.example.web.dto.ChatApiRequest;

/** 聊天 HTTP 入口：每次请求独立生成，并通过 SSE 持续返回正文。 */
@RestController
@RequestMapping("/api")
public class ChatController {
    private final ChatService chatService;
    private final long timeoutMillis;

    public ChatController(ChatService chatService, LlmProperties properties) {
        this.chatService = chatService;
        this.timeoutMillis = Duration.ofSeconds(properties.timeoutSeconds()).toMillis();
        if (timeoutMillis <= 0) {
            throw new IllegalArgumentException("模型超时时间必须大于 0");
        }
    }

    @PostMapping(
            value = "/chat",
            consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.TEXT_EVENT_STREAM_VALUE
    )
    public ResponseEntity<SseEmitter> chat(@RequestBody ChatApiRequest request) {
        // 必须先校验再进入异步处理，使非法输入直接返回 HTTP 400。
        chatService.validateRequest(request);

        ChatStream stream = new ChatStream(request);
        stream.start();
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .header("X-Accel-Buffering", "no")
                .body(stream.emitter);
    }

    /** 仅属于本次请求的连接状态，保证完成、超时和断开不会重复发送终止事件。 */
    private final class ChatStream {
        // 使用独立截止计时：Spring 的 onTimeout 执行时 emitter 已不可发送 error 事件。
        // 0 表示禁用容器的异步超时，整个请求由下方 deadline 统一限制。
        private final SseEmitter emitter = new SseEmitter(0L);
        private final ChatApiRequest request;
        private final Thread worker;
        private final Thread deadline;
        private boolean started;
        private boolean closed;

        private ChatStream(ChatApiRequest request) {
            this.request = request;
            this.worker = Thread.ofVirtual().name("chat-generation").unstarted(this::generate);
            this.deadline = Thread.ofVirtual().name("chat-deadline").unstarted(() -> {
                try {
                    Thread.sleep(timeoutMillis);
                    fail(new HttpTimeoutException("聊天请求超时"));
                } catch (InterruptedException ignored) {
                    // 请求已结束，不再需要计时。
                }
            });
            emitter.onError(exception -> cancel());
            emitter.onCompletion(this::cancel);
        }

        private void start() {
            deadline.start();
            worker.start();
        }

        private void generate() {
            try {
                String finishReason = chatService.chatStream(request, delta -> send("delta", delta));
                complete(finishReason);
            } catch (InterruptedException exception) {
                fail(exception);
                Thread.currentThread().interrupt();
            } catch (Exception exception) {
                fail(exception);
            }
        }

        private synchronized void send(String event, Object data) {
            if (closed) {
                throw new CancellationException("聊天连接已结束");
            }
            try {
                emitter.send(SseEmitter.event().name(event).data(data, MediaType.APPLICATION_JSON));
                started = true;
            } catch (IOException exception) {
                // Consumer 不能抛出受检异常，包装后交给外层终止读取。
                cancel();
                throw new UncheckedIOException(exception);
            } catch (IllegalStateException exception) {
                cancel();
                throw exception;
            }
        }

        private synchronized void complete(String finishReason) {
            if (!closed) {
                send("done", Map.of("finishReason", finishReason));
                closed = true;
                emitter.complete();
                stopThreads();
            }
        }

        private synchronized void fail(Exception exception) {
            if (closed) {
                return;
            }
            closed = true;
            try {
                if (!started) {
                    // 尚未发送任何事件，交给异常处理器返回 502 / 504 JSON。
                    emitter.completeWithError(exception);
                } else {
                    // SSE 已开始，HTTP 状态不可更改，通过 error 事件通知前端。
                    emitter.send(SseEmitter.event().name("error")
                            .data(ApiExceptionHandler.toModelError(exception), MediaType.APPLICATION_JSON));
                    emitter.complete();
                }
            } catch (IOException | IllegalStateException ignored) {
                // 客户端已经断开，停止发送，不重试。
            } finally {
                stopThreads();
            }
        }

        private synchronized void cancel() {
            closed = true;
            stopThreads();
        }

        private void stopThreads() {
            if (worker != Thread.currentThread()) {
                worker.interrupt();
            }
            if (deadline != Thread.currentThread()) {
                deadline.interrupt();
            }
        }
    }
}
