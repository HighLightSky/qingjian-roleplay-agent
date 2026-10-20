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
                request.character(), request.memories(), request.summary());
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
            CharacterDto character, List<String> memories, String summary) {
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
                2. 台词使用引号，例如：“我们明天出发。”
                3. 动作、神态、环境、心理描写使用括号，例如：（她把地图收进背包。）
                4. 可以推动剧情，但不要替用户决定想法、台词或重大行动。
                5. 图片看不清或没有依据时直接表达不确定，不要编造已确认的事实。
                6. 只输出角色回复，不要解释创作过程。

                【输出格式】
                1. 每条内容单独占一行，行首必须标注类型，只能使用下面两种标记：
                   [台词] 角色说出口的话，内容用引号包裹。
                   [描写] 动作、神态、环境、心理活动，内容用括号包裹。
                2. 不要输出空行、标题、编号、Markdown 代码块或额外解释。
                3. 可以连续使用同一类型，但每条内容仍然独占一行。
                4. 换行只能使用实际的 LF 换行符（\\n，U+000A），不得使用 CR（\\r）或 CRLF（\\r\\n），也不要输出字面量的反斜杠加 n。
                5. 示例：
                   [描写]（她抬头看向窗外的雨幕。）
                   [台词]“今天不适合赶路。”
                   [描写]（她把门闩重新插好。）
                """);

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
