package com.example.service;

import java.util.*;
import com.example.web.dto.StateDtos.*;

/** 聊天、选图、整理入口共用的领域边界约束。 */
public final class StateValidation {
    public static final Set<String> STORY_FIELDS = Set.of("location", "storyTime", "characterState", "userState",
            "presentCharacters", "relationships", "items", "openThreads");

    private StateValidation() {
    }

    public static void snapshot(Snapshot s) {
        if (s == null || s.story() == null || s.sessionVersion() < 0 || s.memoryVersion() < 0
                || s.processedThroughSeq() < 0)
            throw new IllegalArgumentException("领域快照或版本无效");
        id(s.sessionId());
        id(s.characterId());
        story(s.story());
        for (var entry : s.storySources().entrySet()) {
            if (!STORY_FIELDS.contains(entry.getKey()))
                throw new IllegalArgumentException("剧情来源字段无效");
            origin(entry.getValue().origin());
            date(entry.getValue().updatedAt());
            sources(entry.getValue().sourceMessageIds());
        }
        if (s.memories().size() > ContextLimits.MEMORIES || s.goals().size() > ContextLimits.GOALS)
            throw new IllegalArgumentException("记忆或目标数量超过限制");
        Set<String> ids = new HashSet<>();
        for (Memory m : s.memories()) {
            if (m == null || !ids.add(m.id()) || !s.characterId().equals(m.characterId()) || m.version() < 1)
                throw new IllegalArgumentException("记忆来源、版本或 ID 无效");
            id(m.id());
            memory(m.value());
            if ("session".equals(m.value().scope()) && !s.sessionId().equals(m.sessionId()))
                throw new IllegalArgumentException("不能读取其他会话的记忆");
            if ("character".equals(m.value().scope()) && m.sessionId() != null)
                throw new IllegalArgumentException("共享记忆不能绑定会话");
            origin(m.origin());
            date(m.updatedAt());
            sources(m.sourceMessageIds());
        }
        ids.clear();
        for (Goal g : s.goals()) {
            if (g == null || !ids.add(g.id()) || !s.sessionId().equals(g.sessionId()) || g.version() < 1)
                throw new IllegalArgumentException("目标来源、版本或 ID 无效");
            id(g.id());
            goal(g.value());
            origin(g.origin());
            date(g.updatedAt());
            sources(g.sourceMessageIds());
        }
    }

    public static void story(Story s) {
        text(s.location(), ContextLimits.STATE_TEXT_CHARS);
        text(s.storyTime(), ContextLimits.STATE_TEXT_CHARS);
        text(s.characterState(), ContextLimits.STATE_TEXT_CHARS);
        text(s.userState(), ContextLimits.STATE_TEXT_CHARS);
        strings(s.presentCharacters());
        strings(s.relationships());
        strings(s.items());
        strings(s.openThreads());
    }

    public static void memory(MemoryValue v) {
        if (v == null)
            throw new IllegalArgumentException("记忆内容缺失");
        nonblank(v.content(), ContextLimits.MEMORY_CHARS);
        choice(v.scope(), Set.of("character", "session"), "记忆范围");
        choice(v.kind(), Set.of("preference", "fact", "agreement", "event"), "记忆类型");
        choice(v.epistemicStatus(), Set.of("established", "claim", "hypothesis"), "事实类别");
        choice(v.status(), Set.of("active", "superseded", "dismissed"), "记忆状态");
    }

    public static void goal(GoalValue v) {
        if (v == null)
            throw new IllegalArgumentException("目标内容缺失");
        nonblank(v.description(), ContextLimits.STATE_TEXT_CHARS);
        choice(v.status(), Set.of("candidate", "active", "blocked", "paused", "completed", "abandoned", "dismissed"),
                "目标状态");
        text(v.currentFocus(), ContextLimits.STATE_TEXT_CHARS);
        text(v.progressSummary(), ContextLimits.STATE_TEXT_CHARS);
    }

    public static void strings(List<String> values) {
        if (values.size() > ContextLimits.LIST_ITEMS)
            throw new IllegalArgumentException("状态列表数量超限");
        for (String v : values)
            nonblank(v, ContextLimits.STATE_TEXT_CHARS);
    }

    public static void sources(List<String> values) {
        if (values.size() > ContextLimits.UPDATE_MESSAGES)
            throw new IllegalArgumentException("来源数量超限");
        Set<String> ids = new HashSet<>();
        for (String v : values) {
            id(v);
            if (!ids.add(v))
                throw new IllegalArgumentException("来源 ID 重复");
        }
    }

    public static void date(String value) {
        text(value, 100);
        try {
            java.time.Instant.parse(value);
        } catch (java.time.DateTimeException e) {
            throw new IllegalArgumentException("领域时间无效", e);
        }
    }
    public static void origin(String value) {
        choice(value, Set.of("manual", "automatic"), "维护来源");
    }

    public static void id(String value) {
        nonblank(value, 200);
    }

    public static void nonblank(String value, int max) {
        text(value, max);
        if (value.isBlank())
            throw new IllegalArgumentException("必需文字不能为空");
    }

    public static void text(String value, int max) {
        if (value == null || value.length() > max)
            throw new IllegalArgumentException("必需文字缺失或超过 " + max + " 字符");
    }

    private static void choice(String value, Set<String> values, String label) {
        if (value == null || !values.contains(value))
            throw new IllegalArgumentException(label + "无效");
    }
}
