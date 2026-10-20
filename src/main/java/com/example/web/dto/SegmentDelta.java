package com.example.web.dto;

/**
 * 一次 SSE delta 事件的数据，由后端解析模型输出后生成。
 *
 * @param kind 文本类型：dialogue 表示台词，narration 表示描写
 * @param text 本次新增的正文，不含类型标记，可能只是半句话；前端按类型追加合并
 */
public record SegmentDelta(
        String kind,
        String text
) {}
