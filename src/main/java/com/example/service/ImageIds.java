package com.example.service;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Pattern;

/** 图片资产编号与消息、角色 ID 独立；提取完整编号避免 img1 命中 img10。 */
public final class ImageIds {
    private static final Pattern ID = Pattern.compile("img[1-9][0-9]*");
    private static final Pattern REFERENCE = Pattern.compile("(?<![A-Za-z0-9_])img[1-9][0-9]*(?![A-Za-z0-9_])");

    private ImageIds() {
    }

    public static void requireValid(String id) {
        if (id == null || id.length() > 200 || !ID.matcher(id).matches())
            throw new IllegalArgumentException("图片编号无效：" + id);
    }

    public static Set<String> referencedIds(String text) {
        Set<String> ids = new LinkedHashSet<>();
        REFERENCE.matcher(text).results().forEach(match -> ids.add(match.group()));
        return ids;
    }
}
