package com.example.prompt;

import java.util.ArrayList;
import java.util.List;

import com.example.service.ContextLimits;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** 约束模型输出的字段与本次可见编号；事实、引用和写入权限仍由服务端校验。 */
final class StateUpdateResponseSchema {
    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    private StateUpdateResponseSchema() {
    }

    static ObjectNode build(ObjectNode material) {
        var sources = JSON.arrayNode();
        material.path("currentMessages").forEach(message -> sources.add(message.path("id").asText()));
        var definitions = JSON.objectNode();
        definitions.set("sourceMessageIds", array(choice(sources), sources.size()).put("minItems", 1));
        var evidence = JSON.objectNode();
        evidence.set("type", choice("discovery", "decision", "outcome", "correction"));
        evidence.set("sourceMessageId", choice(sources));
        evidence.set("quote", text().put("minLength", 1));
        definitions.set("progressEvidence", object(evidence));

        var memory = JSON.objectNode();
        memory.set("content", text().put("minLength", 1));
        memory.set("scope", choice("session", "character"));
        memory.set("kind", choice("preference", "fact", "agreement", "event"));
        memory.set("epistemicStatus", choice("established", "claim", "hypothesis"));
        memory.set("status", choice("active", "superseded"));
        definitions.set("memoryValue", object(memory));

        var goal = JSON.objectNode();
        goal.set("description", text().put("minLength", 1));
        goal.set("status", choice("candidate", "active", "blocked", "paused", "completed", "abandoned"));
        goal.set("currentFocus", text());
        goal.set("progressSummary", text());
        definitions.set("goalValue", object(goal));
        // 严格 schema 的对象字段全部必需，用非空子集保留目标的局部更新语义。
        var patches = JSON.arrayNode();
        var names = new ArrayList<String>();
        goal.fieldNames().forEachRemaining(names::add);
        for (int mask = 1; mask < (1 << names.size()); mask++) {
            var fields = JSON.objectNode();
            for (int i = 0; i < names.size(); i++) {
                if ((mask & (1 << i)) != 0) fields.set(names.get(i), goal.get(names.get(i)));
            }
            patches.add(object(fields));
        }
        definitions.set("goalPatch", JSON.objectNode().set("anyOf", patches));

        var properties = JSON.objectNode();
        properties.set("visualObservations", observations(material));
        properties.set("storyChanges", storyChanges(material));
        properties.set("memoryChanges", domainChanges(material, "memories", "memoryValue"));
        properties.set("goalChanges", domainChanges(material, "goals", "goalValue"));
        var schema = object(properties);
        schema.set("$defs", definitions);
        return schema;
    }

    private static ObjectNode observations(ObjectNode material) {
        var ids = (ArrayNode) material.path("actualImageAssetIds");
        var fields = JSON.objectNode();
        fields.set("assetId", choice(ids));
        fields.set("summary", text().put("minLength", 1));
        for (String field : List.of("visibleDetails", "extractedText", "uncertainDetails")) {
            fields.set(field, array(text().put("minLength", 1), ContextLimits.COLLECTION_ITEMS));
        }
        return array(object(fields), ids.size()).put("minItems", ids.size());
    }

    private static ObjectNode storyChanges(ObjectNode material) {
        var alternatives = JSON.arrayNode();
        for (boolean list : List.of(false, true)) {
            var ids = JSON.arrayNode();
            for (JsonNode field : material.path("editableStoryFields")) {
                if (material.path("story").path(field.asText()).isArray() == list) ids.add(field.asText());
            }
            if (!ids.isEmpty()) {
                alternatives.add(change("update", choice(ids), list
                        ? array(text().put("minLength", 1), ContextLimits.COLLECTION_ITEMS) : text(), false));
            }
        }
        return alternatives(alternatives, material.path("editableStoryFields").size());
    }

    private static ObjectNode domainChanges(ObjectNode material, String section, String valueDefinition) {
        boolean goal = "goals".equals(section);
        var alternatives = JSON.arrayNode();
        alternatives.add(change("create", choice(""), ref(valueDefinition), goal));
        var ids = JSON.arrayNode();
        for (JsonNode row : material.path(section)) {
            if (!"dismissed".equals(row.path("value").path("status").asText())
                    && (goal ? !row.path("editableFields").isEmpty() : row.path("editable").asBoolean())) {
                ids.add(row.path("id").asText());
            }
        }
        if (!ids.isEmpty()) {
            alternatives.add(change("update", choice(ids), ref(goal ? "goalPatch" : valueDefinition), goal));
        }
        return alternatives(alternatives, ContextLimits.COLLECTION_ITEMS);
    }

    private static ObjectNode change(String action, JsonNode id, JsonNode value, boolean goal) {
        var fields = JSON.objectNode();
        fields.set("action", choice(action));
        fields.set("id", id);
        fields.set("value", value);
        fields.set("reason", text().put("minLength", 1));
        fields.set("sourceMessageIds", ref("sourceMessageIds"));
        if (goal) {
            fields.set("progressEvidence", JSON.objectNode().set("anyOf", JSON.arrayNode()
                    .add(ref("progressEvidence")).add(JSON.objectNode().put("type", "null"))));
        }
        return object(fields);
    }

    private static ObjectNode alternatives(ArrayNode alternatives, int maxItems) {
        // 没有可写剧情字段时只允许空数组，items 仍提供合法的对象 schema。
        return array(alternatives.isEmpty() ? object(JSON.objectNode())
                : JSON.objectNode().set("anyOf", alternatives), maxItems);
    }

    private static ObjectNode object(ObjectNode properties) {
        var schema = JSON.objectNode().put("type", "object").put("additionalProperties", false);
        schema.set("properties", properties);
        var required = schema.putArray("required");
        properties.fieldNames().forEachRemaining(required::add);
        return schema;
    }

    private static ObjectNode array(JsonNode items, int maxItems) {
        var schema = JSON.objectNode().put("type", "array").put("maxItems", maxItems);
        schema.set("items", items);
        return schema;
    }

    private static ObjectNode text() {
        return JSON.objectNode().put("type", "string");
    }

    private static ObjectNode choice(String... values) {
        var options = JSON.arrayNode();
        for (String value : values) options.add(value);
        return choice(options);
    }

    private static ObjectNode choice(ArrayNode values) {
        var schema = text();
        if (!values.isEmpty()) schema.set("enum", values);
        return schema;
    }

    private static ObjectNode ref(String name) {
        return JSON.objectNode().put("$ref", "#/$defs/" + name);
    }
}
