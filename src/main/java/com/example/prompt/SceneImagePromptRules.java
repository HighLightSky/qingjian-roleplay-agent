package com.example.prompt;

import com.example.web.dto.ChatApiRequest;

public final class SceneImagePromptRules {
    private SceneImagePromptRules() {
    }

    public static void appendTo(StringBuilder prompt, ChatApiRequest request) {
        prompt.append("""
                \n【折叠画面尾部：与正文同次输出，不调用生图】
                正文结束后另起一行输出 [画面计划] 加单行 JSON，不用代码块。
                JSON 只提供参考建议：{"referenceImages":[{"assetId":"imgN","roles":["identity"],"scope":"具体参考哪些属性"}]}。
                可用用途：identity、continuity、outfit、environment、pose、prop。没有参考时列表为空。
                JSON 后输出中文生图提示词，具体描述人物、衣着、姿态表情、环境、光线、材质、构图和风格。
                可按主体、环境、光线、材质、构图、风格分段，不必写图片编号或画面摘要。
                第一张底图始终由程序提供纯黑画布，只用于指定画幅，模型不选择底图。
                角色照片由程序优先加入；没有角色照片时，优先考虑未放弃的历史生成图作为人物身份参考。
                身份图和历史生成图均非必需。没有生成过图片、前轮生成失败或放弃都不影响当前画面生成。
                历史图片只是可选参考，不是必须编辑的前幕。可以选择目录中本轮未重读的图片，但不能声称核实其细节。
                只使用提供的资产编号，按用途选择，不凑数；去重、排序和服务编号由程序处理。
                当前明确要求与剧情状态优先，换地点不继承旧背景，换装不机械复制旧衣服。
                生成描述是实际提交的绘图要求，未经图像核实，不自动当作剧情事实。
                """);
        prompt.append("绑定角色照片：").append(request.character().appearancePhotoAssetId()).append('\n');
        prompt.append("当前视觉状态：").append(request.state().visualState()).append('\n');
    }
}
