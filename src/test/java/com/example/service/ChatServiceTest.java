package com.example.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.function.Consumer;

import org.junit.jupiter.api.Test;

import com.example.config.LlmProperties;
import com.example.llm.LLMClient;
import com.example.llm.model.ChatRequest;
import com.example.prompt.PromptBuilder;
import com.example.web.dto.CharacterDto;
import com.example.web.dto.ChatApiRequest;
import com.example.web.dto.HistoryMessageDto;
import com.example.web.dto.ImageDto;
import com.example.web.dto.InputDto;
import com.example.web.dto.InteractionSettingsDto;
import com.example.web.dto.InteractionSettingsDto.NarrativeMode;
import com.example.web.dto.InteractionSettingsDto.ReplyLength;
import com.example.web.dto.SegmentDelta;

class ChatServiceTest {
    private static final InteractionSettingsDto SETTINGS = new InteractionSettingsDto(ReplyLength.STANDARD, NarrativeMode.SCENE);
    private final LLMClient llmClient = mock(LLMClient.class);
    private final ChatService service = new ChatService(
            new PromptBuilder(new LlmProperties("", "", "", 0.8, 800, 120)), llmClient);

    @Test
    void buildsModelRequestAndEmitsDeltasBeforeModelReturns() throws Exception {
        List<SegmentDelta> deltas = new ArrayList<>();
        doAnswer(invocation -> {
            ChatRequest request = invocation.getArgument(0);
            assertEquals(List.of("system", "assistant", "user"), request.getMessages()
                    .stream().map(message -> message.getRole()).toList());
            assertEquals("你好", request.getMessages().getLast().getContent());
            assertEquals(Integer.valueOf(800), request.getMaxTokens());
            assertEquals(Double.valueOf(0.8), request.getTemperature());

            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("[台");
            assertEquals(List.of(), deltas);
            onText.accept("词]“你好。”");
            assertEquals(List.of(new SegmentDelta("dialogue", "“你好。”")), deltas);
            // 不完整的最后一行留给 parser.finish() 处理。
            onText.accept("\n[描");
            return "stop";
        }).when(llmClient).chatStream(any(), any());

        assertEquals("stop", service.chatStream(validRequest(), deltas::add));
        assertEquals(List.of(
                new SegmentDelta("dialogue", "“你好。”"),
                new SegmentDelta("dialogue", "\n"),
                new SegmentDelta("narration", "[描")), deltas);
    }

    @Test
    void rejectsMissingRequiredFieldsBeforeCallingModel() {
        ChatApiRequest valid = validRequest();
        List<ChatApiRequest> invalid = Arrays.asList(
                null,
                new ChatApiRequest(null, List.of(), "", List.of(), valid.input(), SETTINGS),
                new ChatApiRequest(valid.character(), null, "", List.of(), valid.input(), SETTINGS),
                new ChatApiRequest(valid.character(), List.of(), null, List.of(), valid.input(), SETTINGS),
                new ChatApiRequest(valid.character(), List.of(), "", null, valid.input(), SETTINGS),
                new ChatApiRequest(valid.character(), List.of(), "", List.of(), null, SETTINGS));
        for (ChatApiRequest request : invalid) {
            assertThrows(IllegalArgumentException.class, () -> service.chatStream(request, delta -> {}));
        }
        verifyNoInteractions(llmClient);
    }

    @Test
    void rejectsBlankOversizedAndImageInputBeforeCallingModel() {
        for (InputDto input : List.of(
                new InputDto(null, null),
                new InputDto(" \n\t", null),
                new InputDto("字".repeat(2001), null),
                new InputDto("文字", new ImageDto("data:image/png;base64,...")))) {
            ChatApiRequest valid = validRequest();
            ChatApiRequest request = new ChatApiRequest(valid.character(), List.of(), "", List.of(), input, SETTINGS);
            assertThrows(IllegalArgumentException.class, () -> service.chatStream(request, delta -> {}));
        }
        verifyNoInteractions(llmClient);
    }

