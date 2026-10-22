package com.example.service;

import com.example.web.dto.VisualDtos.MessageSource;
import java.io.IOException;
import java.util.*;
import org.springframework.stereotype.Service;
import com.example.config.ContextProperties;
import com.example.llm.LLMClient;
import com.example.llm.model.ChatRequest;
import com.example.prompt.CompactionPromptBuilder;
import com.example.prompt.PromptBuilder;
import com.example.web.dto.*;
import com.example.web.dto.ContextDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;

/** 每次只计算一批摘要，浏览器以来源版本校验并原子提交。 */
@Service
public class ContextCompactionService {
    private final ContextProperties properties;
    private final ContextValidation validation;
    private final ImageValidationService images;
    private final ContextBudgetService budgets;
    private final LlamaTokenCounter counter;
    private final CompactionPromptBuilder prompts;
    private final PromptBuilder chatPrompts;
    private final LLMClient client;
    private final ObjectMapper mapper;

    public ContextCompactionService(ContextProperties properties, ContextValidation validation,
            ImageValidationService images, ContextBudgetService budgets, LlamaTokenCounter counter,
            CompactionPromptBuilder prompts, PromptBuilder chatPrompts, LLMClient client, ObjectMapper mapper) {
        this.properties = properties;
        this.validation = validation;
        this.images = images;
        this.budgets = budgets;
        this.counter = counter;
        this.prompts = prompts;
        this.chatPrompts = chatPrompts;
        this.client = client;
        this.mapper = mapper;
    }

    public void validateRequest(CompactionRequest request) {
        if (request == null) throw new IllegalArgumentException("压缩请求不能为空");
        StateValidation.id(request.operationId());
        validation.validate(request.context());
        images.validateReferences(request.context());
        if (budgets.compactThroughSeq(request.context()) <= request.context().summary().throughSeq())
            throw new ContextTooLargeException("没有可压缩的较早轮次，最近 " + properties.retainedTurns()
                    + " 轮原文和必需设定、图片将保留，请减少必需输入");
    }

    public CompactionResult compact(CompactionRequest request) throws IOException, InterruptedException {
        validateRequest(request);
        var context = request.context();
        var batch = selectBatch(context);
        int through = batch.getLast().seq();
        if (context.visual() != null) {
            for (var asset : context.visual().assetCatalog()) {
                if (asset.sources().stream().anyMatch(s -> s instanceof MessageSource m && m.seq() <= through) && asset.observation() == null)
                    throw new IllegalArgumentException("压缩前需先完成图片观察：" + asset.assetId());
            }
        }
        var modelRequest = prompts.build(context, batch);
        budgets.checkModelRequest(modelRequest);
        var response = client.chat(modelRequest);
        if (!"stop".equals(response.getFinishReason()) || response.getContent() == null
                || response.getContent().length() > ContextLimits.CONTEXT_CHARS)
            throw new IOException("摘要生成未完成或结果超限");
        String text = validateResult(response.getContent(), context, through);
        var summary = new HistorySummary(text, through, context.summary().version() + 1);
        var updated = new ChatApiRequest(context.character(), context.state(), summary,
                context.history().stream().filter(m -> m.seq() > through).toList(), context.input(),
                context.interactionSettings(), context.visual(), context.operationId());
        long before = counter.count(chatPrompts.buildText(context)).inputTokens();
        long after = counter.count(chatPrompts.buildText(updated)).inputTokens();
        if (after >= before) throw new IOException("摘要未减少上下文占用，未推进覆盖游标");
        return new CompactionResult(request.operationId(), context.state().sessionId(), context.state().sessionVersion(),
                context.state().memoryVersion(), context.summary().version(), context.summary().throughSeq(), through,
                summary, before, after, batch.stream().map(HistoryMessageDto::id).toList(), budgets.fingerprint(context));
    }

    public List<HistoryMessageDto> selectBatch(ChatApiRequest context) throws IOException, InterruptedException {
        int through = budgets.compactThroughSeq(context);
        var eligible = context.history().stream().filter(m -> m.seq() <= through).toList();
        var ends = new ArrayList<Integer>();
        for (int i = 1; i <= eligible.size(); i++)
            if (i == eligible.size() || "user".equals(eligible.get(i).role())) ends.add(i);
        int low = 0, high = ends.size() - 1, chosen = -1;
        while (low <= high) {
            int mid = (low + high) >>> 1;
            ChatRequest modelRequest = prompts.build(context, eligible.subList(0, ends.get(mid)));
            long tokens = counter.count(modelRequest).inputTokens();
            if (tokens <= properties.compactionBatchInputTokens()
                    && tokens + modelRequest.getMaxTokens() + properties.safetyTokens() <= properties.contextWindowTokens()) {
                chosen = mid;
                low = mid + 1;
            } else high = mid - 1;
        }
        if (chosen < 0) throw new ContextTooLargeException("最早一轮与已有摘要超过压缩批次预算，无法保持完整轮次进行压缩");
        return List.copyOf(eligible.subList(0, ends.get(chosen)));
    }

    private String validateResult(String content, ChatApiRequest context, int through)
            throws IOException, InterruptedException {
        var node = mapper.readTree(content);
        if (node == null || !node.isObject() || !node.path("summary").isTextual() || node.path("summary").asText().isBlank())
            throw new IOException("压缩结果缺少非空 summary 字段");
        String text = node.path("summary").textValue();
        if (counter.tokenize(text) > properties.summaryMaxTokens())
            throw new IOException("摘要超过配置的 token 上限");
        if (context.visual() != null) {
            Set<String> references = ImageIds.referencedIds(text);
            for (var asset : context.visual().assetCatalog()) {
                if (asset.sources().stream().anyMatch(s -> s instanceof MessageSource m && m.seq() <= through) && !references.contains(asset.assetId()))
                    throw new IOException("摘要遗漏图片来源引用：" + asset.assetId());
            }
        }
        return text;
    }
}
