package com.example.web.dto;

import java.util.List;
import com.fasterxml.jackson.databind.JsonNode;

public final class SceneImageDtos {
    private SceneImageDtos() {
    }

    public record Reference(String assetId, String scope, String sourceSha256, String sourceGenerationId) {
    }

    public record SuggestedReference(String assetId, String scope) {
    }

    public record ModelScene(String prompt, String poseQuery, List<SuggestedReference> additionalReferences) {
        public ModelScene {
            additionalReferences = additionalReferences == null ? List.of() : List.copyOf(additionalReferences);
        }
    }

    public record Plan(String id, String sessionId, String assistantMessageId, int sourceSeq,
            int sourceCheckpointVersion, int profileVersion, List<Reference> referenceImages, String prompt,
            String error, String poseQuery, String characterReferenceAssetId) {
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

    public sealed interface TaskRequest permits GenerationRequest, DirectGenerationRequest {
        String runId();
    }

    public record GenerationRequest(String runId, Source source, String prompt, int width, int height,
            List<InputImage> referenceImages, boolean poseEnabled, String poseQuery, String characterReferenceAssetId,
            PoseSelection poseSelection) implements TaskRequest {
        public GenerationRequest {
            referenceImages = referenceImages == null ? List.of() : List.copyOf(referenceImages);
        }
    }

    public record DirectGenerationRequest(String runId, String prompt, List<InputImage> referenceImages)
            implements TaskRequest {
        public DirectGenerationRequest {
            referenceImages = referenceImages == null ? List.of() : List.copyOf(referenceImages);
        }
    }

    public record Submission(String prompt, String effectivePrompt, Integer width, Integer height,
            List<InputImage> referenceImages, boolean poseEnabled, String poseQuery, String characterReferenceAssetId,
            PoseSelection poseSelection) {
    }

    public record PoseSearchRequest(String query) {
    }

    public record PoseDescription(String zh, String en) {
    }

    public record PoseSelection(String poseId, Double score, PoseDescription description, JsonNode pose) {
        public PoseSelection {
            if (pose != null)
                pose = pose.deepCopy();
        }

        @Override
        public JsonNode pose() {
            return pose == null ? null : pose.deepCopy();
        }
    }

    public record PoseSearchResult(List<PoseSelection> matches) {
        public PoseSearchResult {
            matches = List.copyOf(matches);
        }
    }

    public record TaskSnapshot(String runId, long revision, String status, String errorCode, String error,
            boolean terminal, Submission submission) {
    }
}
