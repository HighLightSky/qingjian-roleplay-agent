package com.example.service;

import java.util.*;
import org.springframework.stereotype.Service;
import com.example.prompt.StateUpdateMaterial;
import com.example.web.dto.SceneImageDtos.*;
import com.example.web.dto.StateDtos.UpdateRequest;
import com.example.web.dto.VisualDtos.GenerationSource;

/** 接收已校验的结构化建议，按实际传图顺序冻结来源。 */
@Service
public class SceneImagePlanService {
    public Plan resolvePlan(ModelScene scene, UpdateRequest request, StateUpdateMaterial material) {
        var references = new ArrayList<Reference>();
        var context = request.context();
        String photoId = material.data().path("automaticReference").path("assetId").asText();
        if (!photoId.isEmpty()) {
            var photo = ImageValidationService.catalog(context).stream().filter(a -> a.assetId().equals(photoId))
                    .findFirst().orElseThrow();
            references.add(new Reference(photo.assetId(), "人物身份，动作与服装以提示词为准", photo.sourceSha256(), null));
        }
        for (var suggested : scene.additionalReferences()) {
            var asset = ImageValidationService.catalog(context).stream()
                    .filter(a -> a.assetId().equals(suggested.assetId())).findFirst().orElseThrow();
            String generationId = asset.sources().stream()
                    .filter(s -> s instanceof GenerationSource g && !g.rejected())
                    .map(s -> (GenerationSource) s).max(Comparator.comparingInt(GenerationSource::seq))
                    .map(GenerationSource::generationId).orElse(null);
            references.add(new Reference(asset.assetId(), suggested.scope(), asset.sourceSha256(), generationId));
        }
        var source = request.messages().getLast();
        return new Plan(UUID.randomUUID().toString(), context.state().sessionId(), source.id(), source.seq(),
                request.assistantCheckpointVersion(), context.character().profileVersion(), references, scene.prompt(), null);
    }
}
