package com.example.web.dto;

import java.util.List;

/**
 * POST /api/summary 的请求体，用于合并旧摘要和新增的待压缩历史。
 *
 * @param characterName 当前会话的角色名称，为摘要提供角色背景
 * @param existingSummary 旧摘要，首次生成摘要时传空字符串
 * @param history 本次需要压缩的历史消息，按时间从早到晚排列，不包含保留为原文的最近消息
 */
public record SummaryApiRequest(
        String characterName,
        String existingSummary,
        List<HistoryMessageDto> history
) {}
