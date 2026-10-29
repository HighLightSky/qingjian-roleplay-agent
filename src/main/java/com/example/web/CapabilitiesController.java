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
    private final com.example.config.ImageGenerationProperties generation;

    public CapabilitiesController(VisionProperties properties, ContextProperties context, LlmProperties llm,
            com.example.config.ImageGenerationProperties generation) {
        this.properties = properties;
        this.context = context;
        this.llm = llm;
        this.generation = generation;
    }

    @GetMapping("/api/capabilities")
    public Map<String, Object> getCapabilities() {
        var result = new java.util.LinkedHashMap<String, Object>(Map.of("visionSupported", properties.isSupported(),
                "mimeTypes", List.of("image/jpeg", "image/png"), "maxImages", properties.getMaxImages(),
                "maxImageBytes", properties.getMaxImageBytes(), "maxPixels", properties.getMaxPixels(),
                "maxRequestBytes", ImageValidationService.MAX_REQUEST_BYTES));
        result.put("contextWindowTokens", context.contextWindowTokens());
        result.put("outputReserveTokens", llm.generationMaxTokens());
        result.put("safetyTokens", context.safetyTokens());
        result.put("compactionTriggerRatio", context.compactionTriggerRatio());
        result.put("compactionTargetRatio", context.compactionTargetRatio());
        result.put("retainedTurns", context.retainedTurns());
        result.put("compactionMaxBatches", context.compactionMaxBatches());
        result.put("imageGeneration", Map.ofEntries(Map.entry("enabled", !generation.apiToken().isBlank()),
                Map.entry("poseMaxBytes", generation.poseMaxBytes()),
                Map.entry("poseSearchMaxRequestBytes", generation.poseSearchMaxRequestBytes()),
                Map.entry("poseSearchMaxResponseBytes", generation.poseSearchMaxResponseBytes()),
                Map.entry("poseSearchTopK", generation.poseSearchTopK()),
                Map.entry("defaultWidth", generation.defaultWidth()),
                Map.entry("defaultHeight", generation.defaultHeight()),
                Map.entry("dimensionAlignment", generation.dimensionAlignment()),
                Map.entry("maxReferenceImages", properties.getMaxImages() - 1),
                Map.entry("maxImageBytes", generation.maxImageBytes()), Map.entry("maxPixels", generation.maxPixels()),
                Map.entry("maxEdge", generation.maxEdge()), Map.entry("maxTotalPixels", generation.maxTotalPixels()),
                Map.entry("maxRequestBytes", generation.maxRequestBytes()),
                Map.entry("maxPromptCharacters", generation.maxPromptCharacters()),
                Map.entry("maxOutputBytes", generation.maxOutputBytes()),
                Map.entry("maxOutputPixels", generation.maxOutputPixels()),
                Map.entry("referenceMaxEdge", generation.referenceMaxEdge()),
                Map.entry("referenceJpegQuality", generation.referenceJpegQuality())));
        return result;
    }
}
