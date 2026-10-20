package com.example.web.dto;

import java.util.List;

/**
 * POST /api/chat 的请求体，携带本次生成需要的全部上下文。
 *
 * @param character 当前会话创建时保存的角色快照，不随之后的角色资料编辑而变化
 * @param memories 当前会话的重要记忆，必须提供，无记忆时传空列表
 * @param summary 已生成的历史摘要，必须提供，无摘要时传空字符串
 * @param history 按时间从早到晚排列的最近消息，必须提供，可为空，不包含本轮输入
 * @param input 本轮用户输入，文字和图片不能同时为空
 */
public record ChatApiRequest(
        CharacterDto character,
        List<String> memories,
        String summary,
        List<HistoryMessageDto> history,
        InputDto input
) {}
