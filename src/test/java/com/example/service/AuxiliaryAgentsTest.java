package com.example.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.io.IOException;
import java.util.*;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import com.example.SelectionFixtures;
import org.mockito.ArgumentCaptor;

import com.example.TestRequests;
import com.example.config.*;
import com.example.llm.LLMClient;
import com.example.llm.LlmRequestMapper;
import com.example.llm.model.*;
import com.example.prompt.*;
import com.example.web.dto.*;
import com.example.web.dto.ContextDtos.TokenCount;
import com.example.web.dto.StateDtos.*;
import com.example.web.dto.VisualDtos.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;

class AuxiliaryAgentsTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final LLMClient model = mock(LLMClient.class);
    private final LlamaTokenCounter counter = mock(LlamaTokenCounter.class);
    private final VisionProperties vision = com.example.TestRequests.vision();
    private static final String EMPTY = "{\"visualObservations\":[],\"visualChanges\":[],\"storyChanges\":[],\"memoryChanges\":[],\"goalChanges\":[]}";

    @BeforeEach void setup() throws Exception {
        vision.setSupported(true);
        when(counter.tokenize(anyString())).thenAnswer(i -> (long) ((String) i.getArgument(0)).codePointCount(0, ((String) i.getArgument(0)).length()));
        when(counter.countTextOnly(any())).thenAnswer(i -> count(i.getArgument(0)));
        when(counter.count(any())).thenAnswer(i -> count(i.getArgument(0)));
        when(model.chat(any())).thenReturn(new ChatResponse(EMPTY, "stop", TokenUsage.unavailable()));
    }

    private TokenCount count(ChatRequest request) throws Exception {
        var serializer = new LlmRequestMapper(mapper, new LlmProperties("", "", "test", .8, 8192, 120));
        String text = serializer.messages(request).toString();
        return new TokenCount(text.codePointCount(0, text.length()), "exact", "test", "fingerprint");
    }

    private AuxiliaryContextService contexts(int limit) {
        return new AuxiliaryContextService(mapper, counter, TestRequests.contextProperties(),
                new AuxiliaryContextProperties(4, 8192, 8192, limit, limit, 2048, 512));
    }

    private StateUpdateService stateService(int limit) {
        return new StateUpdateService(model, mapper, new StateUpdatePromptBuilder(mapper, TestRequests.dispatch()),
                new ImageValidationService(vision), TestRequests.budgets(), contexts(limit));
    }

    private ChatApiRequest context(int rounds, int textLength, Snapshot state) {
        List<HistoryMessageDto> history = new ArrayList<>();
        for (int i = 0; i < rounds; i++) {
            history.add(new HistoryMessageDto("user", "旧用户" + i + "甲".repeat(textLength), UUID.randomUUID().toString(), List.of(), 2 * i + 1, "complete", 3));
            history.add(new HistoryMessageDto("assistant", "旧角色" + i + "乙".repeat(textLength), UUID.randomUUID().toString(), List.of(), 2 * i + 2, "complete", 2));
        }
        return new ChatApiRequest(new CharacterDto("林溪", "旧友", "旅馆老板", null, 1), state,
                TestRequests.summary(), history, new InputDto("去码头核实线索", null),
                new InteractionSettingsDto(InteractionSettingsDto.ReplyLength.STANDARD, InteractionSettingsDto.NarrativeMode.SCENE), null, UUID.randomUUID().toString());
    }

    private UpdateRequest request(ChatApiRequest context, String text) {
        int seq = context.history().size();
        return new UpdateRequest(context.operationId(), context, seq, seq + 2, List.of(
                new SourceMessage("current-user-uuid", seq + 1, "user", context.input().textOf(), "complete", "2026-10-22T01:00:00Z"),
                new SourceMessage("current-assistant-uuid", seq + 2, "assistant", text, "complete", "2026-10-22T01:00:01Z")));
    }

    private ObjectNode material(ChatRequest request) throws Exception {
        Message message = request.getMessages().get(1);
        String text = message.getParts() == null ? message.getContent() : message.getParts().getFirst().text();
        return (ObjectNode) mapper.readTree(text.substring(text.indexOf('{')));
    }

    private Snapshot withGoal(String progress) {
        var state = TestRequests.state(List.of("用户称呼阿远"));
        return new Snapshot(state.sessionId(), state.characterId(), 7, 9, state.story(), Map.of(), state.memories(), List.of(
                new Goal("persistent-goal-uuid", "session", new GoalValue("寻找哥哥", "active", "询问掌柜", progress),
                        4, "automatic", List.of("old-source-uuid"), "2026-10-21T01:00:00Z")), com.example.web.dto.StateDtos.VisualState.empty(), java.util.Map.of());
    }

    private String goalPatch(String patch, String evidence) {
        return EMPTY.replace("\"goalChanges\":[]", "\"goalChanges\":[{\"action\":\"update\",\"id\":\"goal1\",\"value\":"
                + patch + ",\"reason\":\"本轮有新依据\",\"sourceMessageIds\":[\"msg2\"]" + evidence + "}]");
    }

    @Test void boundsFourFortyAndFourHundredRoundsWithoutLeakingStorageFields() throws Exception {
        for (int rounds : List.of(4, 40, 400)) {
            clearInvocations(model);
            var context = context(rounds, 10, withGoal("早期发现旧登记册，哥哥可能去了码头。"));
            stateService(32768).update(request(context, "她点头，准备去码头。"));
            var calls = ArgumentCaptor.forClass(ChatRequest.class);
            verify(model).chat(calls.capture());
            var data = material(calls.getValue());
            assertEquals(4, data.path("history").size());
            assertTrue(counter.countTextOnly(calls.getValue()).inputTokens() <= 32768);
            String json = data.toString();
            for (String forbidden : List.of("sessionId", "characterId", "operationId", "checkpointVersion", "expectedVersion",
                    "profileVersion", "interactionSettings", "persistent-goal-uuid", "current-user-uuid", "old-source-uuid"))
                assertFalse(json.contains(forbidden), forbidden);
            assertEquals("goal1", data.path("goals").get(0).path("id").asText());
            assertEquals("msg2", data.path("currentMessages").get(1).path("id").asText());
            assertTrue(calls.getValue().isThinkingEnabled());
            assertEquals(rounds * 2, context.history().size());
        }
    }

    @Test void focusPatchKeepsProgressAndReturnsCanonicalIdsAndVersions() throws Exception {
        when(model.chat(any())).thenReturn(new ChatResponse(goalPatch("{\"currentFocus\":\"核实码头消息\"}", ""), "stop", TokenUsage.unavailable()));
        var result = stateService(32768).update(request(context(4, 5, withGoal("从废塔找到哥哥的徽章，再从旅馆得知码头线索。")), "她提议去码头核实。"));
        var change = result.goalChanges().getFirst();
        assertEquals("persistent-goal-uuid", change.id());
        assertEquals(4, change.expectedVersion());
        assertEquals(List.of("current-assistant-uuid"), change.sourceMessageIds());
        assertEquals(change.before().path("progressSummary"), change.value().path("progressSummary"));
        assertEquals("核实码头消息", change.value().path("currentFocus").asText());
    }

    @Test void rejectsUnseenAndCrossTypeIdsButKeepsAliasesStableDuringCorrection() throws Exception {
        String invalid = goalPatch("{\"currentFocus\":\"码头\"}", "").replace("goal1", "mem1");
        when(model.chat(any())).thenReturn(new ChatResponse(invalid, "stop", TokenUsage.unavailable()),
                new ChatResponse(goalPatch("{\"currentFocus\":\"码头\"}", ""), "stop", TokenUsage.unavailable()));
        stateService(32768).update(request(context(4, 5, withGoal("早期因果")), "新的关注点是码头。"));
        var calls = ArgumentCaptor.forClass(ChatRequest.class);
        verify(model, times(2)).chat(calls.capture());
        assertEquals(material(calls.getAllValues().getFirst()).path("goals"), material(calls.getAllValues().getLast()).path("goals"));
        assertTrue(calls.getAllValues().getLast().getMessages().getLast().getContent().contains("类型错误"));
        when(model.chat(any())).thenReturn(new ChatResponse(invalid.replace("mem1", "goal99"), "stop", TokenUsage.unavailable()));
        assertThrows(IOException.class, () -> stateService(32768).update(request(context(0, 0, withGoal("早期因果")), "新的关注点")));
    }

    @Test void progressEvidenceMustComeFromVisibleCurrentMessages() throws Exception {
        String patch = "{\"progressSummary\":\"找到徽章后确认哥哥已在码头。\"}";
        String evidence = ",\"progressEvidence\":{\"type\":\"discovery\",\"sourceMessageId\":\"msg2\",\"quote\":\"确认哥哥已在码头\"}";
        var input = request(context(4, 5, withGoal("早期找到徽章。")), "掌柜确认哥哥已在码头。");
        when(model.chat(any())).thenReturn(new ChatResponse(goalPatch(patch, evidence), "stop", TokenUsage.unavailable()));
        assertEquals("找到徽章后确认哥哥已在码头。", stateService(32768).update(input).goalChanges().getFirst().value().path("progressSummary").asText());
        for (String invalid : List.of("", evidence.replace("确认哥哥已在码头", "旧用户0"), evidence.replace("msg2", "history1"))) {
            when(model.chat(any())).thenReturn(new ChatResponse(goalPatch(patch, invalid), "stop", TokenUsage.unavailable()));
            assertThrows(IOException.class, () -> stateService(32768).update(input));
        }
    }

    @Test void truncatesLongInputsMarksIncompleteAndProtectsOldFields() throws Exception {
        var context = context(40, 1500, withGoal("早期重要进展".repeat(5000)));
        String before = mapper.writeValueAsString(context);
        var request = request(context, "开头" + "长正文".repeat(10000) + "结尾");
        var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(AuxiliaryContextService.class);
        var logs = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
        logs.start();
        var previousLevel = logger.getLevel();
        logger.setLevel(ch.qos.logback.classic.Level.WARN);
        logger.addAppender(logs);
        try {
            stateService(10000).update(request);
        } finally {
            logger.detachAppender(logs);
            logger.setLevel(previousLevel);
            logs.stop();
        }
        var calls = ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chat(calls.capture());
        assertTrue(counter.countTextOnly(calls.getValue()).inputTokens() <= 10000);
        var data = material(calls.getValue());
        assertTrue(data.path("currentMessages").get(1).path("incomplete").asBoolean());
        assertFalse(data.path("incompleteSections").isEmpty());
        assertTrue(data.path("goals").isEmpty() || !data.path("goals").get(0).path("editableFields").toString().contains("progressSummary"));
        assertTrue(logs.list.stream().anyMatch(e -> e.getFormattedMessage().contains("裁减后token")));
        assertEquals(before, mapper.writeValueAsString(context));
        String evidence = ",\"progressEvidence\":{\"type\":\"outcome\",\"sourceMessageId\":\"msg2\",\"quote\":\"结尾\"}";
        when(model.chat(any())).thenReturn(new ChatResponse(goalPatch("{\"progressSummary\":\"覆盖早期信息\"}", evidence), "stop", TokenUsage.unavailable()));
        assertThrows(IOException.class, () -> stateService(10000).update(request));
    }

    @Test void restoresMemoryIdsAndProtectsOmittedStoryLists() throws Exception {
        String memory = "{\"action\":\"update\",\"id\":\"mem1\",\"value\":{\"content\":\"用户希望称为小远\","
                + "\"scope\":\"session\",\"kind\":\"preference\",\"epistemicStatus\":\"established\",\"status\":\"active\"},"
                + "\"reason\":\"用户明确改变称呼\",\"sourceMessageIds\":[\"msg1\"]}";
        when(model.chat(any())).thenReturn(new ChatResponse(EMPTY.replace("\"memoryChanges\":[]", "\"memoryChanges\":[" + memory + "]"),
                "stop", TokenUsage.unavailable()));
        var original = withGoal("早期线索");
        var result = stateService(32768).update(request(context(0, 0, original), "她记住了新的称呼。"));
        assertEquals("memory-0", result.memoryChanges().getFirst().id());
        assertEquals(List.of("current-user-uuid"), result.memoryChanges().getFirst().sourceMessageIds());

        var largeStory = new Story("旅馆", "夜晚", "平静", "", List.of(), List.of(), List.of("关键物品".repeat(10000)), List.of("旧线索"));
        var snapshot = new Snapshot(original.sessionId(), original.characterId(), 7, 9, largeStory, Map.of(), original.memories(), original.goals(), com.example.web.dto.StateDtos.VisualState.empty(), java.util.Map.of());
        var input = request(context(0, 0, snapshot), "普通寒暄，没有改变关键物品。");
        when(model.chat(any())).thenReturn(new ChatResponse(EMPTY, "stop", TokenUsage.unavailable()));
        clearInvocations(model);
        stateService(7000).update(input);
        var calls = ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chat(calls.capture());
        assertFalse(material(calls.getValue()).path("editableStoryFields").toString().contains("items"));
        String change = "{\"action\":\"update\",\"id\":\"items\",\"value\":[],\"reason\":\"未看到物品\",\"sourceMessageIds\":[\"msg2\"]}";
        when(model.chat(any())).thenReturn(new ChatResponse(EMPTY.replace("\"visualChanges\":[],\"storyChanges\":[]", "\"visualChanges\":[],\"storyChanges\":[" + change + "]"),
                "stop", TokenUsage.unavailable()));
        assertThrows(IOException.class, () -> stateService(7000).update(input));
        assertEquals(1, snapshot.story().items().size());
    }

    @Test void largeMemoryAndEndedGoalSetsAreReducedWithoutLinearCountingCalls() throws Exception {
        var memories = TestRequests.state(java.util.stream.IntStream.range(0, 500)
                .mapToObj(i -> "重要经历" + i + "详情".repeat(30)).toList());
        var goals = new ArrayList<Goal>();
        for (int i = 0; i < 500; i++)
            goals.add(new Goal("ended-goal-" + i, "session", new GoalValue("旧目标" + i, "completed", "", "旧进展".repeat(30)),
                    1, "automatic", List.of(), "2026-10-21T00:00:00Z"));
        var snapshot = new Snapshot(memories.sessionId(), memories.characterId(), 0, 0, memories.story(), Map.of(), memories.memories(), goals, com.example.web.dto.StateDtos.VisualState.empty(), java.util.Map.of());
        stateService(7000).update(request(context(0, 0, snapshot), "本轮没有新的重要进展。"));
        var calls = ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chat(calls.capture());
        var data = material(calls.getValue());
        assertTrue(data.path("goals").isEmpty());
        assertTrue(data.path("memories").size() < 500);
        assertTrue(counter.countTextOnly(calls.getValue()).inputTokens() <= 7000);
        verify(counter, atMost(32)).countTextOnly(any());
        assertEquals(500, snapshot.memories().size());
        assertEquals(500, snapshot.goals().size());
    }

    private ChatApiRequest withCatalog(int count) {
        var base = context(40, 20, withGoal("早期进展"));
        List<Asset> catalog = new ArrayList<>();
        for (int i = 1; i <= count; i++) {
            var observation = new Observation("img" + i, "地图细节".repeat(80), List.of("道路"), List.of("码头"), List.of("小字"), List.of(), 3);
            catalog.add(new Asset("img" + i, "f".repeat(64), "image/png", 123, 64, 64,
                    List.of(new MessageSource("source-uuid-" + i, i, "上传地图".repeat(20), 1, i)), observation, List.of(), null));
        }
        return new ChatApiRequest(base.character(), base.state(), base.summary(), base.history(), base.input(), base.interactionSettings(),
                new Context("session", catalog, null, List.of(), List.of()), base.operationId());
    }

    @ParameterizedTest
    @MethodSource("com.example.SelectionFixtures#cases")
    void selectionContextWorksForEveryHistoryAndPhotoCombination(SelectionFixtures.History history,
            SelectionFixtures.Photo photo) throws Exception {
        var scenario = SelectionFixtures.scenario(history, photo);
        var context = scenario.context();
        new ContextValidation().validate(context);
        new ImageValidationService(vision).validateReferences(context);
        when(model.chat(any())).thenAnswer(i -> {
            ChatRequest request = i.getArgument(0);
            var data = material(request);
            assertEquals(context.input().textOf(), data.path("currentMessages").get(0).path("text").asText());
            assertEquals(history == SelectionFixtures.History.NONE ? 0 : 1, data.path("history").size());
            var schema = request.getResponseSchema();
            assertNotNull(schema);
            assertEquals("object", schema.path("type").asText());
            assertEquals(4, schema.path("required").size());
            assertFalse(request.isThinkingEnabled());
            var response = mapper.createObjectNode().put("status", "ready").put("message", "");
            response.putArray("candidateAssetIds");
            var selected = response.putArray("selectedHistoricalImages");
            for (String id : scenario.expectedSelected()) {
                assertTrue(data.path("catalog").toString().contains("\"assetId\":\"" + id + "\""));
                selected.addObject().put("assetId", id).put("purpose", "核对未辨清的细节");
            }
            return new ChatResponse(response.toString(), "stop", TokenUsage.unavailable());
        });
        var service = new VisualSelectionService(model, mapper, new VisualSelectionPromptBuilder(TestRequests.dispatch(), vision),
                new ImageValidationService(vision), contexts(32768));
        var plan = service.select(context);
        assertEquals("ready", plan.status());
        if (ImageValidationService.selectableCatalog(context).isEmpty()) verifyNoInteractions(model);
        else verify(model).chat(any());
        Set<String> actual = new HashSet<>();
        plan.selectedHistoricalImages().forEach(selected -> actual.add(selected.assetId()));
        assertEquals(scenario.expectedSelected(), actual);
        actual.addAll(ImageValidationService.requiredIds(context));
        var payloads = scenario.images().stream().filter(p -> actual.contains(p.assetId())).toList();
        var prepared = ChatDispatchService.withImages(context, plan, payloads);
        var body = new PromptBuilder(new LlmProperties("", "", "test", .8, 8192, 120), com.example.TestRequests.vision(), com.example.TestRequests.auxiliaryContexts()).build(prepared);
        long originals = body.getMessages().stream().filter(m -> m.getParts() != null).flatMap(m -> m.getParts().stream())
                .filter(p -> "image_url".equals(p.type())).count();
        assertEquals(actual.size(), originals);
        assertTrue(body.isThinkingEnabled());
        assertNull(body.getResponseSchema());
    }

    @Test void fencedJsonAndTrailingTokensAreCorrectedWithoutGuessingOrDroppingImages() throws Exception {
        var context = withCatalog(1);
        String valid = "{\"status\":\"ready\",\"selectedHistoricalImages\":[{\"assetId\":\"img1\",\"purpose\":\"核对\"}],\"candidateAssetIds\":[],\"message\":\"\"}";
        for (String invalid : List.of("```json\n" + valid + "\n```", "[" + valid + "]", valid + " {}")) {
            clearInvocations(model);
            when(model.chat(any())).thenReturn(new ChatResponse(invalid, "stop", TokenUsage.unavailable()),
                    new ChatResponse(valid, "stop", TokenUsage.unavailable()));
            var service = new VisualSelectionService(model, mapper, new VisualSelectionPromptBuilder(TestRequests.dispatch(), vision),
                    new ImageValidationService(vision), contexts(32768));
            assertEquals("img1", service.select(context).selectedHistoricalImages().getFirst().assetId());
            var calls = ArgumentCaptor.forClass(ChatRequest.class);
            verify(model, times(2)).chat(calls.capture());
            assertNotNull(calls.getAllValues().getLast().getResponseSchema());
            assertEquals(calls.getAllValues().getFirst().getResponseSchema(), calls.getAllValues().getLast().getResponseSchema());
        }
    }

    @Test void alreadyRequiredImagesDoNotConsumeSelectionSlotsAgain() throws Exception {
        var scenario = SelectionFixtures.scenario(SelectionFixtures.History.IMAGE, SelectionFixtures.Photo.FIRST);
        var original = scenario.context();
        var input = new InputDto("再次参考这张图", List.of(ContentPartDto.text("再次参考这张图"), new ContentPartDto("image", null, "img1")));
        var context = new ChatApiRequest(original.character(), original.state(), original.summary(), original.history(), input,
                original.interactionSettings(), original.visual(), original.operationId());
        var service = new VisualSelectionService(model, mapper, new VisualSelectionPromptBuilder(TestRequests.dispatch(), vision),
                new ImageValidationService(vision), contexts(32768));
        assertEquals("ready", service.select(context).status());
        assertEquals(List.of("img1", "img2"), ImageValidationService.requiredIds(context));
        verifyNoInteractions(model);
    }

    @Test void selectionPromptAndSchemaFollowConfiguredTotalAndRemainingSlots() throws Exception {
        for (int maximum : List.of(1, 2, 5, 7, 10)) {
            clearInvocations(model);
            vision.setMaxImages(maximum);
            var original = withCatalog(3);
            var input = new InputDto("核对图片", List.of(new ContentPartDto("image", null, "img1")));
            var context = new ChatApiRequest(original.character(), original.state(), original.summary(), original.history(),
                    input, original.interactionSettings(), original.visual(), original.operationId());
            doAnswer(i -> {
                ChatRequest call = i.getArgument(0);
                String rules = call.getMessages().getFirst().getContent();
                assertTrue(rules.contains("图片总上限为 " + maximum + " 张"));
                assertTrue(rules.contains("最多再选择 " + (maximum - 1) + " 张历史图"));
                assertTrue(call.getMessages().get(1).getContent().contains("剩余历史图名额：" + (maximum - 1)));
                assertEquals(Math.min(maximum - 1, 2), call.getResponseSchema().path("properties")
                        .path("selectedHistoricalImages").path("maxItems").asInt());
                return new ChatResponse("{\"status\":\"ready\",\"selectedHistoricalImages\":[],\"candidateAssetIds\":[],\"message\":\"\"}",
                        "stop", TokenUsage.unavailable());
            }).when(model).chat(any());
            var selection = new VisualSelectionService(model, mapper,
                    new VisualSelectionPromptBuilder(TestRequests.dispatch(), vision),
                    new ImageValidationService(vision), contexts(32768));
            assertEquals("ready", selection.select(context).status());
            verify(model).chat(any());
        }
    }

    @Test void selectionCorrectionIncludesConcreteErrorAndKeepsThinkingDisabled() throws Exception {
        var context = withCatalog(1);
        String invalid = "{\"status\":\"ready\",\"selectedHistoricalImages\":[{\"assetId\":\"img99\",\"purpose\":\"核对\"}],\"candidateAssetIds\":[],\"message\":\"\"}";
        when(model.chat(any())).thenReturn(new ChatResponse(invalid, "stop", TokenUsage.unavailable()),
                new ChatResponse(invalid.replace("img99", "img1"), "stop", TokenUsage.unavailable()));
        var selection = new VisualSelectionService(model, mapper, new VisualSelectionPromptBuilder(TestRequests.dispatch(), vision),
                new ImageValidationService(vision), contexts(32768));
        assertEquals("img1", selection.select(context).selectedHistoricalImages().getFirst().assetId());
        var calls = ArgumentCaptor.forClass(ChatRequest.class);
        verify(model, times(2)).chat(calls.capture());
        assertTrue(calls.getAllValues().stream().noneMatch(ChatRequest::isThinkingEnabled));
        var retry = calls.getAllValues().getLast();
        assertTrue(retry.getMessages().getFirst().getContent().contains("图片总上限为 " + vision.getMaxImages() + " 张"));
        assertTrue(retry.getMessages().getFirst().getContent().contains("最多再选择 " + vision.getMaxImages() + " 张历史图"));
        assertEquals(invalid, retry.getMessages().get(2).getContent());
        assertTrue(retry.getMessages().getLast().getContent().contains("允许编号：[img1]"));
    }

    @Test void selectionBatchesDoNotEnforceFinalSlotsAndAllRequestsDisableThinking() throws Exception {
        var context = withCatalog(24);
        // 选图协议要求两个数组；按真实请求构造合法响应。
        when(model.chat(any())).thenAnswer(i -> {
            ChatRequest call = i.getArgument(0);
            var data = material(call);
            var response = mapper.createObjectNode().put("status", "ready").put("message", "");
            response.putArray("candidateAssetIds");
            var selected = response.putArray("selectedHistoricalImages");
            if (call.getMessages().get(1).getContent().contains("阶段：目录分批候选提取")) {
                for (JsonNode asset : data.path("catalog")) selected.addObject().put("assetId", asset.path("assetId").asText()).put("purpose", "核对地图");
            } else {
                String first = data.path("catalog").get(0).path("assetId").asText();
                selected.addObject().put("assetId", first).put("purpose", "核对码头位置");
            }
            return new ChatResponse(response.toString(), "stop", TokenUsage.unavailable());
        });
        var selection = new VisualSelectionService(model, mapper, new VisualSelectionPromptBuilder(TestRequests.dispatch(), vision),
                new ImageValidationService(vision), contexts(14000));
        var result = selection.select(context);
        assertEquals("img1", result.selectedHistoricalImages().getFirst().assetId());
        var calls = ArgumentCaptor.forClass(ChatRequest.class);
        verify(model, atLeast(3)).chat(calls.capture());
        boolean sawMoreThanSlots = false;
        for (ChatRequest call : calls.getAllValues()) {
            assertFalse(call.isThinkingEnabled());
            assertNotNull(call.getResponseSchema());
            assertTrue(counter.countTextOnly(call).inputTokens() <= 14000);
            var data = material(call);
            String json = data.toString();
            for (String forbidden : List.of("sha256", "byteSize", "mimeType", "sessionId", "source-uuid", "checkpointVersion", "profileVersion"))
                assertFalse(json.contains(forbidden), forbidden);
            if (call.getMessages().get(1).getContent().contains("阶段：目录分批候选提取") && data.path("catalog").size() > 4)
                sawMoreThanSlots = true;
        }
        assertTrue(sawMoreThanSlots);
    }
}
