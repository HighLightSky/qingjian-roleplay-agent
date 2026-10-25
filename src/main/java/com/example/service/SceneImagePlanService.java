package com.example.service;

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
        int newline = raw.indexOf('\n');
        String prompt = raw.startsWith("[画面计划]") ? (newline < 0 ? "" : raw.substring(newline + 1).strip())
                : raw.strip();
        var references = new LinkedHashMap<String, Reference>();
        var errors = new ArrayList<String>();
        String photoId = context.character().appearancePhotoAssetId();
        ImageValidationService.catalog(context).stream().filter(a -> a.assetId().equals(photoId)).findFirst()
                .ifPresent(a -> references.put(a.assetId(), new Reference(a.assetId(), List.of("identity"),
                        "人物身份参考，服装和环境以本次提示词为准", a.sourceSha256(), null)));
        try {
            if (!raw.startsWith("[画面计划]") || newline < 0)
                throw new IllegalArgumentException("参考建议缺少完整画面计划，可编辑提示词后直接生成");
            var model = mapper.readerFor(ModelPlan.class).with(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                    .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .<ModelPlan>readValue(raw.substring("[画面计划]".length(), newline));
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
        } catch (Exception e) {
            errors.add("参考建议解析失败：" + e.getMessage());
        }
        var ordered = new ArrayList<>(references.values());
        ordered.sort(
                Comparator.comparingInt(r -> r.assetId().equals(photoId) ? 0 : r.roles().contains("identity") ? 1 : 2));
        return new Plan(UUID.randomUUID().toString(), context.state().sessionId(), source.id(), source.seq(),
                source.completedCheckpointVersion(), context.character().profileVersion(), List.copyOf(ordered), prompt,
                errors.isEmpty() ? null : String.join("；", errors));
    }
}
