package com.example.web.dto;

import java.util.List;

public final class SceneImageDtos {
    private SceneImageDtos() {
    }

    public record Reference(String assetId, List<String> roles, String scope, String sourceSha256,
            String sourceGenerationId) {
        public Reference {
            roles = roles == null ? List.of() : List.copyOf(roles);
        }
    }

    public record ModelPlan(List<Reference> referenceImages) {
        public ModelPlan {
            referenceImages = referenceImages == null ? List.of() : List.copyOf(referenceImages);
        }
    }

    public record Plan(String id, String sessionId, String assistantMessageId, int sourceSeq,
            int sourceCheckpointVersion, int profileVersion, List<Reference> referenceImages, String prompt,
            String error) {
        public Plan {
            referenceImages = List.copyOf(referenceImages);
        }
    }

    public record Source(String planId, String sessionId, String assistantMessageId, int sourceSeq,
            int sourceCheckpointVersion) {
    }

    public record InputImage(String assetId, List<String> roles, String scope, String sha256, String sourceSha256,
            String sourceGenerationId) {
        public InputImage {
            roles = roles == null ? List.of() : List.copyOf(roles);
        }
    }

    public record GenerationRequest(String runId, Source source, String prompt, int width, int height,
            List<InputImage> referenceImages) {
        public GenerationRequest {
            referenceImages = referenceImages == null ? List.of() : List.copyOf(referenceImages);
        }
    }

    public record Submission(String prompt, String effectivePrompt, int width, int height,
            List<InputImage> referenceImages) {
    }

    public record TaskSnapshot(String runId, long revision, String status, String errorCode, String error,
            boolean terminal, Submission submission) {
    }
}
