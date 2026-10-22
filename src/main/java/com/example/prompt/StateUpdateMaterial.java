package com.example.prompt;

import java.io.IOException;
import java.util.*;

import com.example.service.AuxiliaryContextService;
import com.example.web.dto.StateDtos.*;
import com.example.web.dto.VisualDtos.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** 编号和冻结快照一一对应；裁减及纠错不会重新编号。 */
public final class StateUpdateMaterial {
    private final ObjectNode data;
    private final Map<String, Memory> memories = new LinkedHashMap<>();
    private final Map<String, Goal> goals = new LinkedHashMap<>();
    private final Map<String, SourceMessage> messages = new LinkedHashMap<>();
    private final ObjectMapper mapper;
    private final UpdateRequest request;

    public StateUpdateMaterial(UpdateRequest request, ObjectMapper mapper, AuxiliaryContextService contexts)
            throws IOException, InterruptedException {
        this.request = request;
        this.mapper = mapper;
        data = contexts.background(request.context(), "整理");
        data.set("story", mapper.valueToTree(request.context().state().story()));
        var edits = data.putObject("manualStoryEdits");
        request.context().state().storySources().forEach((field, source) -> {
            if ("manual".equals(source.origin())) edits.put(field, source.updatedAt());
        });
        var memoryRows = data.putArray("memories");
        request.context().state().memories().stream().sorted(Comparator
                .comparing((Memory m) -> !"active".equals(m.value().status()))
                .thenComparing(m -> !"manual".equals(m.origin()))
                .thenComparingInt(m -> switch (m.value().kind()) {
                    case "agreement" -> 0;
                    case "preference" -> 1;
                    default -> 2;
                })
                .thenComparing(Memory::updatedAt, Comparator.reverseOrder()).thenComparing(Memory::id))
                .forEach(m -> {
                    String alias = "mem" + (memories.size() + 1);
                    memories.put(alias, m);
                    var row = memoryRows.addObject().put("id", alias).put("origin", m.origin());
                    row.set("value", mapper.valueToTree(m.value()));
                    if ("manual".equals(m.origin())) row.put("updatedAt", m.updatedAt());
                });
        var goalRows = data.putArray("goals");
        request.context().state().goals().stream().sorted(Comparator
                .comparing((Goal g) -> Set.of("completed", "abandoned", "dismissed").contains(g.value().status()))
                .thenComparing(g -> !"manual".equals(g.origin()))
                .thenComparing(Goal::updatedAt, Comparator.reverseOrder()).thenComparing(Goal::id))
                .forEach(g -> {
                    String alias = "goal" + (goals.size() + 1);
                    goals.put(alias, g);
                    var row = goalRows.addObject().put("id", alias).put("origin", g.origin());
                    row.set("value", mapper.valueToTree(g.value()));
                    if ("manual".equals(g.origin())) row.put("updatedAt", g.updatedAt());
                });
        var current = data.putArray("currentMessages");
        for (var message : request.messages()) {
            String alias = "msg" + (messages.size() + 1);
            messages.put(alias, message);
            current.addObject().put("id", alias).put("role", message.role()).put("text", message.text())
                    .put("createdAt", message.createdAt());
        }
        contexts.boundCurrentMessages(data, request.operationId());
        var ids = data.putArray("actualImageAssetIds");
        var images = data.putArray("images");
        if (request.context().visual() != null) {
            for (var payload : request.context().visual().imagePayloads()) {
                ids.add(payload.assetId());
                var image = images.addObject().put("assetId", payload.assetId());
                var sourceTypes = image.putArray("sourceTypes");
                request.context().visual().assetCatalog().stream().filter(a -> a.assetId().equals(payload.assetId()))
                        .findFirst().ifPresent(a -> {
                            a.sources().stream().map(source -> source instanceof CharacterPhotoSource
                                    ? "character_photo" : "history").distinct().forEach(sourceTypes::add);
                            if (a.observation() != null) image.set("observation", observation(mapper, a.observation()));
                        });
                if (request.context().input().content().stream().anyMatch(p -> "image".equals(p.type())
                        && payload.assetId().equals(p.assetId()))) sourceTypes.add("current");
                if (request.context().visual().plan() != null)
                    request.context().visual().plan().selectedHistoricalImages().stream()
                            .filter(s -> s.assetId().equals(payload.assetId())).findFirst()
                            .ifPresent(s -> image.put("purpose", s.purpose()));
            }
        }
    }

