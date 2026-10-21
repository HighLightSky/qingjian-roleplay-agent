package com.example.service;

/** 字符预算只做资源保护，不冒充模型 token 计数。各入口共用同一份限制。 */
public final class ContextLimits {
    private ContextLimits() {}
    public static final int INPUT_CHARS = 2000;
    public static final int MEMORIES = 50;
    public static final int MEMORY_CHARS = 300;
    public static final int GOALS = 20;
    public static final int LIST_ITEMS = 20;
    public static final int STATE_TEXT_CHARS = 2000;
    public static final int EARLIER_HISTORY_CHARS = 20000;
    public static final int CONTEXT_CHARS = 100000;
    public static final int UPDATE_MESSAGES = 200;
    public static final int UPDATE_OUTPUT_TOKENS = 8192;
}
