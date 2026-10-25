package com.example.service;

import java.io.IOException;
import java.util.*;
import org.springframework.stereotype.Service;
import com.example.web.dto.*;
import com.example.web.dto.SceneImageDtos.*;
import com.fasterxml.jackson.databind.*;

@Service
public class SceneImagePlanService {
    private final ObjectMapper mapper;

    public SceneImagePlanService(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    public Plan resolvePlan(String raw, ChatApiRequest context, DispatchDtos.MessageMeta source) {
        String content = raw.strip();
        String prompt = promptText(content);
        var references = new LinkedHashMap<String, Reference>();
        var errors = new ArrayList<String>();
        String photoId = context.character().appearancePhotoAssetId();
        ImageValidationService.catalog(context).stream().filter(a -> a.assetId().equals(photoId)).findFirst()
                .ifPresent(a -> references.put(a.assetId(), new Reference(a.assetId(), List.of("identity"),
                        "人物身份参考，服装和环境以本次提示词为准", a.sourceSha256(), null)));
        if (content.startsWith(SceneImageStreamParser.PLAN_MARKER)) {
            String planned = content.substring(SceneImageStreamParser.PLAN_MARKER.length());
            try (var parser = mapper.createParser(planned)) {
                // JSON 可以换行，具体边界交给 Jackson，不依赖首行或手工匹配括号。
                var model = mapper.readerFor(ModelPlan.class).with(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                        .without(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).<ModelPlan>readValue(parser);
                if (model == null)
                    throw new IllegalArgumentException("参考建议必须为 JSON 对象");
                prompt = promptText(planned.substring(Math.toIntExact(parser.currentLocation().getCharOffset())));
                for (var reference : model.referenceImages()) {
                    ImageIds.requireValid(reference.assetId());
                    if (reference.scope() == null || reference.scope().isBlank() || reference.roles().stream().anyMatch(
                            r -> !Set.of("identity", "continuity", "outfit", "environment", "pose", "prop").contains(r)))
                        throw new IllegalArgumentException("参考用途无效：" + reference.assetId());
                    var asset = ImageValidationService.catalog(context).stream()
                            .filter(a -> a.assetId().equals(reference.assetId())).findFirst();
                    String generationId = asset.stream().flatMap(a -> a.sources().stream())
                            .filter(s -> s instanceof VisualDtos.GenerationSource g && !g.rejected())
                            .map(s -> (VisualDtos.GenerationSource) s)
                            .max(Comparator.comparingInt(VisualDtos.GenerationSource::seq))
                            .map(VisualDtos.GenerationSource::generationId).orElse(null);
                    var frozen = new Reference(reference.assetId(), reference.roles(), reference.scope(),
                            asset.map(VisualDtos.Asset::sourceSha256).orElse(null), generationId);
                    references.merge(reference.assetId(), frozen, (left, right) -> {
                        var roles = new LinkedHashSet<>(left.roles());
                        roles.addAll(right.roles());
                        return new Reference(left.assetId(), List.copyOf(roles), left.scope() + "；" + right.scope(),
                                left.sourceSha256(), left.sourceGenerationId());
                    });
                    if (asset.isEmpty())
                        errors.add("参考原件不可用，请移除后生成：" + reference.assetId());
                }
            } catch (IOException | IllegalArgumentException e) {
                errors.add("参考建议解析失败：" + e.getMessage());
            }
        }
        if (prompt.isBlank())
            errors.add("本轮未输出生图提示词，请手动填写后生成");
        var ordered = new ArrayList<>(references.values());
        ordered.sort(
                Comparator.comparingInt(r -> r.assetId().equals(photoId) ? 0 : r.roles().contains("identity") ? 1 : 2));
        return new Plan(UUID.randomUUID().toString(), context.state().sessionId(), source.id(), source.seq(),
                source.completedCheckpointVersion(), context.character().profileVersion(), List.copyOf(ordered), prompt,
                errors.isEmpty() ? null : String.join("；", errors));
    }

    private String promptText(String content) {
        int marker = content.indexOf(SceneImageStreamParser.PROMPT_MARKER);
        if (marker >= 0)
            return content.substring(marker + SceneImageStreamParser.PROMPT_MARKER.length()).strip();
        if (content.startsWith(SceneImageStreamParser.PLAN_MARKER)) {
            int newline = content.indexOf('\n');
            return newline < 0 ? "" : content.substring(newline + 1).strip();
        }
        return content.strip();
    }
}