    @Test
    void rejectsInvalidHistoryAndMemoriesBeforeCallingModel() {
        ChatApiRequest valid = validRequest();
        for (List<HistoryMessageDto> history : List.of(
                Collections.<HistoryMessageDto>singletonList(null),
                List.of(new HistoryMessageDto("system", "错误角色")),
                List.of(new HistoryMessageDto(null, "缺少角色")),
                List.of(new HistoryMessageDto("user", null)))) {
            ChatApiRequest request = new ChatApiRequest(valid.character(), List.of(), "", history, valid.input(), SETTINGS);
            assertThrows(IllegalArgumentException.class, () -> service.chatStream(request, delta -> {}));
        }
        for (List<String> memories : List.of(Collections.<String>singletonList(null), Collections.nCopies(51, "记忆"))) {
            ChatApiRequest request = new ChatApiRequest(valid.character(), memories, "", List.of(), valid.input(), SETTINGS);
            assertThrows(IllegalArgumentException.class, () -> service.chatStream(request, delta -> {}));
        }
        verifyNoInteractions(llmClient);
    }

    @Test
    void acceptsInputAndMemoryLimits() throws Exception {
        doAnswer(invocation -> "length").when(llmClient).chatStream(any(), any());
        ChatApiRequest valid = validRequest();
        ChatApiRequest request = new ChatApiRequest(valid.character(), Collections.nCopies(50, "记忆"),
                "", List.of(), new InputDto("字".repeat(2000), null), SETTINGS);
        assertEquals("length", service.chatStream(request, delta -> {}));
    }

    @Test
    void propagatesModelFailureWithoutFlushingUnfinishedMarker() throws Exception {
        IOException failure = new IOException("模型连接中断");
        doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("[台");
            throw failure;
        }).when(llmClient).chatStream(any(), any());

        List<SegmentDelta> deltas = new ArrayList<>();
        assertSame(failure, assertThrows(IOException.class,
                () -> service.chatStream(validRequest(), deltas::add)));
        assertEquals(List.of(), deltas);
    }

    @Test
    void propagatesInterruptionAndCallbackFailure() throws Exception {
        InterruptedException interruption = new InterruptedException("请求中断");
        doAnswer(invocation -> { throw interruption; }).when(llmClient).chatStream(any(), any());
        assertSame(interruption, assertThrows(InterruptedException.class,
                () -> service.chatStream(validRequest(), delta -> {})));

        doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("[台词]你好");
            return "stop";
        }).when(llmClient).chatStream(any(), any());
        RuntimeException callbackFailure = new RuntimeException("前端连接已断开");
        assertSame(callbackFailure, assertThrows(RuntimeException.class,
                () -> service.chatStream(validRequest(), delta -> { throw callbackFailure; })));
    }

    @Test
    void rejectsMissingFinishReasonInsteadOfReportingSuccess() throws Exception {
        doAnswer(invocation -> null).when(llmClient).chatStream(any(), any());
        assertThrows(IOException.class, () -> service.chatStream(validRequest(), delta -> {}));
    }

    @Test
    void createsIndependentParserForEachRequest() throws Exception {
        doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("[台词]第一轮");
            return "stop";
        }).doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("第二轮");
            return "stop";
        }).when(llmClient).chatStream(any(), any());

        List<SegmentDelta> first = new ArrayList<>();
        List<SegmentDelta> second = new ArrayList<>();
        service.chatStream(validRequest(), first::add);
        service.chatStream(validRequest(), second::add);
        assertEquals(List.of(new SegmentDelta("dialogue", "第一轮")), first);
        assertEquals(List.of(new SegmentDelta("narration", "第二轮")), second);
    }

    @Test
    void rejectsMissingSettingsAndNullFieldsBeforeCallingModel() {
        ChatApiRequest valid = validRequest();
        for (InteractionSettingsDto settings : Arrays.asList(
                null,
                new InteractionSettingsDto(null, NarrativeMode.SCENE),
                new InteractionSettingsDto(ReplyLength.STANDARD, null))) {
            ChatApiRequest request = new ChatApiRequest(valid.character(), valid.memories(), valid.summary(),
                    valid.history(), valid.input(), settings);
            assertThrows(IllegalArgumentException.class, () -> service.chatStream(request, delta -> {}));
        }
        verifyNoInteractions(llmClient);
    }

    private ChatApiRequest validRequest() {
        return new ChatApiRequest(
                new CharacterDto("林溪", "旅馆老板", "好奇", "简短", "山城", "雨夜初遇"),
                List.of(), "", List.of(new HistoryMessageDto("assistant", "欢迎。")),
                new InputDto("你好", null), SETTINGS);
    }
}
