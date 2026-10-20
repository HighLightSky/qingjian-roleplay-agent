package com.example.web.dto;

/**
 * 聊天或摘要请求中的一条历史消息，只携带文本，不重发历史图片。
 *
 * @param role 消息发送方，只允许 user 或 assistant；system 消息由后端构建
 * @param text 消息正文；助手的台词与描写合并为纯文本，图片由前端转换为文字占位说明
 */
public record HistoryMessageDto(
        String role,
        String text
) {}
