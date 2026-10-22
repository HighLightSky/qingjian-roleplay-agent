package com.example.service;

import java.io.IOException;
import java.util.*;
import com.example.llm.LLMClient;
import com.example.llm.model.ChatResponse;
import com.example.llm.model.Message;
import com.example.prompt.StateUpdatePromptBuilder;
import com.example.web.dto.StateDtos.*;
import com.example.web.dto.VisualDtos.*;
import com.fasterxml.jackson.databind.*;
import org.springframework.stereotype.Service;

/** 无状态统一整理：服务端校验模型的结构和来源，浏览器负责版本检查与原子提交。 */
@Service
public class StateUpdateService {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(StateUpdateService.class);
    private final LLMClient client;
    private final ObjectMapper mapper;
    private final StateUpdatePromptBuilder prompts;
    private final ContextBudgetService budgets;
    private final ImageValidationService images;

    public StateUpdateService(LLMClient client, ObjectMapper mapper, StateUpdatePromptBuilder prompts,
            ImageValidationService images, ContextBudgetService budgets) {
        this.client = client;
        this.mapper = mapper;
        this.prompts = prompts;
        this.budgets = budgets;
        this.images = images;
    }

    public Result update(UpdateRequest r) throws IOException, InterruptedException {
        String material = prompts.material(r);
        List<Message> correction = List.of();
        for (int attempt = 0;; attempt++) {
            var modelRequest = prompts.build(r, material, correction);
            budgets.checkModelRequest(modelRequest);
            var response = client.chat(modelRequest);
            if (response.getContent() == null)
                throw new IOException("状态整理结果缺失");
            if (!"stop".equals(response.getFinishReason())) {
                String message = incompleteOutputMessage(response, modelRequest.getMaxTokens());
                log.warn("{}", message);
                throw new IOException(message);
            }
            try {
                return parseResult(response.getContent(), r);
            } catch (IOException e) {
                if (attempt == 1)
                    throw new IOException("状态整理结果纠正后仍无效：" + e.getMessage(), e);
                correction = List.of(new Message("assistant", response.getContent()),
                        new Message("user", "上次整理结果未通过校验：" + e.getMessage()
                                + "。请纠正上面的结果，逐项核对本次返回模板中的 assetId 字段，"
                                + "保留真实原图 ID，重新返回四个数组组成的完整 JSON。"));
            }
        }
    }

    private String incompleteOutputMessage(ChatResponse response, int outputLimit) {
        String finishReason = switch (response.getFinishReason()) {
            case null -> "缺失（上游未返回）";
            case "length" -> "length（模型因长度限制停止生成）";
            default -> response.getFinishReason();
        };
        var usage = response.getUsage();
        String usageDetails = "reported".equals(usage.status())
                ? "输入 token=" + usage.inputTokens() + "；输出 token=" + usage.outputTokens()
                        + "；总 token=" + usage.totalTokens()
                : "token 用量=上游未提供";
        return "状态整理输出未完成：finish_reason=" + finishReason
                + "；本次输出上限=" + outputLimit + " token；" + usageDetails
                + "；已返回正文=" + response.getContent().length() + " 字符";
    }

    private Result parseResult(String content, UpdateRequest r) throws IOException {
        try {
            JsonNode node = mapper.readTree(content);
            for (String field : List.of("visualObservations", "storyChanges", "memoryChanges", "goalChanges"))
                if (node == null || !node.path(field).isArray())
                    throw new IOException("整理结果缺少数组：" + field);
            ModelResult result = mapper.treeToValue(node, ModelResult.class);
            List<Change> story = changes(result.storyChanges(), "story", r);
            List<Change> memories = changes(result.memoryChanges(), "memory", r);
            List<Change> goals = changes(result.goalChanges(), "goal", r);
            var state = r.context().state();
            if (state.memories().size()
                    + memories.stream().filter(c -> "create".equals(c.action()))
                            .count() > ContextLimits.COLLECTION_ITEMS
                    || state.goals().size()
                            + goals.stream().filter(c -> "create".equals(c.action()))
                                    .count() > ContextLimits.COLLECTION_ITEMS)
                throw new IOException("整理结果使记忆或目标数量超限");
            return new Result(r.operationId(), state.sessionVersion(), state.memoryVersion(), r.fromExclusiveSeq(),
                    r.throughSeq(), observations(result.visualObservations(), r), story, memories, goals);
        } catch (IllegalArgumentException e) {
            throw new IOException("整理结果无效：" + e.getMessage(), e);
        }
    }

