package com.example.web.dto;

import java.util.List;

public final class SceneImageDtos {
    private SceneImageDtos() {
    }

    public record Reference(String assetId, String scope, String sourceSha256, String sourceGenerationId) {
    }

    public record SuggestedReference(String assetId, String scope) {
    }

    public record ModelScene(String prompt, List<SuggestedReference> additionalReferences) {
        public ModelScene {
            additionalReferences = additionalReferences == null ? List.of() : List.copyOf(additionalReferences);
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

    public record InputImage(String assetId, String scope, String sha256, String sourceSha256,
            String sourceGenerationId) {
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
