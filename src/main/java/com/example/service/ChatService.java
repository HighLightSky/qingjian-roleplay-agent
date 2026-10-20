package com.example.service;

import java.io.IOException;
import java.util.Objects;
import java.util.function.Consumer;

import org.springframework.stereotype.Service;

import com.example.llm.LLMClient;
import com.example.llm.model.ChatRequest;
import com.example.prompt.PromptBuilder;
import com.example.web.dto.ChatApiRequest;
import com.example.web.dto.HistoryMessageDto;
import com.example.web.dto.InputDto;
import com.example.web.dto.SegmentDelta;

/** 串起一次聊天的校验、提示词构建、模型调用与流式解析，不保存会话状态。 */
@Service
public class ChatService {
    private static final int MAX_INPUT_CHARS = 2000;
    private static final int MAX_MEMORIES = 50;

    private final PromptBuilder promptBuilder;
    private final LLMClient llmClient;

    // 由 Spring 注入已有的提示词构建器和模型客户端。
    public ChatService(PromptBuilder promptBuilder, LLMClient llmClient) {
        this.promptBuilder = promptBuilder;
        this.llmClient = llmClient;
    }

    /**
     * 同步执行一次流式聊天，期间通过 onDelta 持续输出台词或描写。
     *
     * @param request 前端提交的完整上下文，当前仅支持纯文字输入
     * @param onDelta 解析出正文时执行的回调，由 Controller 负责发送 SSE
     * @return 模型返回的结束原因，供 Controller 构造 done 事件
     * @throws IllegalArgumentException 输入不合法或携带当前尚不支持的图片
     * @throws IOException 模型请求或响应读取失败
     * @throws InterruptedException 当前模型请求被中断
     */
    public String chatStream(ChatApiRequest request, Consumer<SegmentDelta> onDelta)
            throws IOException, InterruptedException {
        Objects.requireNonNull(onDelta, "onDelta 不能为空");
        validateRequest(request);

        ChatRequest chatRequest = promptBuilder.build(request);
        // 解析器有当前行的状态，因此每次请求都要新建，不能放在成员字段中共享。
        SegmentStreamParser parser = new SegmentStreamParser(onDelta);

        // parser::feed 作为回调函数传入
        String finishReason = llmClient.chatStream(chatRequest, parser::feed);

        if (finishReason == null || finishReason.isBlank()) {
            throw new IOException("模型流缺少结束原因，可能已意外中断");
        }

        parser.finish();
        return finishReason;
    }

    /** 在调用模型之前检查业务输入，参数错误统一使用 IllegalArgumentException。 */
    public void validateRequest(ChatApiRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("聊天请求不能为空");
        }
        if (request.character() == null) {
            throw new IllegalArgumentException("角色快照不能为空");
        }
        if (request.memories() == null) {
            throw new IllegalArgumentException("重要记忆必须提供，无记忆时请传空列表");
        }
        if (request.memories().size() > MAX_MEMORIES) {
            throw new IllegalArgumentException("重要记忆不能超过 " + MAX_MEMORIES + " 条");
        }
        for (String memory : request.memories()) {
            if (memory == null) {
                throw new IllegalArgumentException("重要记忆不能包含 null");
            }
        }
        if (request.summary() == null) {
            throw new IllegalArgumentException("摘要必须提供，无摘要时请传空字符串");
        }
        if (request.history() == null) {
            throw new IllegalArgumentException("历史消息必须提供，无历史时请传空列表");
        }
        for (HistoryMessageDto message : request.history()) {
            if (message == null) {
                throw new IllegalArgumentException("历史消息不能包含 null");
            }
            if (!"user".equals(message.role()) && !"assistant".equals(message.role())) {
                throw new IllegalArgumentException("历史消息的 role 只能是 user 或 assistant");
            }
            if (message.text() == null) {
                throw new IllegalArgumentException("历史消息的 text 不能为 null");
            }
        }

        InputDto input = request.input();
        if (input == null) {
            throw new IllegalArgumentException("本轮输入不能为空");
        }
        // 当前 Message 只支持文本；图片功能接入前明确拒绝，避免图片被静默忽略。
        if (input.image() != null) {
            throw new IllegalArgumentException("当前尚不支持图片输入，请先发送纯文字");
        }
        if (input.text() == null || input.text().isBlank()) {
            throw new IllegalArgumentException("用户输入不能为空");
        }
        if (input.text().length() > MAX_INPUT_CHARS) {
            throw new IllegalArgumentException("用户输入不能超过 " + MAX_INPUT_CHARS + " 字符");
        }
    }
}
