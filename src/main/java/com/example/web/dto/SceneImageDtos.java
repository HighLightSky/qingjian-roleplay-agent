package com.example.web.dto;

import java.util.List;
import java.util.Map;

public final class SceneImageDtos {
    private SceneImageDtos() {
    }

    public record Reference(String assetId, List<String> roles, String scope, String sourceSha256,
            String sourceGenerationId) {
        public Reference {
            roles = roles == null ? List.of() : List.copyOf(roles);
        }
    }

    public record ModelPlan(String action, String continuity, String previousPlanId, Map<String, String> target,
            List<Reference> referenceImages) {
        public ModelPlan {
            target = target == null ? Map.of() : Map.copyOf(target);
            referenceImages = referenceImages == null ? List.of() : List.copyOf(referenceImages);
        }
    }

    public record Plan(String id, String sessionId, String assistantMessageId, int sourceSeq,
            int sourceCheckpointVersion, int profileVersion, String sceneId, String previousPlanId, String continuity,
            Map<String, String> target, List<Reference> referenceImages, String prompt, String summary,
            String fingerprint, String status, String error) {
        public Plan {
            target = target == null ? Map.of() : Map.copyOf(target);
            referenceImages = referenceImages == null ? List.of() : List.copyOf(referenceImages);
        }
    }

    public record InputImage(String assetId, String sha256, String sourceSha256) {
    }

    public record GenerationRequest(String runId, Plan plan, CharacterDto character, List<InputImage> images) {
        public GenerationRequest {
            images = images == null ? List.of() : List.copyOf(images);
        }
    }

    public record TaskSnapshot(String runId, long revision, String status, String errorCode, String error,
            boolean terminal) {
    }
}
