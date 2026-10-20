package com.example.web.dto;

/**
 * POST /api/summary 的响应体，摘要由前端保存到当前会话。
 *
 * @param summary 合并旧摘要与本次历史后生成的新摘要，用于替换原摘要
 */
public record SummaryApiResponse(
        String summary
) {}
