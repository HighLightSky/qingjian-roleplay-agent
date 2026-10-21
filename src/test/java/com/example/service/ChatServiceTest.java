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
import com.example.config.VisionProperties;
import com.example.llm.LLMClient;
import com.example.llm.model.ChatStreamResult;
import com.example.llm.model.TokenUsage;
import com.example.llm.model.ChatRequest;
import com.example.prompt.PromptBuilder;
import com.example.prompt.VisualSelectionPromptBuilder;
import com.example.web.dto.CharacterDto;
import com.example.web.dto.ChatApiRequest;
import com.example.web.dto.HistoryMessageDto;
import com.example.web.dto.InputDto;
import com.example.web.dto.InteractionSettingsDto;
import com.example.web.dto.InteractionSettingsDto.NarrativeMode;
import com.example.web.dto.InteractionSettingsDto.ReplyLength;
import com.example.web.dto.SegmentDelta;
import com.fasterxml.jackson.databind.ObjectMapper;

class ChatServiceTest {
    private static final InteractionSettingsDto SETTINGS = new InteractionSettingsDto(ReplyLength.STANDARD, NarrativeMode.SCENE);
    private final LLMClient llmClient = mock(LLMClient.class);
    private final ImageValidationService images = new ImageValidationService(new VisionProperties());
    private final ChatService service = new ChatService(
            com.example.TestRequests.budgets(), llmClient, images,
            new VisualSelectionService(llmClient, new ObjectMapper(),
                    new VisualSelectionPromptBuilder(new ObjectMapper()), images, new ContextValidation(new ObjectMapper()), com.example.TestRequests.budgets()), new ContextValidation(new ObjectMapper()));

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
            return new ChatStreamResult("stop", TokenUsage.unavailable());
        }).when(llmClient).chatStream(any(), any());

        assertEquals("stop", service.chatStream(validRequest(), deltas::add, budget -> {}).finishReason());
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
                new ChatApiRequest(null, com.example.TestRequests.state(List.of()), com.example.TestRequests.summary(), List.of(), valid.input(), SETTINGS, null, "operation"),
                new ChatApiRequest(valid.character(), null, com.example.TestRequests.summary(), List.of(), valid.input(), SETTINGS, null, "operation"),
                new ChatApiRequest(valid.character(), com.example.TestRequests.state(List.of()), null, List.of(), valid.input(), SETTINGS, null, "operation"),

                new ChatApiRequest(valid.character(), com.example.TestRequests.state(List.of()), com.example.TestRequests.summary(), List.of(), null, SETTINGS, null, "operation"));
        for (ChatApiRequest request : invalid) {
            assertThrows(IllegalArgumentException.class, () -> service.validateRequest(request));
        }
        verifyNoInteractions(llmClient);
    }

    @Test
    void rejectsBlankAndOversizedInputBeforeCallingModel() {
        for (InputDto input : List.of(
                new InputDto(null, null),
                new InputDto(" \n\t", null),
                new InputDto("字".repeat(2001), null))) {
            ChatApiRequest valid = validRequest();
            ChatApiRequest request = new ChatApiRequest(valid.character(), com.example.TestRequests.state(List.of()), com.example.TestRequests.summary(), List.of(), input, SETTINGS, null, "operation");
            assertThrows(IllegalArgumentException.class, () -> service.validateRequest(request));
        }
        verifyNoInteractions(llmClient);
    }

    @Test
    void rejectsInvalidHistoryAndMemoriesBeforeCallingModel() {
        ChatApiRequest valid = validRequest();
        for (List<HistoryMessageDto> history : List.of(
                Collections.<HistoryMessageDto>singletonList(null),
                List.of(new HistoryMessageDto("system", "错误角色", "history", null, 1, "complete", 0)),
                List.of(new HistoryMessageDto(null, "缺少角色", "history", null, 1, "complete", 0)),
                List.of(new HistoryMessageDto("user", null, "history", null, 1, "complete", 0)))) {
            ChatApiRequest request = new ChatApiRequest(valid.character(), com.example.TestRequests.state(List.of()), com.example.TestRequests.summary(), history, valid.input(), SETTINGS, null, "operation");
            assertThrows(IllegalArgumentException.class, () -> service.validateRequest(request));
        }
        for (List<String> memories : List.of(Collections.<String>singletonList(null), Collections.nCopies(51, "记忆"))) {
            ChatApiRequest request = new ChatApiRequest(valid.character(), com.example.TestRequests.state(memories), com.example.TestRequests.summary(), List.of(), valid.input(), SETTINGS, null, "operation");
            assertThrows(IllegalArgumentException.class, () -> service.validateRequest(request));
        }
        verifyNoInteractions(llmClient);
    }

    @Test
    void acceptsInputAndMemoryLimits() throws Exception {
        doAnswer(invocation -> new ChatStreamResult("length", TokenUsage.unavailable())).when(llmClient).chatStream(any(), any());
        ChatApiRequest valid = validRequest();
        ChatApiRequest request = new ChatApiRequest(valid.character(), com.example.TestRequests.state(Collections.nCopies(50, "记忆")), com.example.TestRequests.summary(), List.of(), new InputDto("字".repeat(2000), null), SETTINGS, null, "operation");
        assertEquals("length", service.chatStream(request, delta -> {}, budget -> {}).finishReason());
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
                () -> service.chatStream(validRequest(), deltas::add, budget -> {})));
        assertEquals(List.of(), deltas);
    }

    @Test
    void propagatesInterruptionAndCallbackFailure() throws Exception {
        InterruptedException interruption = new InterruptedException("请求中断");
        doAnswer(invocation -> { throw interruption; }).when(llmClient).chatStream(any(), any());
        assertSame(interruption, assertThrows(InterruptedException.class,
                () -> service.chatStream(validRequest(), delta -> {}, budget -> {})));

        doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("[台词]你好");
            return new ChatStreamResult("stop", TokenUsage.unavailable());
        }).when(llmClient).chatStream(any(), any());
        RuntimeException callbackFailure = new RuntimeException("前端连接已断开");
        assertSame(callbackFailure, assertThrows(RuntimeException.class,
                () -> service.chatStream(validRequest(), delta -> { throw callbackFailure; }, budget -> {})));
    }

    @Test
    void rejectsMissingFinishReasonInsteadOfReportingSuccess() throws Exception {
        doAnswer(invocation -> new ChatStreamResult(null, TokenUsage.unavailable())).when(llmClient).chatStream(any(), any());
        assertThrows(IOException.class, () -> service.chatStream(validRequest(), delta -> {}, budget -> {}));
    }

    @Test
    void createsIndependentParserForEachRequest() throws Exception {
        doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("[台词]第一轮");
            return new ChatStreamResult("stop", TokenUsage.unavailable());
        }).doAnswer(invocation -> {
            Consumer<String> onText = invocation.getArgument(1);
            onText.accept("第二轮");
            return new ChatStreamResult("stop", TokenUsage.unavailable());
        }).when(llmClient).chatStream(any(), any());

        List<SegmentDelta> first = new ArrayList<>();
        List<SegmentDelta> second = new ArrayList<>();
        service.chatStream(validRequest(), first::add, budget -> {});
        service.chatStream(validRequest(), second::add, budget -> {});
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
            ChatApiRequest request = new ChatApiRequest(valid.character(), valid.state(), valid.summary(), valid.history(), valid.input(), settings, null, "operation");
            assertThrows(IllegalArgumentException.class, () -> service.validateRequest(request));
        }
        verifyNoInteractions(llmClient);
    }

    private ChatApiRequest validRequest() {
        return new ChatApiRequest(new CharacterDto("林溪", "旅馆老板，也是我的旧友", "好奇，说话简短，生活在山城。"), com.example.TestRequests.state(List.of()), com.example.TestRequests.summary(), List.of(new HistoryMessageDto("assistant", "欢迎。", "history", null, 1, "complete", 0)), new InputDto("你好", null), SETTINGS, null, "operation");
    }
}
