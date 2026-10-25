package com.example.prompt;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.List;
import java.util.stream.Stream;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import com.example.config.LlmProperties;
import com.example.web.dto.CharacterDto;
import com.example.web.dto.ChatApiRequest;
import com.example.web.dto.HistoryMessageDto;
import com.example.web.dto.InputDto;
import com.example.web.dto.InteractionSettingsDto;
import com.example.web.dto.InteractionSettingsDto.NarrativeMode;
import com.example.web.dto.InteractionSettingsDto.ReplyLength;

class PromptBuilderTest {
    private final PromptBuilder builder = new PromptBuilder(new LlmProperties("", "", "", 0.8, 8192, 120), com.example.TestRequests.vision());

    static Stream<Arguments> combinations() {
        return Arrays.stream(ReplyLength.values()).flatMap(length ->
                Arrays.stream(NarrativeMode.values()).map(mode -> Arguments.of(length, mode)));
    }

    @ParameterizedTest
    @MethodSource("combinations")
    void appliesIndependentLengthAndNarrativeRulesWithoutChangingTheModelBudget(ReplyLength length, NarrativeMode mode) throws Exception {
        var request = builder.build(new ChatApiRequest(new CharacterDto("林溪", "旅馆老板，也是我的旧友", "好奇，说话简短，生活在山城。", null, 1), com.example.TestRequests.state(List.of("用户叫阿远")), new com.example.web.dto.ContextDtos.HistorySummary("用户带来了一张地图。", 1, 1), List.of(new HistoryMessageDto("assistant", "[台词]让我看看。", "history", null, 1, "complete", 0)), new InputDto("我把地图递给她，让她看看", null), new InteractionSettingsDto(length, mode), null, "operation"));
        String system = request.getMessages().getFirst().getContent();
        String expectedRange = switch (length) {
            case SHORT -> "150—300";
            case STANDARD -> "350—600";
            case DETAILED -> "700—1200";
        };
        for (String range : List.of("150—300", "350—600", "700—1200")) {
            assertEquals(range.equals(expectedRange), system.contains(range));
        }
        assertEquals(mode == NarrativeMode.SCENE, system.contains("场景推进："));
        assertEquals(mode == NarrativeMode.INTERACTIVE, system.contains("频繁互动："));
        assertTrue(system.contains("字数是参考范围"));
        assertTrue(system.contains("不替用户添加台词、心理或重大行动"));
        assertTrue(system.contains("不要求每次结尾提问"));
        assertTrue(system.contains("[台词]"));
        assertTrue(system.contains("[描写]"));
        assertTrue(system.contains("台词无需加引号，描写无需加括号"));
        assertFalse(system.contains("内容用引号包裹"));
        assertFalse(system.contains("内容用括号包裹"));
        assertFalse(system.contains("示例："));
        assertTrue(system.contains("名字：林溪"));
        assertTrue(system.contains("身份（与用户的关系）：旅馆老板，也是我的旧友"));
        assertTrue(system.contains("角色描述：好奇，说话简短，生活在山城。"));
        for (String removed : List.of("性格：", "说话风格：", "世界观：", "开场场景：")) {
            assertFalse(system.contains(removed));
        }
        assertTrue(system.contains("用户叫阿远"));
        assertTrue(system.contains("用户带来了一张地图。"));
        assertEquals(List.of("system", "assistant", "user"), request.getMessages().stream().map(m -> m.getRole()).toList());
        assertEquals("我把地图递给她，让她看看", request.getMessages().getLast().getContent());
        assertEquals(8192, request.getMaxTokens());
        assertEquals(0.8, request.getTemperature());
    }

    @Test void bodyPromptDoesNotContainSceneGenerationInstructions() throws Exception {
        var request = new ChatApiRequest(new CharacterDto("林溪", "旧友", "老板", null, 1),
                com.example.TestRequests.state(java.util.List.of()), com.example.TestRequests.summary(),
                java.util.List.of(), new InputDto("你好", null), new InteractionSettingsDto(ReplyLength.STANDARD, NarrativeMode.SCENE), null, "op");
        var prompt = builder.build(request).getMessages().getFirst().getContent();
        assertFalse(prompt.contains("生图"));
        assertFalse(prompt.contains("画面计划"));
        assertFalse(prompt.contains("referenceImages"));
    }
}
