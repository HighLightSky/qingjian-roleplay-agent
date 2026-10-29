package com.example.service;

import java.util.List;
import com.example.web.dto.SceneImageDtos.InputImage;

public final class SceneImagePromptAssembler {
    private SceneImagePromptAssembler() {
    }

    public static String assemble(String prompt, String poseQuery, boolean poseEnabled, List<InputImage> references) {
        var text = new StringBuilder(poseEnabled
                ? "<image1>用于姿态参考，采用其中的人偶姿态；<image2>用于人物身份和外观参考。\n"
                : "<image1>是指定画幅的纯黑画布，请完整绘制新画面，黑色不代表目标背景。\n");
        for (int i = 0; i < references.size(); i++) {
            var reference = references.get(i);
            text.append("<image").append(i + 2).append(">用于")
                    .append(reference.scope()).append("。\n");
        }
        text.append("\n").append(prompt);
        if (!poseEnabled && poseQuery != null && !poseQuery.isBlank())
            text.append("\n姿态要求：").append(poseQuery);
        return text.toString();
    }
}