    public void validateRequest(UpdateRequest r) {
        if (r == null)
            throw new IllegalArgumentException("整理请求不能为空");
        StateValidation.id(r.operationId());
        if (!r.operationId().equals(r.context().operationId())
                || r.fromExclusiveSeq() < 0
                || r.throughSeq() <= r.fromExclusiveSeq() || r.messages().isEmpty()
                || r.messages().size() > ContextLimits.COLLECTION_ITEMS)
            throw new IllegalArgumentException("整理操作、消息区间或游标无效");
        Set<String> ids = new HashSet<>();
        int previous = r.fromExclusiveSeq();
        for (SourceMessage m : r.messages()) {
            if (m == null || m.seq() <= previous || m.seq() > r.throughSeq() || !ids.add(m.id())
                    || m.role() == null || !Set.of("user", "assistant").contains(m.role())
                    || !"complete".equals(m.status()))
                throw new IllegalArgumentException("整理消息来源、顺序或完成状态无效");
            StateValidation.id(m.id());
            StateValidation.date(m.createdAt());
            StateValidation.nonblank(m.text());
            previous = m.seq();
        }
        SourceMessage last = r.messages().getLast();
        if (last.seq() != r.throughSeq() || !"assistant".equals(last.role()))
            throw new IllegalArgumentException("整理范围必须以完整正文结束");
        Set<String> required = new HashSet<>(ImageValidationService.requiredIds(r.context()));
        if (r.context().visual() != null && r.context().visual().plan() != null) {
            for (Selected selected : r.context().visual().plan().selectedHistoricalImages()) {
                if (ImageValidationService.catalog(r.context()).stream()
                        .noneMatch(a -> a.assetId().equals(selected.assetId())))
                    throw new IllegalArgumentException("整理历史原图来源无效");
                required.add(selected.assetId());
            }
        }
        images.validateLimits(required);
    }

    private List<Change> changes(List<ProposedChange> proposals, String kind, UpdateRequest r) throws IOException {
        int limit = switch (kind) {
            case "memory" -> ContextLimits.COLLECTION_ITEMS;
            case "goal" -> ContextLimits.COLLECTION_ITEMS;
            default -> StateValidation.STORY_FIELDS.size();
        };
        if (proposals.size() > limit)
            throw new IOException("整理变更数量超限");
        Set<String> sources = new HashSet<>();
        r.messages().forEach(m -> sources.add(m.id()));
        Set<String> targets = new HashSet<>();
        List<Change> changes = new ArrayList<>();
        Snapshot s = r.context().state();
        for (ProposedChange p : proposals) {
            if (p == null || p.action() == null || !Set.of("create", "update").contains(p.action())
                    || p.value() == null || p.value().isNull())
                throw new IOException("领域变更结构无效");
            StateValidation.nonblank(p.reason());
            StateValidation.sources(p.sourceMessageIds());
            if (p.sourceMessageIds().isEmpty() || !sources.containsAll(p.sourceMessageIds()))
                throw new IOException("领域变更缺少有效的新消息来源");
            boolean create = "create".equals(p.action());
            JsonNode before;
            JsonNode value;
            int version;
            if ("story".equals(kind)) {
                if (create || p.id() == null || !StateValidation.STORY_FIELDS.contains(p.id()))
                    throw new IOException("剧情字段或操作无效");

                var full = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.valueToTree(s.story());
                before = full.get(p.id());
                full.set(p.id(), p.value());
                Story newStory = mapper.treeToValue(full, Story.class);
                StateValidation.story(newStory);
                value = mapper.valueToTree(newStory).get(p.id());
                var source = s.storySources().get(p.id());
                if (source != null && "manual".equals(source.origin())) {
                    requireNewEvidence(p, source.updatedAt(), r);
                }

                version = s.sessionVersion();
            } else if ("memory".equals(kind)) {
                var v = mapper.treeToValue(p.value(), MemoryValue.class);
                StateValidation.memory(v);
                if ("dismissed".equals(v.status()))
                    throw new IOException("模型不能人工删除记忆");
                Memory old = create ? null
                        : s.memories().stream().filter(m -> m.id().equals(p.id())).findFirst()
                                .orElseThrow(() -> new IOException("修改了不存在的记忆"));

                if (old != null && (!old.value().scope().equals(v.scope()) || "dismissed".equals(old.value().status())))
                    throw new IOException("不能修改记忆范围或恢复人工删除记录");
                if (old != null && "manual".equals(old.origin())) {
                    requireNewEvidence(p, old.updatedAt(), r);
                }
                if (create) {
                    for (Memory existing : s.memories()) {
                        if (existing.value().scope().equals(v.scope())
                                && existing.value().content().equals(v.content())) {
                            if (!"dismissed".equals(existing.value().status())) {
                                throw new IOException("不能重复新增相同记忆");
                            }
                            requireNewEvidence(p, existing.updatedAt(), r);
                        }
                    }
                }

                before = old == null ? mapper.nullNode() : mapper.valueToTree(old.value());
                value = mapper.valueToTree(v);
                version = old == null ? 0 : old.version();
            } else {
                var v = mapper.treeToValue(p.value(), GoalValue.class);
                StateValidation.goal(v);
                if ("dismissed".equals(v.status()))
                    throw new IOException("模型不能人工删除目标");

                Goal old = create ? null
                        : s.goals().stream().filter(g -> g.id().equals(p.id())).findFirst()
                                .orElseThrow(() -> new IOException("修改了不存在的目标"));
                if (old != null && "dismissed".equals(old.value().status()))
                    throw new IOException("不能恢复人工删除的目标");
                if (old != null && "manual".equals(old.origin())) {
                    requireNewEvidence(p, old.updatedAt(), r);
                }
                if (create) {
                    for (Goal existing : s.goals()) {
                        if (existing.value().description().equals(v.description())) {
                            if (!"dismissed".equals(existing.value().status())) {
                                throw new IOException("不能重复新增相同目标");
                            }
                            requireNewEvidence(p, existing.updatedAt(), r);
                        }
                    }
                }
                before = old == null ? mapper.nullNode() : mapper.valueToTree(old.value());
                value = mapper.valueToTree(v);
                version = old == null ? 0 : old.version();
            }
            if (create && !"".equals(p.id()))
                throw new IOException("新增领域项不能指定 ID");
            if (p.expectedVersion() != version)
                throw new IOException("整理变更版本无效");
            if (before.equals(value))
                throw new IOException("整理返回了无变化的修改");
            String id = create ? UUID.randomUUID().toString() : p.id();
            if (!targets.add(id))
                throw new IOException("同一领域项出现重复变更");
            changes.add(new Change(p.action(), id, version, before, value, p.reason(), p.sourceMessageIds()));
        }
        return changes;
    }

