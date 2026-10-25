package com.example.prompt;

import com.example.web.dto.ChatApiRequest;

public final class SceneImagePromptRules {
    private SceneImagePromptRules() {
    }

    public static void appendTo(StringBuilder prompt, ChatApiRequest request) {
        prompt.append("""
                \n【折叠画面尾部：与正文同次输出，不调用生图】
                正文正常结束后另起一行输出 [画面计划] 加单行 JSON，不用代码块。
                JSON 结构：{"action":"create或reuse或unavailable","continuity":"new_scene或continue_scene或restage",
                "previousPlanId":"genN或空字符串","target":{"subject":"具体人物","outfit":"当前衣着","pose":"动作姿势与表情",
                "environment":"地点和关键道具","light":"光线","material":"材质","composition":"构图","style":"风格"},
                "referenceImages":[{"assetId":"imgN","roles":["base","identity"],"scope":"明确只参照哪些可见属性"}]}。
                身份图缺失时输出 unavailable，参考列表为空，不虚构图片；有身份图且可绘制时输出 create。
                最多选择应用允许数量，不凑数；第一项必须含 base 用途，identity 必须对应绑定身份图；同图多用途合并。
                其他用途只有 continuity、outfit、environment、pose、prop。身份图只约束身份，不能把其服装当作当前服装。
                只能使用本轮正文实际看过的参考，绑定身份图可由应用加入。现有画面没有变化且不要求更新时可 reuse，指定 genN。
                新地点优先 new_scene，不复制旧背景；换装覆盖旧服装；只换衣服不强行换背景，动作与表情按当前时刻明确描述。
                用户本轮明确要求 > 剧情明确变化 > 已确认视觉状态 > 有效前幕 > 角色默认；画面目标不等于剧情事实。
                JSON 后依次输出且只输出以下中文段落：
                [参考图说明]明确第 N 张对应 <imageN>，第一张是底图；分别说明身份、服装、环境等参照范围。
                [主体]具体人物、服装、动作、姿势、朝向、视线和可见表情。
                [环境]当前地点、布局和必要道具。
                [光线]时间、天气和光源。
                [材质]实际可见的表面细节，不额外添物。
                [构图]画幅、镜头距离、位置关系。
                [风格]一致的画面风格。
                [画面摘要]自包含的中文画面内容，不含图片编号、内部 ID、上下文经过或不可见心理。
                使用具体肯定描述，说明本图展示什么，不堆形容词。不做提示词扩写调用。
                生成描述是未经核实的要求；正文看到图片或用户指出错误时可拒绝它，不能自动当作剧情事实。
                """);
        prompt.append("绑定身份图：").append(request.character().appearancePhotoAssetId()).append('\n');
        prompt.append("本轮可用原图：")
                .append(request.visual() == null
                        ? java.util.List.of()
                        : request.visual().imagePayloads().stream().map(p -> p.assetId()).toList())
                .append('\n');
        prompt.append("当前视觉状态：").append(request.state().visualState()).append('\n');
        int index = 0;
        for (var generation : com.example.service.SceneImagePlanService.visibleGenerations(request)) {
            prompt.append("gen").append(++index).append("：").append(generation.summary()).append("；目标：")
                    .append(generation.target()).append("（生成要求，未核实）\n");
        }
    }
}
