package com.example.web;

import java.util.List;
import java.util.Map;
import com.example.config.VisionProperties;
import com.example.service.ImageValidationService;
import org.springframework.web.bind.annotation.*;

/** 暴露部署支持的图片能力和限制，不向浏览器暴露模型凭据。 */
@RestController
public class CapabilitiesController {
    private final VisionProperties properties;

    public CapabilitiesController(VisionProperties properties) {
        this.properties = properties;
    }

    @GetMapping("/api/capabilities")
    public Map<String, Object> getCapabilities() {
        return Map.of("visionSupported", properties.isSupported(), "mimeTypes", List.of("image/jpeg", "image/png"),
                "maxImages", properties.getMaxImages(), "maxImageBytes", properties.getMaxImageBytes(),
                "maxPixels", properties.getMaxPixels(), "maxRequestBytes", ImageValidationService.MAX_REQUEST_BYTES);
    }
}
