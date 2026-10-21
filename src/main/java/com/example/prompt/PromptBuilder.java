package com.example.prompt;

import java.util.ArrayList;
import java.util.List;

import org.springframework.stereotype.Component;

import com.example.config.LlmProperties;
import com.example.llm.model.ChatRequest;
import com.example.llm.model.Message;
import com.example.web.dto.CharacterDto;
import com.example.web.dto.ChatApiRequest;
import com.example.web.dto.HistoryMessageDto;
import com.example.web.dto.InputDto;
import com.example.web.dto.InteractionSettingsDto;
import com.example.web.dto.InteractionSettingsDto.NarrativeMode;
import com.example.web.dto.InteractionSettingsDto.ReplyLength;

/**
 * 将前端聊天请求转换为模型请求，只负责消息组装，不调用模型或保存数据。
 * 请求合法性由调用方校验；当前仅支持纯文字输入。
 */
@Component
public class PromptBuilder {

    private static final int MAX_HISTORY_MESSAGES = 20;

    private final LlmProperties llmProperties;

    public PromptBuilder(LlmProperties llmProperties) {
        this.llmProperties = llmProperties;
    }

    /**
     * 统一入口，消息顺序为：system → 历史消息 → 本轮 user 输入。
     *
     * @param request 已完成输入校验的聊天请求
     * @return 包含消息列表与生成参数的模型请求
     */
    public ChatRequest build(ChatApiRequest request) {
        List<Message> messages = new ArrayList<>();

        String systemPrompt = buildSystemPrompt(
                request.character(), request.memories(), request.summary(), request.interactionSettings());
        messages.add(new Message("system", systemPrompt));

        appendHistory(messages, request.history());
        messages.add(buildUserMessage(request.input()));

        return new ChatRequest(
                messages, llmProperties.maxTokens(), llmProperties.temperature());
    }

    /**
     * 将角色设定、回复规则、输出格式、重要记忆和摘要拼成一段系统提示词。
     */
    private String buildSystemPrompt(
            CharacterDto character, List<String> memories, String summary, InteractionSettingsDto settings) {
        StringBuilder systemPrompt = new StringBuilder("""
                你正在扮演以下角色，并与用户共同展开故事。

                【角色设定】
                名字：%s
                身份与背景：%s
                性格：%s
                说话风格：%s
                世界观：%s
                开场场景：%s
                """.formatted(
                character.name(),
                character.description(),
                character.personality(),
                character.speakingStyle(),
                character.worldSetting(),
                character.openingScene()));

        systemPrompt.append("""

                【回复规则】
                1. 始终保持角色设定和已经发生的故事事实。
                2. 不替用户添加台词、心理或重大行动，不擅自决定用户的选择。
                3. 用户已经明确选择的行动可以继续展开；遇到新的重大选择时停下等待用户。
                4. 不要求每次结尾提问，可以在自然停顿处结束，为用户留出介入空间。
                5. 角色台词简短与整体场景详细可以同时成立；通过动作、反应和事件展开丰富内容。
                6. 没有依据的信息保持不确定，不要编造已经确认的事实。
                7. 只输出本次角色回复，不解释创作过程，不自行开始下一轮对话。
                """);

        appendReplyLengthRules(systemPrompt, settings.replyLength());
        appendNarrativeModeRules(systemPrompt, settings.narrativeMode());
        appendOutputFormatRules(systemPrompt);

        if (memories != null) {
            boolean hasMemories = false;
            for (String memory : memories) {
                if (memory == null || memory.isBlank()) {
                    continue;
                }
                if (!hasMemories) {
                    systemPrompt.append("\n【重要记忆】\n");
                    hasMemories = true;
                }
                systemPrompt.append("- ").append(memory).append('\n');
            }
        }

        if (summary != null && !summary.isBlank()) {
            systemPrompt.append("\n【历史摘要】\n").append(summary).append('\n');
        }
        return systemPrompt.toString();
    }

    private void appendReplyLengthRules(StringBuilder prompt, ReplyLength length) {
        String guidance = switch (length) {
            case SHORT -> "简短：以约 200 个汉字为目标，参考范围 150—300，完成一个清楚的回应或小变化。";
            case STANDARD -> "标准：以约 500 个汉字为目标，参考范围 350—600，展开包含动作、反应和实质信息的片段。";
            case DETAILED -> "详细：以约 1000 个汉字为目标，参考范围 700—1200，充分展开多个因果相关的发展，保持完整场景节奏。";
        };
        prompt.append("\n【回复长度】\n").append(guidance).append('\n');
        prompt.append("字数是参考范围，不是强制最低长度；优先保证内容有实际发展，避免重复描写凑字。遇到必须由用户决定的选择时可以提前结束。\n");
    }

    private void appendNarrativeModeRules(StringBuilder prompt, NarrativeMode mode) {
        prompt.append("\n【叙事推进】\n");
        switch (mode) {
            case INTERACTIVE -> prompt.append("""
                    频繁互动：聚焦用户当前输入，充分描写这一时刻的动作与反应，较早停在自然互动点，给用户接话或行动的空间。
                    不在一条回复中连续跨越多个需要用户参与的情节节点；篇幅仍遵循回复长度设置。
                    """);
            case SCENE -> prompt.append("""
                    场景推进：展开一个完整场景片段，角色依据自己的动机主动行动。
                    先承接用户输入，再主动检查、核对、尝试或与配角交流，让行动产生新信息或局面变化。
                    可以连续展开角色行动、配角互动、环境变化及其结果，让多个发展彼此具有因果关系，把篇幅用于实质进展。
                    可以在世界观内创作新的剧情细节，但不要改写已发生的事实，也不要把角色的猜测当作确认事实。
                    不要只回应用户最后一句话就立即结束，也不要每个小动作都等待用户批准；日常检查不需要用户逐步指示。
                    仅在确实需要用户做新的重大选择或场景片段已充分展开时停下，不要用反复提问、注视用户或无关环境描写代替推进。
                    """);
        }
    }

    private void appendOutputFormatRules(StringBuilder prompt) {
        prompt.append("""

                【输出格式】
                1. 每个正文段落独占一行，行首必须使用且只能使用以下一种类型标记：
                   [台词] 后接角色说出口的话。
                   [描写] 后接动作、神态、环境或角色心理活动。
                2. 类型由标记区分，台词无需加引号，描写无需加括号；自然使用这些标点仍然允许。
                3. 可以连续使用同一类型，每条内容仍然独占一行。
                4. 不要输出空行、标题、编号、Markdown 代码块、分析或状态信息。
                5. 换行使用实际 LF（U+000A），不要输出字面量的反斜杠加 n，也不使用 CR 或 CRLF。
                """);
    }

    /**
     * 将保留的历史消息转换为模型消息，并追加到 messages。
     */
    private void appendHistory(List<Message> messages, List<HistoryMessageDto> history) {
        if (history == null || history.isEmpty()) {
            return;
        }

        int start = Math.max(0, history.size() - MAX_HISTORY_MESSAGES);
        for (HistoryMessageDto message : history.subList(start, history.size())) {
            messages.add(new Message(message.role(), message.text()));
        }
    }

    /**
     * 将本轮输入转换为最后一条 user 消息。
     */
    private Message buildUserMessage(InputDto input) {
        if (input.text() == null || input.text().isBlank()) {
            throw new IllegalArgumentException("用户输入不能为空");
        }
        return new Message("user", input.text());
    }
}
