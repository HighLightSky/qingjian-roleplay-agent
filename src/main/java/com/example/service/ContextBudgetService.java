package com.example.service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.springframework.stereotype.Service;
import com.example.config.ContextProperties;
import com.example.config.VisionProperties;
import com.example.llm.model.ChatRequest;
import com.example.prompt.PromptBuilder;
import com.example.web.dto.*;
import com.example.web.dto.ContextDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

@Service
public class ContextBudgetService {
    public record Prepared(ChatRequest request, ContextBudget budget) {}
    private final LlamaTokenCounter counter;
    private final PromptBuilder prompts;
    private final ContextProperties properties;
    private final VisionProperties vision;
    private final ContextValidation validation;
    private final ImageValidationService images;
    private final ObjectMapper mapper;

    public ContextBudgetService(LlamaTokenCounter counter, PromptBuilder prompts, ContextProperties properties,
            VisionProperties vision, ContextValidation validation, ImageValidationService images, ObjectMapper mapper) {
        this.counter = counter;
        this.prompts = prompts;
        this.properties = properties;
        this.vision = vision;
        this.validation = validation;
        this.images = images;
        this.mapper = mapper;
    }

    public ContextBudget inspect(BudgetRequest request) throws IOException, InterruptedException {
        if (request == null || request.mode() == null || !Set.of("preview", "required", "final").contains(request.mode()))
            throw new IllegalArgumentException("上下文预算模式无效");
        validation.validate(request.context());
        images.validateReferences(request.context());
        var metadata = new LinkedHashMap<String, ImageMetadata>();
        for (var image : request.images()) {
            if (image == null || image.assetId() == null || image.assetId().isBlank() || image.width() < 1
                    || image.height() < 1 || (long) image.width() * image.height() > vision.getMaxPixels()
                    || metadata.put(image.assetId(), image) != null)
                throw new IllegalArgumentException("预算图片尺寸或引用无效");
        }
        if (metadata.size() > vision.getMaxImages()) throw new IllegalArgumentException("预算图片数量超限");
        var catalog = ImageValidationService.catalog(request.context());
        for (var asset : catalog) metadata.putIfAbsent(asset.assetId(), new ImageMetadata(asset.assetId(), asset.width(), asset.height()));
        Set<String> selected = new LinkedHashSet<>(ImageValidationService.requiredIds(request.context()));
        if ("final".equals(request.mode()) && request.context().visual() != null && request.context().visual().plan() != null)
            request.context().visual().plan().selectedHistoricalImages().forEach(s -> {
                if (catalog.stream().noneMatch(a -> a.assetId().equals(s.assetId())))
                    throw new IllegalArgumentException("预算选图引用不可用的历史原图：" + s.assetId());
                selected.add(s.assetId());
            });
        if ("preview".equals(request.mode())) {
            catalog.stream().filter(a -> !selected.contains(a.assetId()))
                    .sorted(Comparator.comparingLong((VisualDtos.Asset a) -> counter.estimateImageTokens(a.width(), a.height())).reversed())
                    .limit(Math.max(0, vision.getMaxImages() - selected.size())).forEach(a -> selected.add(a.assetId()));
        }
        images.validateLimits(selected);
        var sizes = new ArrayList<ImageMetadata>();
        for (String id : selected) {
            var size = metadata.get(id);
            if (size == null) throw new IllegalArgumentException("预算缺少图片尺寸：" + id);
            sizes.add(size);
        }
        ChatRequest modelRequest = prompts.buildText(request.context());
        TokenCount count = counter.countText(modelRequest, sizes);
        var budget = evaluate(count, modelRequest.getMaxTokens(), compactThroughSeq(request.context()));
        if ("preview".equals(request.mode()) && !catalog.isEmpty())
            budget = new ContextBudget(budget.inputTokens(), budget.contextWindowTokens(), budget.usageRatio(),
                    budget.outputReserveTokens(), budget.safetyTokens(), "estimated", budget.needsCompaction(),
                    budget.fits(), budget.requestFingerprint(), budget.compactThroughSeq());
        return budget;
    }

    /** 正文入口已校验原图和请求结构，此处按实际模型请求计数。 */
    public Prepared prepare(ChatApiRequest context) throws IOException, InterruptedException {
        ChatRequest request = prompts.build(context);
        return new Prepared(request, evaluate(counter.count(request), request.getMaxTokens(), compactThroughSeq(context)));
    }

    public ContextBudget evaluate(TokenCount count, int outputLimit, int compactThroughSeq) {
        double ratio = (double) count.inputTokens() / properties.contextWindowTokens();
        boolean fits = count.inputTokens() + outputLimit + properties.safetyTokens() <= properties.contextWindowTokens();
        return new ContextBudget(count.inputTokens(), properties.contextWindowTokens(), ratio, outputLimit,
                properties.safetyTokens(), count.accuracy(), ratio >= properties.compactionTriggerRatio() || !fits,
                fits, count.requestFingerprint(), compactThroughSeq);
    }

    public void requireSendable(ContextBudget budget) {
        if (!budget.fits()) throw new ContextTooLargeException("上下文输入 " + budget.inputTokens()
                + " token，加上输出预留 " + budget.outputReserveTokens() + " 和安全余量后超过窗口 "
                + budget.contextWindowTokens() + "，请先压缩较早历史或减少必需输入");
    }

    public boolean modelRequestFits(ChatRequest request) throws IOException, InterruptedException {
        return evaluate(counter.count(request), request.getMaxTokens(), 0).fits();
    }

    public void checkModelRequest(ChatRequest request) throws IOException, InterruptedException {
        requireSendable(evaluate(counter.count(request), request.getMaxTokens(), 0));
    }

    public int compactThroughSeq(ChatApiRequest context) {
        var starts = new ArrayList<Integer>();
        for (int i = 0; i < context.history().size(); i++)
            if ("user".equals(context.history().get(i).role())) starts.add(i);
        if (starts.size() <= properties.retainedTurns()) return context.summary().throughSeq();
        int retainedStart = starts.get(starts.size() - properties.retainedTurns());
        return context.history().get(retainedStart - 1).seq();
    }

    public String fingerprint(ChatApiRequest context) {
        ObjectNode node = mapper.valueToTree(context);
        node.remove("operationId");
        if (node.path("visual").isObject()) ((ObjectNode) node.path("visual")).remove(List.of("imagePayloads", "plan"));
        return ImageValidationService.sha256(node.toString().getBytes(StandardCharsets.UTF_8));
    }
}
