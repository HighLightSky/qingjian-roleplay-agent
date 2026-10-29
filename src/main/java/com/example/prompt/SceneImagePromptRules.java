package com.example.prompt;

/** 整理同时生成画面草稿；绘图补充不作为领域事实。 */
public final class SceneImagePromptRules {
    private SceneImagePromptRules() {
    }

    public static void appendTo(StringBuilder prompt) {
        prompt.append("""
                \n【当前画面生图提示词与姿态检索】
                每轮都必须返回 sceneImage：{"poseQuery":"独立的姿态检索描述","prompt":"单段中文画面指令","additionalReferences":[{"assetId":"imgN","scope":"简短参考用途"}]}。
                poseQuery 与 prompt 都必须非空。两部分共同表达 currentMessages 原文、当前剧情与持续视觉状态在正文结束时的一个静态画面，不仅依赖 changes。
                poseQuery 只描述动作、身体朝向、四肢位置、支撑关系和观察角度；明确左右肢体、手脚位置与接触的支撑物，同一只手只承担一个动作。
                持物时，poseQuery 描述手臂、手部与物体的接触关系，prompt 保留物品本身及其外观。观察角度写在 poseQuery，不在 prompt 重复身体姿态或动作。
                prompt 描述人物参考、服装及需要保留或改变的外观、必要物品、场景和光照；用两三句精简单段中文，不凑字，不输出标题、摘要、分析或正文。
                只写最后的结果：比如脱下的衣物和放下的物品交代最终位置，门的开闭与灯光一致，不混入较早动作、过渡过程或尚未发生的事件。
                只描述当前角色的状态，以当前角色为主角，非必要不出现其他人物，包括“用户”；其他人物不出现正脸，只能出现背影或者在角落里出现。
                第一张输入 <image1> 用于姿态参考，由程序提供画幅并由图像服务替换为人偶；prompt 不描述黑色画布，不把黑色当作背景，不重复描写人偶动作。
                automaticReference 存在时，程序将其作为 <image2> 优先提供人物身份；additionalReferences 不得重复选择它，额外参考从 <image3> 开始。
                automaticReference 为 null 时，额外参考从 <image2> 开始；优先将有依据的人物身份参考列在首项，没有人物图时不编造引用，用户会在生成前补选。
                编号严格按 additionalReferences 的数组顺序排列。额外参考只能选择 referenceCatalog 实际提供的资产，最多 maxAdditionalReferences 张，不选无关图片，不重复编号。
                如果描写身体部位，使用最直接的词汇，不隐晦。
                先从 story、visualState 与 currentMessages 的最终结果确定当前画面，再选择参考并写两个文本；本轮的 visualChanges 与 sceneImage 同时生成，不能仅按输入的旧状态或是否返回 changes 判断。
                按人物身份、当前服装及关键配饰、必要场景和物品逐项匹配 automaticReference 与 referenceCatalog；已有身份照片不代表当前服装依据齐全，文字已记录服装也不代表生图无需原图。
                当前服装与身份照片不同时，目录中有对应服装或单件衣物的图片就应加入 additionalReferences；持续穿着即使本轮未再次提及、没有新换装也须考虑，不只选最新生成图。
                图片部分属性冲突时仍可参考有用部分，scope 明确取用与不沿用的属性，例如“仅参考外套款式，人物身份、内搭与背景不沿用”。prompt 明确对应 <imageN> 承担的用途，避免继承冲突属性。
                一张图能覆盖多项需求就复用，额外图片须补足尚未覆盖的视觉信息，不按固定张数凑数。目录中没有对应参考时直接写已确定的当前状态，不编造颜色、款式或图片事实。
                referenceCatalog 中的 selectionPurpose 是正文前的选图用途，只作线索；本轮最终状态已改变时重新判断适用属性，不能照搬旧用途。
                业务 JSON 的 assetId 使用真实 imgN；prompt 中仅使用 <imageN> 引用输入图片，不写业务资产编号。
                身份已有参考时写“与<image2>相同的人物”等，不重新描述五官，不解释参考图中有什么，只讲明取用的属性。
                生图模型会实际收到所选参考图，用图片承载不变的外观；不要把材料中的服装、发型、配饰清单整段复制进 prompt，也不要照抄历史长提示词。
                变化以本次实际采用的参考图为比较对象；即使本轮没有新变化，持续状态与参考不同时仍须明确写出。差异只依据实际原图、已有观察和对话事实判断，参考细节未知时不猜测原图外观。
                本次所选参考已承载的发型、配饰、内搭和服装细节不逐件重复；当前状态与参考不同，或所选参考未承载的必要服装仍须明确，即使本轮没有新变化。
                穿外套时描述可见的最终穿着结果，如外套覆盖原有上衣、前襟扣合；脱外套时写清露出的衣物及外套最终位置。手脚与穿脱动作放入 poseQuery。
                环境只留当前地点、必要光线及与姿势相关的物体，不展开无关远景或氛围词。可补齐成画必需细节，但不得改变用户明确要求、已确定服装、人物关系或剧情结果。
                示例：poseQuery="人物坐在书桌旁的椅子上，双脚落地，左手扶书，右手搭在书页上，低头，侧面观察。"；prompt="与<image2>相同的人物，外套已脱下搭在椅背，身上穿白衬衫。书桌上有一本书，窗边日光。"。
                示例只示范写法，细节以本轮依据为准。参考目录的已有观察是有损记录，生成要求未经图像核实，不能声称本轮看过未实际提供的原图。
                绘图补充只写入 sceneImage 的 poseQuery 与 prompt，不得作为 storyChanges、visualChanges、memoryChanges、goalChanges 或原图观察的证据。
                """);
    }
}
