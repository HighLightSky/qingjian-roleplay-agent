package com.example.web.dto;

import java.util.List;
import java.util.Map;
import com.fasterxml.jackson.databind.JsonNode;

/** 领域快照和有来源的整理变更，不允许模型修改任意存储字段。 */
public final class StateDtos {
    private StateDtos() {
    }

    public record Story(String location, String storyTime, String characterState, String userState, List<String> presentCharacters,
            List<String> relationships, List<String> items, List<String> openThreads) {
        public Story {
            presentCharacters = list(presentCharacters);
            relationships = list(relationships);
            items = list(items);
            openThreads = list(openThreads);
        }
    }

    public record MemoryValue(String content, String scope, String kind, String epistemicStatus, String status) {
    }

    public record Memory(String id, String characterId, String sessionId, MemoryValue value, int version,
            String origin, String sourceSessionId, List<String> sourceMessageIds, String updatedAt) {
        public Memory {
            sourceMessageIds = list(sourceMessageIds);
        }
    }

    public record GoalValue(String description, String status, String currentFocus, String progressSummary) {
    }

    public record Goal(String id, String sessionId, GoalValue value, int version, String origin,
            List<String> sourceMessageIds, String updatedAt) {
        public Goal {
            sourceMessageIds = list(sourceMessageIds);
        }
    }

    public record FieldSource(String origin, String updatedAt, List<String> sourceMessageIds) {
        public FieldSource { sourceMessageIds = list(sourceMessageIds); }
    }
    public record Snapshot(String sessionId, String characterId, int sessionVersion, int memoryVersion,
            int processedThroughSeq, Story story, Map<String, FieldSource> storySources, List<Memory> memories, List<Goal> goals) {
        public Snapshot {
            storySources = storySources == null ? Map.of() : Map.copyOf(storySources);
            memories = list(memories);
            goals = list(goals);
        }
    }

    public record SourceMessage(String id, int seq, String role, String text, String status, String createdAt) {
    }

    public record UpdateRequest(String operationId, ChatApiRequest context, int fromExclusiveSeq, int throughSeq,
            List<SourceMessage> messages) {
        public UpdateRequest {
            messages = list(messages);
        }
    }

    public record ProposedChange(String action, String id, int expectedVersion, JsonNode value, String reason,
            List<String> sourceMessageIds) {
        public ProposedChange {
            sourceMessageIds = list(sourceMessageIds);
        }
    }

    public record ModelResult(List<VisualDtos.Observation> visualObservations, List<ProposedChange> storyChanges,
            List<ProposedChange> memoryChanges, List<ProposedChange> goalChanges) {
        public ModelResult {
            visualObservations = list(visualObservations);
            storyChanges = list(storyChanges);
            memoryChanges = list(memoryChanges);
            goalChanges = list(goalChanges);
        }
    }

    public record Change(String action, String id, int expectedVersion, JsonNode before, JsonNode value,
            String reason, List<String> sourceMessageIds) {
    }

    public record Result(String operationId, int sessionVersion, int memoryVersion, int fromExclusiveSeq,
            int throughSeq, List<VisualDtos.Observation> visualObservations, List<Change> storyChanges,
            List<Change> memoryChanges, List<Change> goalChanges) {
    }

    private static <T> List<T> list(List<T> values) {
        return values == null ? List.of() : List.copyOf(values);
    }
}
