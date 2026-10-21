package com.example.web;

import java.util.List;
import java.util.Map;
import com.example.config.VisionProperties;
import com.example.config.ContextProperties;
import com.example.config.LlmProperties;
import com.example.service.ImageValidationService;
import org.springframework.web.bind.annotation.*;

/** 暴露部署支持的图片能力和限制，不向浏览器暴露模型凭据。 */
@RestController
public class CapabilitiesController {
    private final VisionProperties properties;
    private final ContextProperties context;
    private final LlmProperties llm;

    public CapabilitiesController(VisionProperties properties, ContextProperties context, LlmProperties llm) {
        this.properties = properties;
        this.context = context;
        this.llm = llm;
    }

    @GetMapping("/api/capabilities")
    public Map<String, Object> getCapabilities() {
        var result = new java.util.LinkedHashMap<String, Object>(Map.of("visionSupported", properties.isSupported(), "mimeTypes", List.of("image/jpeg", "image/png"),
                "maxImages", properties.getMaxImages(), "maxImageBytes", properties.getMaxImageBytes(),
                "maxPixels", properties.getMaxPixels(), "maxRequestBytes", ImageValidationService.MAX_REQUEST_BYTES));
        result.put("contextWindowTokens", context.contextWindowTokens());
        result.put("outputReserveTokens", llm.maxTokens());
        result.put("safetyTokens", context.safetyTokens());
        result.put("compactionTriggerRatio", context.compactionTriggerRatio());
        result.put("compactionTargetRatio", context.compactionTargetRatio());
        result.put("retainedTurns", context.retainedTurns());
        result.put("compactionMaxBatches", context.compactionMaxBatches());
        return result;
    }
}