    private void requireNewEvidence(ProposedChange change, String editedAt, UpdateRequest request) throws IOException {
        var edited = java.time.Instant.parse(editedAt);
        boolean newer = request.messages().stream().anyMatch(m -> change.sourceMessageIds().contains(m.id())
                && java.time.Instant.parse(m.createdAt()).isAfter(edited));
        if (!newer) {
            throw new IOException("人工修改后没有新的对话依据，不能覆盖该内容");
        }
    }

    private List<Observation> observations(List<Observation> values, UpdateRequest r) throws IOException {
        List<Payload> payloads = r.context().visual() == null ? List.of() : r.context().visual().imagePayloads();
        Set<String> expected = new LinkedHashSet<>();
        payloads.forEach(p -> expected.add(p.assetId()));
        Set<String> seen = new HashSet<>();
        List<Observation> result = new ArrayList<>();
        for (Observation o : values) {
            if (!expected.contains(o.assetId()))
                throw new IOException("视觉观察引用了未传入的原图：" + o.assetId() + "；本次原图 ID：" + expected);
            if (!seen.add(o.assetId()))
                throw new IOException("同一原图重复返回视觉观察：" + o.assetId());
            StateValidation.visualContent(o);
            var previous = ImageValidationService.catalog(r.context()).stream()
                    .filter(a -> a.assetId().equals(o.assetId())).findFirst();
            int version = previous.map(Asset::observation).map(Observation::version).orElse(0) + 1;
            List<Source> sources = new ArrayList<>(previous.map(Asset::sources).orElse(List.of()));
            int index = ImageValidationService.newIds(r.context()).indexOf(o.assetId()) + 1;
            if (index > 0) {
                var user = r.messages().stream().filter(m -> "user".equals(m.role())).reduce((a, b) -> b)
                        .orElseThrow(() -> new IllegalArgumentException("新图片缺少上传消息"));
                int uploads = ImageValidationService.catalog(r.context()).stream().flatMap(a -> a.sources().stream())
                        .filter(s -> s instanceof MessageSource).mapToInt(s -> ((MessageSource) s).uploadIndex())
                        .max().orElse(0);
                sources.add(
                        new MessageSource(user.id(), user.seq(), r.context().input().textOf(), index, uploads + index));
            }
            result.add(new Observation(o.assetId(), o.summary(), o.visibleDetails(), o.extractedText(),
                    o.uncertainDetails(), List.copyOf(sources), version));
        }
        expected.removeAll(seen);
        if (!expected.isEmpty())
            throw new IOException("视觉观察缺少本次原图：" + expected);
        return result;
    }
}
