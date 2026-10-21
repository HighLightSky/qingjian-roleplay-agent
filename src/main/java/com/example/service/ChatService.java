package com.example.service;

import java.io.IOException;
import java.util.Objects;
import java.util.function.Consumer;

import org.springframework.stereotype.Service;

import com.example.llm.LLMClient;
import com.example.llm.model.ChatRequest;
import com.example.prompt.PromptBuilder;
import com.example.web.dto.ChatApiRequest;
import com.example.web.dto.InputDto;
import com.example.web.dto.SegmentDelta;

/** 串起一次聊天的校验、提示词构建、模型调用与流式解析，不保存会话状态。 */
@Service
public class ChatService {
    private final PromptBuilder promptBuilder;
    private final LLMClient llmClient;
    private final ImageValidationService images;
    private final VisualSelectionService selection;
    private final ContextValidation contexts;

    public ChatService(PromptBuilder promptBuilder, LLMClient llmClient, ImageValidationService images,
            VisualSelectionService selection, ContextValidation contexts) {
        this.promptBuilder = promptBuilder;
        this.llmClient = llmClient;
        this.images = images;
        this.selection = selection;
        this.contexts = contexts;
    }

    /**
     * 同步执行一次流式聊天，期间通过 onDelta 持续输出台词或描写。
     *
     * @param request 已由入口调用 {@link #validateRequest} 校验的完整上下文
     * @param onDelta 解析出正文时执行的回调，由 Controller 负责发送 SSE
     * @return 模型返回的结束原因，供 Controller 构造 done 事件
     * @throws IOException 模型请求或响应读取失败
     * @throws InterruptedException 当前模型请求被中断
     */
    public String chatStream(ChatApiRequest request, Consumer<SegmentDelta> onDelta)
            throws IOException, InterruptedException {
        Objects.requireNonNull(onDelta, "onDelta 不能为空");

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
        contexts.validate(request);
        InputDto input = request.input();
        images.validateReferences(request);
        if (input.textOf().isBlank() && ImageValidationService.newIds(request).isEmpty()) {
            throw new IllegalArgumentException("用户输入不能为空");
        }
        images.validatePayloads(request, selection.validatePlan(request));
    }
}
