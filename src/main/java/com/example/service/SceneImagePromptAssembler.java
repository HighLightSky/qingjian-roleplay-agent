package com.example.service;

import java.util.List;
import com.example.web.dto.SceneImageDtos.InputImage;

public final class SceneImagePromptAssembler {
    public static final List<String> SECTIONS = List.of("参考图说明", "主体", "环境", "光线", "材质", "构图", "风格", "画面摘要");

    private SceneImagePromptAssembler() {
    }

    public static String assemble(String prompt, List<InputImage> references) {
        var text = new StringBuilder("第一张图片是待绘制的纯黑画布，仅用于指定画幅。请完整绘制提示词描述的画面，黑色不代表目标背景或风格。\n");
        for (int i = 0; i < references.size(); i++) {
            var reference = references.get(i);
            text.append("第").append(i + 2).append("张图片（").append(reference.assetId()).append("）参考用途：")
                    .append(reference.scope()).append("。\n");
        }
        return text.append("\n").append(prompt).toString();
    }
}
