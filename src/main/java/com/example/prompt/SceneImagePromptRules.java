package com.example.prompt;

/** 整理同时生成画面草稿；绘图补充不作为领域事实。 */
public final class SceneImagePromptRules {
    private SceneImagePromptRules() {
    }

    public static void appendTo(StringBuilder prompt) {
        prompt.append("""
                \n【当前画面生图提示词】
                每轮都必须返回 sceneImage：{"prompt":"单段中文画面指令","additionalReferences":[{"assetId":"imgN","scope":"简短参考用途"}]}。
                prompt 目标约200—300字，简单场景可更短，不凑字；不输出分段标题、独立摘要、分析或正文。
                描绘本轮正文结束时的一个静态画面，不复述动作过程，不绘制尚未发生的事件。
                直接根据 currentMessages 原文、当前剧情与视觉状态组织画面，不仅依赖压缩后的 changes。
                第一张输入 <image1> 是程序提供的黑画布，只指定画幅，要完整绘制新画面，不继承黑色背景。
                automaticReference 存在时，程序将其作为 <image2> 优先提供人物身份；additionalReferences 不得重复选择它，额外参考从 <image3> 开始。
                automaticReference 为 null 时，额外参考从 <image2> 开始。编号严格按 additionalReferences 的数组顺序排列。
                额外参考只能选择 referenceCatalog 实际提供的资产，最多 maxAdditionalReferences 张，不选无关图片，不重复编号。
                业务 JSON 的 assetId 使用真实 imgN；prompt 中仅使用 <imageN> 引用输入图片，不写业务资产编号。
                身份已有参考时写“与<image2>相同的人物”等，不重新描述五官，不解释参考图中有什么，只讲明取用的属性。
                服装、环境等有依据且继续沿用的属性不反复描写；与参考不一致的部分必须说清，不能默认继承旧动作或过时场景。
                必须明确当前动作、身体姿态、朝向、视线与必要的支撑关系；例如“坐在书桌旁的椅子上”，不能含糊写成“坐在书桌前”。
                可补齐手脚位置、持物和构图等成画必需细节，但不得改变用户明确要求、已确定服装、人物关系或剧情结果。
                环境、光线和氛围简单说明即可，不堆砌风格词或通用禁止事项；优先正面描述要生成的画面。
                示例：与<image2>相同的女孩，脱去外套，坐在书桌旁的椅子上，双脚落地，左手扶住摊在桌面的书，右手搭在书页边缘，低头阅读。侧面中景，窗边柔和日光，安静的室内。
                参考目录的已有观察是有损记录，生成要求未经图像核实；不能声称本轮看过未实际提供的原图。
                绘图补充只写入 sceneImage.prompt，不得作为 storyChanges、visualChanges、memoryChanges、goalChanges 或原图观察的证据。
                """);
    }
}