    public void updatePermissions() {
        var fields = data.putArray("editableStoryFields");
        JsonNode story = mapper.valueToTree(request.context().state().story());
        story.fieldNames().forEachRemaining(field -> {
            if (data.path("story").has(field) && data.path("story").path(field).equals(story.path(field))) fields.add(field);
        });
        for (JsonNode node : data.path("goals")) {
            var row = (ObjectNode) node;
            var old = goals.get(row.path("id").asText());
            JsonNode value = mapper.valueToTree(old.value());
            var editable = row.putArray("editableFields");
            value.fieldNames().forEachRemaining(field -> {
                if (row.path("value").has(field) && row.path("value").path(field).equals(value.path(field))) editable.add(field);
            });
        }
        for (JsonNode node : data.path("memories")) {
            var row = (ObjectNode) node;
            var old = memories.get(row.path("id").asText());
            row.put("editable", row.path("value").equals(mapper.valueToTree(old.value())));
        }
    }

    public ObjectNode data() { return data; }

    public static ObjectNode observation(ObjectMapper mapper, Observation observation) {
        var node = mapper.createObjectNode().put("summary", observation.summary());
        node.set("visibleDetails", mapper.valueToTree(observation.visibleDetails()));
        node.set("extractedText", mapper.valueToTree(observation.extractedText()));
        node.set("uncertainDetails", mapper.valueToTree(observation.uncertainDetails()));
        return node;
    }

    private JsonNode provided(String section, String alias) throws IOException {
        for (var row : data.path(section)) if (alias.equals(row.path("id").asText())) return row;
        throw new IOException("引用了未提供的" + section + "编号：" + alias);
    }

    public String resolve(String kind, String alias) throws IOException {
        Map<String, ?> map = switch (kind) {
            case "memory" -> memories;
            case "goal" -> goals;
            case "message" -> messages;
            default -> throw new IllegalArgumentException("未知整理编号类型：" + kind);
        };
        Object value = map.get(alias);
        if (value == null) throw new IOException("未知或类型错误的" + kind + "编号：" + alias);
        provided(switch (kind) {
            case "memory" -> "memories";
            case "goal" -> "goals";
            default -> "currentMessages";
        }, alias);
        return switch (value) {
            case Memory memory -> memory.id();
            case Goal goal -> goal.id();
            case SourceMessage message -> message.id();
            default -> throw new IllegalArgumentException("未知整理对象类型：" + kind);
        };
    }

    public void requireWritableStory(String field) throws IOException {
        JsonNode old = mapper.valueToTree(request.context().state().story());
        if (!data.path("story").has(field) || !data.path("story").path(field).equals(old.path(field)))
            throw new IOException("剧情字段未完整提供，不能覆盖：" + field);
    }

    public void requireWritableValue(String kind, String alias, JsonNode old, Set<String> fields) throws IOException {
        JsonNode shown = provided("memory".equals(kind) ? "memories" : "goals", alias).path("value");
        for (String field : fields)
            if (!shown.has(field) || !shown.path(field).equals(old.path(field)))
                throw new IOException("旧字段未完整提供，不能覆盖：" + alias + "." + field);
    }

    public void validateEvidence(JsonNode evidence, List<String> sourceAliases) throws IOException {
        if (evidence == null || !evidence.isObject() || evidence.size() != 3
                || !Set.of("discovery", "decision", "outcome", "correction").contains(evidence.path("type").asText()))
            throw new IOException("进展摘要更新缺少有效 progressEvidence 类型");
        if (!evidence.path("sourceMessageId").isTextual() || !evidence.path("quote").isTextual())
            throw new IOException("进展证据的来源编号与原文引用必须是字符串");
        String alias = evidence.path("sourceMessageId").asText();
        resolve("message", alias);
        String quote = evidence.path("quote").asText();
        String visible = provided("currentMessages", alias).path("text").asText();
        String original = messages.get(alias).text();
        if (!sourceAliases.contains(alias) || quote.isBlank() || !visible.contains(quote) || !original.contains(quote))
            throw new IOException("进展证据必须引用本轮可见原文，不能引用历史、摘要或截断标记");
    }
}
