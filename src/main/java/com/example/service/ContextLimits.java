package com.example.service;

/** 传输与集合资源保护；模型容量单独按部署窗口和实际 token 校验。 */
public final class ContextLimits {
    private ContextLimits() {}
    public static final int COLLECTION_ITEMS = 10000;
    public static final long REQUEST_BYTES = 64L * 1024 * 1024;
}
