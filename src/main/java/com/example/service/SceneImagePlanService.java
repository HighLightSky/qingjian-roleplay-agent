package com.example.service;

import java.io.IOException;
import java.util.*;
import org.springframework.stereotype.Service;
import com.example.config.*;
import com.example.web.dto.*;
import com.example.web.dto.SceneImageDtos.*;
import com.fasterxml.jackson.databind.*;

@Service
public class SceneImagePlanService {
    private final ObjectMapper mapper;
    private final VisionProperties vision;
    private final ImageGenerationProperties config;
    public SceneImagePlanService(ObjectMapper mapper, VisionProperties vision, ImageGenerationProperties config) {
        this.mapper = mapper;
        this.vision = vision;
        this.config = config;
    }

    public Plan resolvePlan(String raw, ChatApiRequest context, DispatchDtos.MessageMeta source) throws IOException {
        int newline = raw.indexOf('\n');
        if (!raw.startsWith("[画面计划]") || newline < 0)
            throw new IllegalArgumentException("缺少完整画面计划");
        var model = mapper.readerFor(ModelPlan.class).with(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                .<ModelPlan>readValue(raw.substring("[画面计划]".length(), newline));
        if (model.action() == null || model.continuity() == null
                || !Set.of("create", "reuse", "unavailable").contains(model.action())
                || !Set.of("new_scene", "continue_scene", "restage").contains(model.continuity()))
            throw new IllegalArgumentException("画面动作或连续性类型无效");
        if (model.previousPlanId() == null)
            throw new IllegalArgumentException("画面计划缺少前序引用字段");
        var generations = visibleGenerations(context);
        VisualDtos.GenerationSource previous = null;
        if (!model.previousPlanId().isEmpty()) {
            if (!model.previousPlanId().matches("gen[1-9][0-9]*"))
                throw new IllegalArgumentException("画面前序引用无效");
            int index = Integer.parseInt(model.previousPlanId().substring(3)) - 1;
            if (index >= generations.size())
                throw new IllegalArgumentException("画面前序引用不存在");
            previous = generations.get(index);
        }
        var frozenReferences = new ArrayList<Reference>();
        for (var reference : model.referenceImages()) {
            var asset = ImageValidationService.catalog(context).stream()
                    .filter(a -> a.assetId().equals(reference.assetId())).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("画面引用不存在的图片资产"));
            var generation = asset.sources().stream()
                    .filter(s -> s instanceof VisualDtos.GenerationSource g && !g.rejected())
                    .map(s -> (VisualDtos.GenerationSource) s)
                    .reduce((left, right) -> left.seq() > right.seq() ? left : right);
            frozenReferences.add(new Reference(reference.assetId(), reference.roles(), reference.scope(),
                    asset.sourceSha256(), generation.map(VisualDtos.GenerationSource::generationId).orElse(null)));
        }
        String status = model.action().equals("create") ? "ready" : model.action();
        String prompt = raw.substring(newline + 1).strip();
        String summary = "";
        if (!status.equals("unavailable")) {
            if (!model.continuity().equals("new_scene") && previous == null)
                throw new IllegalArgumentException("延续画面必须引用有效前幕");
            if (status.equals("reuse") && previous == null)
                throw new IllegalArgumentException("复用画面必须指定有效生成记录");
            validateReferences(model.referenceImages(), context.character().appearancePhotoAssetId());
            var allowed = new HashSet<String>();
            if (context.visual() != null)
                context.visual().imagePayloads().forEach(p -> allowed.add(p.assetId()));
            allowed.add(context.character().appearancePhotoAssetId());
            for (var reference : model.referenceImages())
                if (!allowed.contains(reference.assetId()))
                    throw new IllegalArgumentException("画面引用了本轮未提供的参考图");
            validateTarget(model.target());
            validatePrompt(prompt, model.referenceImages());
            summary = SceneImagePromptAssembler.summary(prompt);
        }
        var plan = new Plan(UUID.randomUUID().toString(), context.state().sessionId(), source.id(), source.seq(),
                source.completedCheckpointVersion(), context.character().profileVersion(),
                previous == null || model.continuity().equals("new_scene")
                        ? UUID.randomUUID().toString()
                        : previous.sceneId(),
                previous == null ? "" : previous.planId(), model.continuity(), model.target(),
                List.copyOf(frozenReferences), prompt, summary, "", status,
                status.equals("unavailable") ? "未配置人物身份图或画面条件不足" : null);
        return new Plan(plan.id(), plan.sessionId(), plan.assistantMessageId(), plan.sourceSeq(),
                plan.sourceCheckpointVersion(), plan.profileVersion(), plan.sceneId(), plan.previousPlanId(),
                plan.continuity(), plan.target(), plan.referenceImages(), plan.prompt(), plan.summary(),
                fingerprint(plan), plan.status(), plan.error());
    }

