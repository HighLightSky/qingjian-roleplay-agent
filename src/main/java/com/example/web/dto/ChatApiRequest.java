package com.example.web.dto;

import java.util.List;

/** 浏览器提交无状态计算所需材料；较早原文不是摘要，操作结果不进入历史。 */
public record ChatApiRequest(CharacterDto character, StateDtos.Snapshot state, String earlierHistory,
        List<HistoryMessageDto> history, InputDto input, InteractionSettingsDto interactionSettings,
        VisualDtos.Context visual, String operationId) {}
