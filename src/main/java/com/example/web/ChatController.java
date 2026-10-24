package com.example.web;

import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import com.example.service.ChatDispatchService;
import com.example.web.dto.DispatchDtos.Request;

/** 连接结束只解除订阅，取消必须通过显式接口。 */
@RestController
@RequestMapping("/api/chat")
public class ChatController {
    private final ChatDispatchService dispatch;

    public ChatController(ChatDispatchService dispatch) {
        this.dispatch = dispatch;
    }

    @PostMapping(produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> chat(@RequestBody Request request) {
        return stream(dispatch.start(request));
    }

    @GetMapping(value = "/{runId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> events(@PathVariable String runId) {
        return stream(dispatch.subscribe(runId));
    }

    @PostMapping("/{runId}/cancel")
    public void cancel(@PathVariable String runId) {
        dispatch.cancel(runId);
    }

    @PostMapping("/{runId}/ack")
    public void acknowledge(@PathVariable String runId) {
        dispatch.acknowledge(runId);
    }

    private ResponseEntity<SseEmitter> stream(SseEmitter emitter) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).header("X-Accel-Buffering", "no").body(emitter);
    }
}
