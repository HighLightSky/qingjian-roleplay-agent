package com.example.service;

import java.util.*;
import java.util.regex.Pattern;
import com.example.web.dto.SceneImageDtos.Reference;

public final class SceneImagePromptAssembler {
    public static final List<String> SECTIONS = List.of("参考图说明", "主体", "环境", "光线", "材质", "构图", "风格", "画面摘要");
    private static final Pattern SECTION = Pattern.compile("(?m)^\\[([^]\\n]+)]");
    private static final Pattern IMAGE = Pattern.compile("<image(\\d+)>");
    private SceneImagePromptAssembler() {
    }

    public static String summary(String prompt) {
        var matcher = SECTION.matcher(prompt);
        var names = new ArrayList<String>();
        var starts = new ArrayList<Integer>();
        var ends = new ArrayList<Integer>();
        while (matcher.find()) {
            names.add(matcher.group(1));
            starts.add(matcher.start());
            ends.add(matcher.end());
        }
        if (!names.equals(SECTIONS) || starts.getFirst() != 0)
            throw new IllegalArgumentException("绘图提示词必须按顺序完整提供八个中文段落");
        for (int i = 0; i < names.size(); i++) {
            int end = i + 1 < names.size() ? starts.get(i + 1) : prompt.length();
            if (prompt.substring(ends.get(i), end).isBlank())
                throw new IllegalArgumentException("绘图段落不能为空：" + names.get(i));
        }
        String summary = prompt.substring(ends.getLast()).strip();
        if (IMAGE.matcher(summary).find() || Pattern.compile("\\bimg\\d+\\b").matcher(summary).find())
            throw new IllegalArgumentException("画面摘要不能引用图片编号");
        return summary;
    }

    public static void validateReferences(String prompt, List<Reference> references) {
        var matcher = IMAGE.matcher(prompt);
        var used = new HashSet<Integer>();
        while (matcher.find()) {
            int number = Integer.parseInt(matcher.group(1));
            if (number < 1 || number > references.size())
                throw new IllegalArgumentException("绘图编号超出实际参考图范围");
            used.add(number);
        }
        if (used.size() != references.size())
            throw new IllegalArgumentException("每张实际参考图都必须在提示词中明确说明用途");
        summary(prompt);
    }
}
