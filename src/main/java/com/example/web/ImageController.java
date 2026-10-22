package com.example.web;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;
import com.example.service.ImageCache;
import com.example.config.VisionProperties;

@RestController
@RequestMapping("/api/images")
public class ImageController {
    private final ImageCache cache;
    private final VisionProperties vision;

    public ImageController(ImageCache cache, VisionProperties vision) {
        this.cache = cache;
        this.vision = vision;
    }

    public record HashesRequest(List<String> hashes) {
        public HashesRequest {
            hashes = hashes == null ? List.of() : hashes;
        }
    }

    @PostMapping("/missing")
    public Map<String, List<String>> missing(@RequestBody HashesRequest request) {
        return Map.of("missing", cache.missing(request.hashes()));
    }

    @PostMapping("/cache/stats")
    public ImageCache.CacheStats stats(@RequestBody HashesRequest request) {
        return cache.stats(request.hashes());
    }

    @PostMapping("/cache/clear")
    public ImageCache.ClearResult clear(@RequestBody HashesRequest request) {
        return cache.clear(request.hashes());
    }

    @PutMapping("/{sha256}")
    public void upload(@PathVariable String sha256, HttpServletRequest request) throws IOException {
        byte[] bytes = request.getInputStream().readNBytes(Math.toIntExact(vision.getMaxImageBytes() + 1));
        cache.put(sha256, bytes);
    }
}
