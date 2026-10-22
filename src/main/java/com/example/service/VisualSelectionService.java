package com.example.service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;

import com.example.llm.LLMClient;
import com.example.llm.model.Message;
import com.example.prompt.StateUpdateMaterial;
import com.example.prompt.VisualSelectionPromptBuilder;
import com.example.web.dto.ChatApiRequest;
import com.example.web.dto.VisualDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;

/** 挑图只读取专用语义材料，不向模型暴露存储字段。 */
@Service
public class VisualSelectionService {
    private final LLMClient client;
    private final ObjectMapper mapper;
    private final VisualSelectionPromptBuilder prompts;
    private final ImageValidationService images;
    private final AuxiliaryContextService contexts;

    public VisualSelectionService(LLMClient client, ObjectMapper mapper, VisualSelectionPromptBuilder prompts,
            ImageValidationService images, AuxiliaryContextService contexts) {
        this.client = client;
        this.mapper = mapper;
        this.prompts = prompts;
        this.images = images;
        this.contexts = contexts;
    }

    public String fingerprint(ChatApiRequest request) {
        var node = mapper.valueToTree(request);
        if (node.path("visual").isObject())
            ((ObjectNode) node.path("visual")).remove(List.of("plan", "imagePayloads"));
        return ImageValidationService.sha256(node.toString().getBytes(StandardCharsets.UTF_8));
    }

    public Plan select(ChatApiRequest request) throws IOException, InterruptedException {
        images.validateLimits(ImageValidationService.requiredIds(request));
        var catalog = ImageValidationService.selectableCatalog(request);
        if (catalog.isEmpty()) return withFingerprint(new Plan("ready", List.of(), List.of(), "", null, null), request);
        int slots = images.properties().getMaxImages() - ImageValidationService.requiredIds(request).size();
        ObjectNode background = background(request);
        // 背景最多占一半文字预算，为目录及纠错留出空间，所有批次复用同一投影。
        contexts.fit(background, "选图背景", request.operationId(), contexts.config().selectionInputTokens() / 2,
                data -> prompts.build(data, slots, true, List.of()));
        List<ObjectNode> rows = new ArrayList<>();
        for (Asset asset : catalog) rows.add(catalogEntry(asset, request.operationId()));
        List<List<ObjectNode>> batches = new ArrayList<>();
        int offset = 0;
        while (offset < rows.size()) {
            int low = offset + 1, high = rows.size(), chosen = offset;
            while (low <= high) {
                int mid = (low + high) >>> 1;
                var material = material(background, rows.subList(offset, mid));
                if (contexts.fits(prompts.build(material, slots, true, List.of()), contexts.config().selectionInputTokens())) {
                    chosen = mid;
                    low = mid + 1;
                } else high = mid - 1;
            }
            if (chosen == offset) {
                // 单项本身过长时同样裁减投影，不让文字容量阻塞正文。
                var material = material(background, rows.subList(offset, offset + 1));
                contexts.fit(material, "选图单项", request.operationId(), contexts.config().selectionInputTokens(),
                        data -> prompts.build(data, slots, true, List.of()));
                batches.add(List.of((ObjectNode) material.path("catalog").get(0)));
                offset++;
            } else {
                batches.add(List.copyOf(rows.subList(offset, chosen)));
                offset = chosen;
            }
        }
        Plan result;
        if (batches.size() == 1) result = call(request, material(background, batches.getFirst()), slots, false);
        else {
            Set<String> selected = new LinkedHashSet<>();
            Set<String> ambiguous = new LinkedHashSet<>();
            for (var batch : batches) {
                Plan candidates = call(request, material(background, batch), slots, true);
                candidates.selectedHistoricalImages().forEach(s -> selected.add(s.assetId()));
                ambiguous.addAll(candidates.candidateAssetIds());
            }
            List<ObjectNode> merged = new ArrayList<>();
            rows.stream().filter(a -> selected.contains(a.path("assetId").asText())).forEach(merged::add);
            rows.stream().filter(a -> !selected.contains(a.path("assetId").asText())
                    && ambiguous.contains(a.path("assetId").asText())).forEach(merged::add);
            result = merged.isEmpty() ? new Plan("ready", List.of(), List.of(), "", null, null)
                    : call(request, material(background, merged), slots, false);
        }
        return withFingerprint(result, request);
    }

    private ObjectNode background(ChatApiRequest request) throws IOException, InterruptedException {
        ObjectNode data = contexts.background(request, "选图");
        data.set("story", mapper.valueToTree(request.state().story()));
        var memories = data.putArray("memories");
        request.state().memories().stream().filter(m -> "active".equals(m.value().status()))
                .sorted(Comparator.comparing((com.example.web.dto.StateDtos.Memory m) -> !"manual".equals(m.origin()))
                        .thenComparing(com.example.web.dto.StateDtos.Memory::updatedAt, Comparator.reverseOrder())
                        .thenComparing(com.example.web.dto.StateDtos.Memory::id))
                .forEach(m -> memories.addObject().set("value", mapper.valueToTree(m.value())));
        var goals = data.putArray("goals");
        request.state().goals().stream().filter(g -> !"dismissed".equals(g.value().status()))
                .sorted(Comparator.comparing((com.example.web.dto.StateDtos.Goal g) ->
                        Set.of("completed", "abandoned").contains(g.value().status()))
                        .thenComparing(g -> !"manual".equals(g.origin()))
                        .thenComparing(com.example.web.dto.StateDtos.Goal::updatedAt, Comparator.reverseOrder())
                        .thenComparing(com.example.web.dto.StateDtos.Goal::id))
                .forEach(g -> goals.addObject().set("value", mapper.createObjectNode()
                        .put("description", g.value().description()).put("status", g.value().status())
                        .put("currentFocus", g.value().currentFocus())));
        var message = data.putArray("currentMessages").addObject().put("role", "user")
                .put("text", request.input().textOf());
        var ids = message.putArray("images");
        ImageValidationService.newIds(request).forEach(ids::add);
        var required = data.putArray("requiredImageAssetIds");
        ImageValidationService.requiredIds(request).forEach(required::add);
        contexts.boundCurrentMessages(data, request.operationId());
        return data;
    }

