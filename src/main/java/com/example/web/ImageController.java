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
    public ImageController(ImageCache cache, VisionProperties vision) { this.cache = cache; this.vision = vision; }
    public record MissingRequest(List<String> hashes) {
        public MissingRequest { hashes = hashes == null ? List.of() : List.copyOf(hashes); }
    }
    @PostMapping("/missing")
    public Map<String, List<String>> missing(@RequestBody MissingRequest request) {
        return Map.of("missing", cache.missing(request.hashes()));
    }
    @PutMapping("/{sha256}")
    public void upload(@PathVariable String sha256, HttpServletRequest request) throws IOException {
        byte[] bytes = request.getInputStream().readNBytes(Math.toIntExact(vision.getMaxImageBytes() + 1));
        cache.put(sha256, bytes);
    }
}
