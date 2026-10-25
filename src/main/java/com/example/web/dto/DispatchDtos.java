package com.example.web.dto;

import java.util.List;
import java.util.Map;
import com.example.llm.model.ChatStreamResult;
import com.example.web.dto.StateDtos.*;
import com.example.web.dto.VisualDtos.Plan;

public final class DispatchDtos {
    private DispatchDtos() {}
    public record ImageRef(String assetId, String sha256) {}
    public record MessageMeta(String id, int seq, String createdAt, int completedCheckpointVersion) {}
    public record Request(String runId, ChatApiRequest context, MessageMeta user, MessageMeta assistant,
            List<ImageRef> images) {
        public Request { images = images == null ? List.of() : List.copyOf(images); }
    }
    public record Retry(UpdateRequest request, List<ImageRef> images) {
        public Retry { images = images == null ? List.of() : List.copyOf(images); }
    }
    public record Stage(String name, String status, String error, Plan plan) {}
    public record Snapshot(String runId, long revision, List<SegmentDelta> segments, Map<String, Stage> stages,
            ContextDtos.ContextBudget budget, Plan plan, ChatStreamResult body, Result state,
            boolean terminal, String error, String imagePrompt, SceneImageDtos.Plan scenePlan, String imagePromptError) {}
    public record Event(long revision, Object value) {}
}
