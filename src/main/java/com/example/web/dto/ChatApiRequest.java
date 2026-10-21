package com.example.web.dto;

import java.util.List;

/** 摘要只覆盖较早历史，操作结果和用量不进入故事上下文。 */
public record ChatApiRequest(CharacterDto character, StateDtos.Snapshot state, ContextDtos.HistorySummary summary,
        List<HistoryMessageDto> history, InputDto input, InteractionSettingsDto interactionSettings,
        VisualDtos.Context visual, String operationId) {
    public ChatApiRequest { history = history == null ? List.of() : java.util.Collections.unmodifiableList(new java.util.ArrayList<>(history)); }
}