    public static List<VisualDtos.GenerationSource> visibleGenerations(ChatApiRequest context) {
        var ids = new HashSet<String>();
        if (context.visual() != null)
            context.visual().imagePayloads().forEach(image -> ids.add(image.assetId()));
        return ImageValidationService.catalog(context).stream().filter(asset -> ids.contains(asset.assetId()))
                .flatMap(asset -> asset.sources().stream()
                        .filter(s -> s instanceof VisualDtos.GenerationSource g && !g.rejected())
                        .map(s -> (VisualDtos.GenerationSource) s)
                        .reduce((left, right) -> left.seq() > right.seq() ? left : right).stream())
                .toList();
    }

    public void validateReferences(List<Reference> refs, String identityId) {
        if (identityId == null || refs == null || refs.isEmpty() || refs.size() > vision.getMaxImages())
            throw new IllegalArgumentException("缺少人物身份图或参考图数量超限");
        var ids = new HashSet<String>();
        boolean identity = false;
        for (int i = 0; i < refs.size(); i++) {
            var ref = refs.get(i);
            ImageIds.requireValid(ref.assetId());
            if (!ids.add(ref.assetId()) || ref.scope() == null || ref.scope().isBlank() || ref.roles().isEmpty()
                    || !Set.of("base", "identity", "continuity", "outfit", "environment", "pose", "prop")
                            .containsAll(ref.roles())
                    || (i == 0) != ref.roles().contains("base"))
                throw new IllegalArgumentException("参考图重复、用途或底图顺序无效");
            if (ref.roles().contains("identity")) {
                if (!ref.assetId().equals(identityId))
                    throw new IllegalArgumentException("身份图与角色快照不一致");
                if (i > 1)
                    throw new IllegalArgumentException("人物身份图必须为底图或第二张图");
                identity = true;
            }
        }
        if (!identity)
            throw new IllegalArgumentException("生图必须携带人物身份原图");
    }

    public void validateTarget(Map<String, String> target) {
        if (!target.keySet()
                .equals(Set.of("subject", "outfit", "pose", "environment", "light", "material", "composition", "style"))
                || target.values().stream().anyMatch(String::isBlank))
            throw new IllegalArgumentException("画面目标必须完整提供八项具体描述");
    }

    public void validatePrompt(String prompt, List<Reference> refs) {
        if (prompt == null || prompt.codePointCount(0, prompt.length()) > config.maxPromptCharacters())
            throw new IllegalArgumentException("绘图提示词长度超限");
        SceneImagePromptAssembler.validateReferences(prompt, refs);
    }

    public String fingerprint(Plan plan) {
        try {
            var material = mapper.valueToTree(plan).deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) material)
                    .remove(List.of("fingerprint", "status", "error"));
            // 计划跨后端重启继续使用，指纹不受 Map 的 JVM 迭代顺序影响。
            ((com.fasterxml.jackson.databind.node.ObjectNode) material).set("target",
                    mapper.valueToTree(new TreeMap<>(plan.target())));
            return ImageValidationService.sha256(mapper.writeValueAsBytes(material));
        } catch (IOException e) {
            throw new IllegalArgumentException("画面计划无法序列化", e);
        }
    }
}
