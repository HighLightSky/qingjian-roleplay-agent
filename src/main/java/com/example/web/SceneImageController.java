package com.example.web;

import java.io.IOException;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import com.example.config.ImageGenerationProperties;
import com.example.service.*;
import com.example.web.dto.SceneImageDtos.*;

@RestController
@RequestMapping("/api/scene-images")
public class SceneImageController {
    private final SceneImageTaskService tasks;
    private final ImageCache cache;
    private final ImageGenerationProperties config;

    public SceneImageController(SceneImageTaskService tasks, ImageCache cache, ImageGenerationProperties config) {
        this.tasks = tasks;
        this.cache = cache;
        this.config = config;
    }

    @PostMapping
    public TaskSnapshot create(@RequestBody GenerationRequest request) throws IOException {
        return tasks.start(request);
    }
    @PostMapping("/direct")
    public TaskSnapshot direct(@RequestBody DirectGenerationRequest request) throws IOException {
        return tasks.startDirect(request);
    }
    @GetMapping("/{runId}")
    public TaskSnapshot snapshot(@PathVariable String runId) {
        return tasks.snapshot(runId);
    }
    @GetMapping(value = "/{runId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> events(@PathVariable String runId) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).header("X-Accel-Buffering", "no")
                .body(tasks.subscribe(runId));
    }
    @GetMapping("/{runId}/result")
    public ResponseEntity<byte[]> result(@PathVariable String runId) {
        return ResponseEntity.ok().contentType(MediaType.IMAGE_PNG).cacheControl(CacheControl.noStore())
                .body(tasks.result(runId));
    }
    @PostMapping("/{runId}/cancel")
    public ResponseEntity<TaskSnapshot> cancel(@PathVariable String runId) throws IOException, InterruptedException {
        var snapshot = tasks.cancel(runId);
        return ResponseEntity.status(snapshot.status().equals("cancelling") ? HttpStatus.ACCEPTED : HttpStatus.OK)
                .body(snapshot);
    }
    @PostMapping("/{runId}/ack")
    public void acknowledge(@PathVariable String runId) {
        tasks.acknowledge(runId);
    }
    @PutMapping("/inputs/{sha256}")
    public void input(@PathVariable String sha256, HttpServletRequest request) throws IOException {
        byte[] bytes = request.getInputStream().readNBytes(Math.toIntExact(config.maxImageBytes() + 1));
        cache.putGenerationInput(sha256, bytes, config.maxImageBytes(), config.maxPixels());
    }
}