    private ObjectNode catalogEntry(Asset asset, String task) throws IOException, InterruptedException {
        ObjectNode row = mapper.createObjectNode().put("assetId", asset.assetId());
        var sources = row.putArray("sources");
        for (Source source : asset.sources()) {
            if (source instanceof CharacterPhotoSource) sources.addObject().put("type", "character_photo");
            else if (source instanceof MessageSource message)
                sources.addObject().put("type", "message").put("seq", message.seq()).put("text", message.text())
                        .put("imageIndex", message.imageIndex()).put("uploadIndex", message.uploadIndex());
        }
        if (asset.observation() != null) row.set("observation", StateUpdateMaterial.observation(mapper, asset.observation()));
        var uses = row.putArray("recentUses");
        asset.recentUses().forEach(use -> uses.addObject().put("purpose", use.purpose()));
        contexts.boundCatalogEntry(row, task);
        return row;
    }

    private ObjectNode material(ObjectNode background, List<ObjectNode> catalog) {
        ObjectNode data = background.deepCopy();
        var rows = data.putArray("catalog");
        catalog.forEach(row -> rows.add(row.deepCopy()));
        return data;
    }

    private Plan withFingerprint(Plan plan, ChatApiRequest request) {
        var ordered = ImageValidationService.catalog(request).stream().flatMap(a -> plan.selectedHistoricalImages()
                .stream().filter(s -> s.assetId().equals(a.assetId()))).toList();
        return new Plan(plan.status(), ordered, plan.candidateAssetIds(), plan.message(), fingerprint(request), request.operationId());
    }

    private Plan call(ChatApiRequest request, ObjectNode material, int slots, boolean candidatePhase)
            throws IOException, InterruptedException {
        List<Message> correction = List.of();
        for (int attempt = 0; attempt < 2; attempt++) {
            var previous = correction;
            var modelRequest = contexts.fit(material, "选图", request.operationId(), contexts.config().selectionInputTokens(),
                    data -> prompts.build(data, slots, candidatePhase, previous));
            var response = client.chat(modelRequest);
            if (!"stop".equals(response.getFinishReason()) || response.getContent() == null)
                throw new IOException("选图输出未完成");
            try {
                Plan plan = mapper.readerFor(Plan.class)
                        .with(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                        .readValue(response.getContent());
                Set<String> allowed = new HashSet<>();
                material.path("catalog").forEach(a -> allowed.add(a.path("assetId").asText()));
                validateSelection(plan, allowed, slots, candidatePhase);
                if (!candidatePhase && "ready".equals(plan.status())) {
                    var union = new HashSet<>(ImageValidationService.requiredIds(request));
                    plan.selectedHistoricalImages().forEach(s -> union.add(s.assetId()));
                    images.validateLimits(union);
                }
                return plan;
            } catch (IOException | IllegalArgumentException e) {
                if (attempt == 1) throw new IOException("图片选择纠正后仍无效：" + e.getMessage(), e);
                correction = contexts.correction(response.getContent(), e.getMessage());
            }
        }
        throw new IllegalStateException("选图纠错循环未产生结果");
    }

    private void validateSelection(Plan plan, Set<String> allowed, int slots, boolean candidatePhase) {
        if (plan == null || !Set.of("ready", "ambiguous", "over_limit").contains(plan.status() == null ? "" : plan.status())
                || plan.selectedHistoricalImages() == null || plan.candidateAssetIds() == null)
            throw new IllegalArgumentException("选图结果结构无效");
        if (candidatePhase && "over_limit".equals(plan.status()))
            throw new IllegalArgumentException("候选提取阶段不判断最终图片名额");
        Set<String> seen = new HashSet<>();
        for (Selected selected : plan.selectedHistoricalImages())
            if (selected == null || !allowed.contains(selected.assetId()) || !seen.add(selected.assetId())
                    || selected.purpose() == null || selected.purpose().isBlank())
                throw new IllegalArgumentException("选图包含非法或重复 ID，允许编号：" + allowed);
        if (!allowed.containsAll(plan.candidateAssetIds())
                || new HashSet<>(plan.candidateAssetIds()).size() != plan.candidateAssetIds().size())
            throw new IllegalArgumentException("候选图片编号无效，允许编号：" + allowed);
        if (!candidatePhase && "ready".equals(plan.status())
                && (plan.selectedHistoricalImages().size() > slots || !plan.candidateAssetIds().isEmpty()))
            throw new IllegalArgumentException("选图数量超过剩余名额或状态矛盾，剩余名额：" + slots);
        if (!"ready".equals(plan.status()) && (plan.message() == null || plan.message().isBlank()))
            throw new IllegalArgumentException("缺少选图提示");
        if ("ambiguous".equals(plan.status()) && plan.candidateAssetIds().isEmpty())
            throw new IllegalArgumentException("缺少歧义候选");
    }
}
