package com.example.service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import com.example.llm.LLMClient;
import com.example.prompt.VisualSelectionPromptBuilder;
import com.example.web.dto.*;
import com.example.web.dto.VisualDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

/** 每个有图片历史的输入均通过模型选图；本类只校验协议，不以关键词推断相关性。 */
@Service
public class VisualSelectionService {
    private final LLMClient client;
    private final ObjectMapper mapper;
    private final VisualSelectionPromptBuilder prompts;
    private final ImageValidationService images;
    private final ContextValidation contexts;
    private final ContextBudgetService budgets;

    public VisualSelectionService(LLMClient client, ObjectMapper mapper, VisualSelectionPromptBuilder prompts,
            ImageValidationService images, ContextValidation contexts, ContextBudgetService budgets) {
        this.client = client;
        this.mapper = mapper;
        this.prompts = prompts;
        this.images = images;
        this.contexts = contexts;
        this.budgets = budgets;
    }

    /** 绑定发送前上下文及观察版本；排除随后补传的字节和计划自身，便于无状态复核。 */
    public String fingerprint(ChatApiRequest request) {
        var node = mapper.valueToTree(request);
        if (node.path("visual").isObject()) {
            var visual = (com.fasterxml.jackson.databind.node.ObjectNode) node.path("visual");
            visual.remove(List.of("plan", "imagePayloads"));
        }
        return ImageValidationService.sha256(node.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** 按目录顺序分批选候选，再统一决策；无历史图时不调用模型。 */
    public Plan select(ChatApiRequest request) throws IOException, InterruptedException {
        contexts.validate(request);
        images.validateReferences(request);
        images.validateLimits(ImageValidationService.newIds(request));
        List<Asset> catalog = ImageValidationService.catalog(request);
        if (catalog.isEmpty())
            return new Plan("ready", List.of(), List.of(), "", fingerprint(request), request.operationId());
        int budget = images.properties().getPlanningInputChars();
        List<List<Asset>> batches = new ArrayList<>();
        List<Asset> batch = new ArrayList<>();
        int size = 0;
        for (Asset asset : catalog) {
            int length = mapper.writeValueAsString(asset).length();
            if (length > budget)
                throw new IllegalArgumentException("单张图片目录超过规划预算");
            if (size + length > budget && !batch.isEmpty()) {
                batches.add(List.copyOf(batch));
                batch.clear();
                size = 0;
            }
            batch.add(asset);
            size += length;
        }
        if (!batch.isEmpty())
            batches.add(List.copyOf(batch));
        int slots = images.properties().getMaxImages() - ImageValidationService.newIds(request).size();
        Plan plan;
        if (batches.size() == 1)
            plan = call(request, catalog, slots, false);
        else {
            Set<String> candidates = new HashSet<>();
            for (List<Asset> group : batches) {
                Plan result = call(request, group, slots, true);
                if ("over_limit".equals(result.status()))
                    return withFingerprint(result, request);
                result.selectedHistoricalImages().forEach(s -> candidates.add(s.assetId()));
                candidates.addAll(result.candidateAssetIds());
            }
            List<Asset> merged = catalog.stream().filter(a -> candidates.contains(a.assetId())).toList();
            if (mapper.writeValueAsString(merged).length() > budget)
                throw new IllegalArgumentException("合并选图候选超过规划预算，请明确本轮参考图片");
            plan = merged.isEmpty() ? new Plan("ready", List.of(), List.of(), "", null, request.operationId())
                    : call(request, merged, slots, false);
        }
        return withFingerprint(plan, request);
    }

    /** 恢复上传顺序，使多图比较不受模型返回顺序影响。 */
    private Plan withFingerprint(Plan p, ChatApiRequest r) {
        List<Selected> ordered = ImageValidationService.catalog(r).stream()
                .flatMap(a -> p.selectedHistoricalImages().stream()
                        .filter(s -> s.assetId().equals(a.assetId())))
                .toList();
        return new Plan(p.status(), ordered, p.candidateAssetIds(), p.message(), fingerprint(r), r.operationId());
    }

    /** 格式或引用错误最多纠正一次；不使用规则匹配作为降级选图方案。 */
    private Plan call(ChatApiRequest r, List<Asset> catalog, int slots, boolean candidatePhase)
            throws IOException, InterruptedException {
        String phase = candidatePhase ? "当前为目录分批候选提取。只判断当前批次中相关的图，不因其他图片未在本批出现而猜测其 ID；候选之后会统一决策。" : "当前为最终选图，判断完整候选中本次真正需要的原图。";
        String correction = phase;
        for (int attempt = 0; attempt < 2; attempt++) {
            var modelRequest = prompts.build(r, catalog, slots, correction);
            budgets.checkModelRequest(modelRequest);
            var response = client.chat(modelRequest);
            try {
                if (!"stop".equals(response.getFinishReason()))
                    throw new IllegalArgumentException("选图输出未完成");
                Plan plan = mapper.readValue(response.getContent(), Plan.class);
                validateSelection(plan, catalog, slots);
                return plan;
            } catch (IOException | IllegalArgumentException e) {
                correction = phase + "上次输出无效，请纠正并仅返回完整合法 JSON。";
            }
        }
        throw new IOException("图片选择结果无效，请重试");
    }

    /** 只验证结构、来源、重复项与预算，不改写模型的语义选择。 */
    public void validateSelection(Plan p, List<Asset> catalog, int slots) {
        if (p == null || !Set.of("ready", "ambiguous", "over_limit").contains(p.status() == null ? "" : p.status())
                || p.selectedHistoricalImages() == null || p.candidateAssetIds() == null)
            throw new IllegalArgumentException("选图结果结构无效");
        Set<String> allowed = new HashSet<>();
        catalog.forEach(a -> allowed.add(a.assetId()));
        Set<String> seen = new HashSet<>();
        for (Selected s : p.selectedHistoricalImages()) {
            if (s == null || !allowed.contains(s.assetId()) || !seen.add(s.assetId()) || s.purpose() == null
                    || s.purpose().isBlank())
                throw new IllegalArgumentException("选图包含非法或重复 ID");
        }
        if (!allowed.containsAll(p.candidateAssetIds())
                || new HashSet<>(p.candidateAssetIds()).size() != p.candidateAssetIds().size())
            throw new IllegalArgumentException("候选图片无效");
        if ("ready".equals(p.status())
                && (p.selectedHistoricalImages().size() > slots || !p.candidateAssetIds().isEmpty()))
            throw new IllegalArgumentException("选图数量超限或状态矛盾");
        if (!"ready".equals(p.status()) && (p.message() == null || p.message().isBlank()))
            throw new IllegalArgumentException("缺少选图提示");
        if ("ambiguous".equals(p.status()) && p.candidateAssetIds().isEmpty())
            throw new IllegalArgumentException("缺少歧义候选");
    }

    /** 正文调用前重新验证计划，将本轮必选图与历史选图合并。 */
    public List<String> validatePlan(ChatApiRequest r) {
        var required = new LinkedHashSet<>(ImageValidationService.newIds(r));
        List<Asset> catalog = ImageValidationService.catalog(r);
        Plan p = r.visual() == null ? null : r.visual().plan();
        if (p == null) {
            if (!catalog.isEmpty())
                throw new IllegalArgumentException("存在图片历史时必须先选图");
        } else {
            validateSelection(p, catalog, images.properties().getMaxImages() - required.size());
            if (!"ready".equals(p.status()) || !fingerprint(r).equals(p.contextFingerprint()))
                throw new IllegalArgumentException("选图计划已失效，请重新选图");
            p.selectedHistoricalImages().forEach(s -> required.add(s.assetId()));
        }
        images.validateLimits(required);
        return List.copyOf(required);
    }
}
