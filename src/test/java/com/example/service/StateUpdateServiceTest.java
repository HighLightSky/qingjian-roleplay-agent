package com.example.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.*;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;
import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.slf4j.LoggerFactory;
import com.example.TestRequests;
import com.example.config.VisionProperties;
import com.example.llm.LLMClient;
import com.example.llm.LlmRequestMapper;
import com.example.llm.model.ChatStreamResult;
import com.example.llm.model.TokenUsage;
import com.example.llm.model.*;
import com.example.prompt.StateUpdatePromptBuilder;
import com.example.web.dto.*;
import com.example.web.dto.StateDtos.*;
import com.example.web.dto.VisualDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;

class StateUpdateServiceTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final LLMClient model = mock(LLMClient.class);
    private final VisionProperties vision = new VisionProperties();
    private final StateUpdateService service;

    StateUpdateServiceTest() {
        vision.setSupported(true);
        service = new StateUpdateService(model, mapper, new StateUpdatePromptBuilder(mapper, com.example.TestRequests.dispatch()),
                new ImageValidationService(vision), com.example.TestRequests.budgets(), TestRequests.auxiliaryContexts());
    }

    private UpdateRequest request(Snapshot state, List<ContentPartDto> parts, List<Payload> payloads) {
        return new UpdateRequest("operation", new ChatApiRequest(new CharacterDto("林溪", "旧友", "老板", null, 1), state, com.example.TestRequests.summary(),
                List.of(), new InputDto("我们到了旅馆", parts),
                new InteractionSettingsDto(InteractionSettingsDto.ReplyLength.STANDARD, InteractionSettingsDto.NarrativeMode.SCENE),
                payloads.isEmpty() ? null : new Context("session", List.of(), null, payloads), "operation"), 0, 2,
                List.of(new SourceMessage("user", 1, "user", "我们到了旅馆", "complete", "2026-10-21T00:00:00Z"),
                        new SourceMessage("assistant", 2, "assistant", "她走入旅馆。", "complete", "2026-10-21T00:00:01Z")));
    }

    private Result update(UpdateRequest request) throws Exception {
        var images = new ImageValidationService(vision);
        var cache = new ImageCache(com.example.TestRequests.dispatch(), vision, java.time.Clock.systemUTC());
        var refs = new ArrayList<com.example.web.dto.DispatchDtos.ImageRef>();
        if (request.context().visual() != null) for (var payload : request.context().visual().imagePayloads()) {
            cache.put(payload.sha256(), Base64.getDecoder().decode(payload.dataUrl().substring(payload.dataUrl().indexOf(',') + 1)));
            refs.add(new com.example.web.dto.DispatchDtos.ImageRef(payload.assetId(), payload.sha256()));
        }
        var controller = new com.example.web.StateController(service, new ContextValidation(), images, cache, new ModelGate());
        return controller.update(new com.example.web.dto.DispatchDtos.Retry(request, refs));
    }

    private UpdateRequest request() { return request(TestRequests.state(List.of()), null, List.of()); }
    private void answer(String content) throws Exception { when(model.chat(any())).thenReturn(new ChatResponse(content, "stop", com.example.llm.model.TokenUsage.unavailable())); }
    private String output(String story, String memory, String goal) {
        return "{\"visualObservations\":[],\"storyChanges\":" + story + ",\"memoryChanges\":" + memory + ",\"goalChanges\":" + goal + "}";
    }
    private String change(String id, String value) {
        return "{\"action\":\"" + (id.isEmpty() ? "create" : "update") + "\",\"id\":\"" + id
                + "\",\"value\":" + value + ",\"reason\":\"本轮明确发生\",\"sourceMessageIds\":[\"msg2\"]}";
    }
    private String withProgressEvidence(String change) throws Exception {
        var value = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(change);
        value.putObject("progressEvidence").put("type", "discovery").put("sourceMessageId", "msg2").put("quote", "她走入旅馆。");
        return value.toString();
    }
    private String memoryValue(String scope) {
        return "{\"content\":\"用户喜欢被叫阿远\",\"scope\":\"" + scope
                + "\",\"kind\":\"preference\",\"epistemicStatus\":\"established\",\"status\":\"active\"}";
    }

    private Payload payload(String assetId) throws Exception {
        var out = new ByteArrayOutputStream();
        var image = new BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB);
        image.setRGB(0, 0, assetId.hashCode());
        ImageIO.write(image, "png", out);
        byte[] bytes = out.toByteArray();
        return new Payload(assetId, ImageValidationService.sha256(bytes),
                "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes));
    }

    private UpdateRequest photoRequest() throws Exception {
        var payload = payload("img2");
        var photo = new Asset("img2", payload.sha256(), "image/png",
                Base64.getDecoder().decode(payload.dataUrl().split(",")[1]).length, 3, 2,
                List.of(new CharacterPhotoSource("character", 4)), null, List.of());
        var base = request();
        var c = base.context();
        var context = new ChatApiRequest(new CharacterDto("林溪", "旧友", "银发", "img2", 4), c.state(),
                c.summary(), c.history(), c.input(), c.interactionSettings(),
                new Context("session", List.of(photo), null, List.of(payload)), c.operationId());
        return new UpdateRequest(base.operationId(), context, base.fromExclusiveSeq(), base.throughSeq(), base.messages());
    }

    private String observations(String... assetIds) throws Exception {
        var values = new ArrayList<Observation>();
        for (String assetId : assetIds) {
            values.add(new Observation(assetId, "黑发红斗篷", List.of(), List.of(), List.of("饰品模糊"),
                    List.of(), 99));
        }
        return output("[]", "[]", "[]").replace("\"visualObservations\":[]",
                "\"visualObservations\":" + mapper.writeValueAsString(values));
    }

    @Test void noChangeStillReturnsCheckedRangeAndOnlyCallsOneModel() throws Exception {
        answer(output("[]", "[]", "[]"));
        var result = update(request());
        assertEquals(2, result.throughSeq());
        assertEquals("operation", result.operationId());
        assertTrue(result.memoryChanges().isEmpty());
        var captor = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chat(captor.capture());
        var parts = captor.getValue().getMessages().getLast().getParts();
        assertTrue(parts.stream().noneMatch(p -> "image_url".equals(p.type())));
        var material = parts.getFirst().text();
        assertEquals(mapper.createArrayNode(),
                mapper.readTree(material.substring(material.indexOf('{'))).path("actualImageAssetIds"));
        String template = parts.getLast().text();
        assertTrue(mapper.readTree(template.substring(template.indexOf('{'))).path("visualObservations").isEmpty());
        verify(model, never()).chatStream(any(), any());
    }

    @Test void returnsCanonicalBeforeAfterAndServerAssignedIds() throws Exception {
        answer(output("[" + change("location", "\"旅馆\"") + "]", "[" + change("", memoryValue("character")) + "]",
                "[" + change("", "{\"description\":\"寻找哥哥\",\"status\":\"active\",\"currentFocus\":\"询问掌柜\",\"progressSummary\":\"为了寻找哥哥来到旅馆，发现登记册可能有线索。\"}") + "]"));
        var result = update(request());
        assertEquals("", result.storyChanges().getFirst().before().asText());
        assertEquals("旅馆", result.storyChanges().getFirst().value().asText());
        assertFalse(result.memoryChanges().getFirst().id().isBlank());
        assertTrue(result.memoryChanges().getFirst().before().isNull());
        assertEquals("active", result.goalChanges().getFirst().value().path("status").asText());
        assertTrue(result.goalChanges().getFirst().value().path("progressSummary").asText().contains("为了寻找哥哥来到旅馆"));
    }

    @Test void updatesBothPeopleAndCumulativeGoalProgressWithCanonicalBeforeValues() throws Exception {
        var state = TestRequests.state(List.of());
        var value = new GoalValue("寻找哥哥", "active", "询问掌柜", "为寻找哥哥来到旅馆，发现旧登记册。");
        var goal = new Goal("goal", "session", value, 1, "automatic", List.of(), "2026-10-20T00:00:00Z");
        var snapshot = new Snapshot("session", "character", 0, 0, state.story(), Map.of(), List.of(), List.of(goal));
        String progress = "为寻找哥哥来到旅馆，发现旧登记册；掌柜确认哥哥昨天离店，留下前往码头的信息。";
        String goalJson = mapper.writeValueAsString(new GoalValue("寻找哥哥", "active", "核实码头消息", progress));
        answer(output("[" + change("characterState", "\"穿着灰色外套，神情平静，手腕受伤\"") + ","
                + change("userState", "\"穿着校服，自述紧张，身体状态未明确\"") + "]", "[]",
                "[" + withProgressEvidence(change("goal1", goalJson)) + "]"));
        var result = update(request(snapshot, null, List.of()));
        assertEquals(2, result.storyChanges().size());
        assertEquals("", result.storyChanges().getFirst().before().asText());
        assertEquals("穿着灰色外套，神情平静，手腕受伤", result.storyChanges().getFirst().value().asText());
        assertEquals(value.progressSummary(), result.goalChanges().getFirst().before().path("progressSummary").asText());
        assertEquals(progress, result.goalChanges().getFirst().value().path("progressSummary").asText());
        verify(model).chat(argThat(call -> call.getMessages().get(1).getParts().getFirst().text().contains(value.progressSummary())));
    }

    @Test void rejectsOldGoalShapeAndInvalidPeopleState() throws Exception {
        answer(output("[]", "[]", "[" + change("", "{\"description\":\"目标\",\"status\":\"active\",\"currentFocus\":\"\",\"clues\":[],\"milestones\":[],\"blockers\":[]}") + "]"));
        assertThrows(IOException.class, () -> update(request()));
        for (String field : List.of("characterState", "userState")) {
            answer(output("[" + change(field, "[\"错误的列表\"]") + "]", "[]", "[]"));
            assertThrows(IOException.class, () -> update(request()));
        }
    }

    @Test void correctsMisplacedGoalEvidenceAndKeepsUnchangedGoalFields() throws Exception {
        var state = TestRequests.state(List.of());
        var value = new GoalValue("寻找哥哥", "active", "询问掌柜", "已来到旅馆。");
        var goal = new Goal("goal", "session", value, 1, "automatic", List.of(), "2026-10-20T00:00:00Z");
        var snapshot = new Snapshot("session", "character", 0, 0, state.story(), Map.of(), List.of(), List.of(goal));
        var valid = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(withProgressEvidence(
                change("goal1", "{\"progressSummary\":\"已来到旅馆，并走入店内。\"}")));
        var invalid = valid.deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) invalid.path("value"))
                .set("progressEvidence", invalid.remove("progressEvidence"));
        when(model.chat(any())).thenReturn(
                new ChatResponse(output("[]", "[]", "[" + invalid + "]"), "stop", TokenUsage.unavailable()),
                new ChatResponse(output("[]", "[]", "[" + valid + "]"), "stop", TokenUsage.unavailable()));

        var result = update(request(snapshot, null, List.of()));

        var change = result.goalChanges().getFirst();
        assertEquals("goal", change.id());
        assertEquals(value.description(), change.value().path("description").asText());
        assertEquals(value.currentFocus(), change.value().path("currentFocus").asText());
        assertEquals("已来到旅馆，并走入店内。", change.value().path("progressSummary").asText());
        var calls = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model, times(2)).chat(calls.capture());
        String correction = calls.getAllValues().getLast().getMessages().getLast().getContent();
        assertTrue(correction.contains("目标 goal1 的 value 包含未知字段：[progressEvidence]"));
        assertTrue(correction.contains("progressEvidence 必须与 value 同级"));
        var serializer = new LlmRequestMapper(mapper,
                new com.example.config.LlmProperties("", "", "test", .8, 8192, 120));
        for (var call : calls.getAllValues()) {
            var format = serializer.chatBody(call, false).path("response_format");
            assertEquals("json_schema", format.path("type").asText());
            assertTrue(format.path("json_schema").path("strict").asBoolean());
            assertEquals(format, serializer.templateBody(call).path("response_format"));
            var schema = format.path("json_schema").path("schema");
            assertFalse(schema.path("$defs").path("goalValue").path("additionalProperties").asBoolean());
            assertEquals(Set.of("description", "status", "currentFocus", "progressSummary"),
                    mapper.convertValue(schema.path("$defs").path("goalValue").path("required"), Set.class));
        }
        assertEquals(calls.getAllValues().getFirst().getResponseSchema(), calls.getAllValues().getLast().getResponseSchema());
    }

    @ParameterizedTest
    @ValueSource(strings = {"clues", "milestones", "blockers", "progressEvidence", "editableFields"})
    void persistentUnknownGoalFieldReportsItsName(String field) throws Exception {
        var value = mapper.valueToTree(new GoalValue("寻找哥哥", "active", "", ""));
        ((com.fasterxml.jackson.databind.node.ObjectNode) value).put(field, "错误字段");
        answer(output("[]", "[]", "[" + change("", value.toString()) + "]"));

        var error = assertThrows(IOException.class, () -> update(request()));

        assertTrue(error.getMessage().contains("纠正后仍无效"));
        assertTrue(error.getMessage().contains("未知字段：[" + field + "]"));
        assertTrue(error.getMessage().contains("只允许 description、status、currentFocus、progressSummary"));
        verify(model, times(2)).chat(any());
    }

    @ParameterizedTest
    @ValueSource(strings = {"codeFence", "array", "trailingObject"})
    void correctsWrappedOrTrailingJsonInsteadOfAcceptingPartialOutput(String invalid) throws Exception {
        String valid = output("[]", "[]", "[]");
        String rejected = switch (invalid) {
            case "codeFence" -> "```json\n" + valid + "\n```";
            case "array" -> "[" + valid + "]";
            default -> valid + "{}";
        };
        when(model.chat(any())).thenReturn(new ChatResponse(rejected, "stop", TokenUsage.unavailable()),
                new ChatResponse(valid, "stop", TokenUsage.unavailable()));

        assertTrue(update(request()).goalChanges().isEmpty());
        verify(model, times(2)).chat(any());
    }

    @Test void rejectsInventedReferencesUnknownFieldsAndDuplicateChanges() throws Exception {
        String valid = change("location", "\"旅馆\"");
        for (String changes : List.of("[" + valid.replace("msg2", "other-session") + "]",
                "[" + valid.replace("location", "character") + "]", "[" + valid + "," + valid + "]",
                "[" + valid.replace("msg2", "mem1") + "]")) {
            answer(output(changes, "[]", "[]"));
            assertThrows(IOException.class, () -> update(request()));
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing", "null"})
    void textOnlyTurnsNormalizeAbsentVisualObservationsWithoutCorrection(String field) throws Exception {
        var response = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(output(
                "[" + change("location", "\"旅馆\"") + "]", "[]", "[]"));
        if ("missing".equals(field)) response.remove("visualObservations");
        else response.putNull("visualObservations");
        var base = request();
        var c = base.context();
        var emptyVisual = new ChatApiRequest(c.character(), c.state(), c.summary(), c.history(), c.input(),
                c.interactionSettings(), new Context("session", List.of(), null, List.of()), c.operationId());
        for (var request : List.of(base, new UpdateRequest(base.operationId(), emptyVisual, base.fromExclusiveSeq(),
                base.throughSeq(), base.messages()))) {
            clearInvocations(model);
            answer(response.toString());
            var result = update(request);
            assertTrue(result.visualObservations().isEmpty());
            assertEquals("旅馆", result.storyChanges().getFirst().value().asText());
            verify(model).chat(any());
        }
    }

    @Test void actualPhotosAndChatAttachmentsStillRequireVisualObservations() throws Exception {
        var response = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(output("[]", "[]", "[]"));
        response.remove("visualObservations");
        var attachment = request(TestRequests.state(List.of()), List.of(ContentPartDto.text("我们到了旅馆"),
                new ContentPartDto("image", null, "img1")), List.of(payload("img1")));
        for (var request : List.of(photoRequest(), attachment)) {
            clearInvocations(model);
            answer(response.toString());
            var error = assertThrows(IOException.class, () -> update(request));
            assertTrue(error.getMessage().contains("缺少数组：visualObservations"));
            verify(model, times(2)).chat(any());
        }
    }

    @Test void textOnlyTurnsStillRejectMalformedVisualFieldAndMissingDomainArrays() throws Exception {
        for (String invalid : List.of("{}", "0", "\"错误类型\"")) {
            answer(output("[]", "[]", "[]").replace("\"visualObservations\":[]", "\"visualObservations\":" + invalid));
            assertThrows(IOException.class, () -> update(request()));
        }
        for (String missing : List.of("storyChanges", "memoryChanges", "goalChanges")) {
            var response = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(output("[]", "[]", "[]"));
            response.remove(List.of("visualObservations", missing));
            answer(response.toString());
            assertThrows(IOException.class, () -> update(request()));
        }
    }

    @Test void rejectsMissingLists() throws Exception {
        answer("{}");
        assertThrows(IOException.class, () -> update(request()));
    }

    @Test
    void incompleteOutputReportsLengthLimitAndUsageWithoutExposingContent() throws Exception {
        String content = "未完成的整理结果";
        when(model.chat(any())).thenReturn(new ChatResponse(content, "length",
                new TokenUsage("reported", 1000L, 8192L, 9192L)));

        var logger = (Logger) LoggerFactory.getLogger(StateUpdateService.class);
        Level originalLevel = logger.getLevel();
        var logs = new ListAppender<ILoggingEvent>();
        logs.start();
        logger.addAppender(logs);
        logger.setLevel(Level.WARN);
        String message;
        try {
            message = assertThrows(IOException.class, () -> update(request())).getMessage();
        } finally {
            logger.setLevel(originalLevel);
            logger.detachAppender(logs);
            logs.stop();
        }

        assertTrue(message.contains("finish_reason=length（模型因长度限制停止生成）"));
        assertTrue(message.contains("本次输出上限=8192 token"));
        assertTrue(message.contains("输入 token=1000；输出 token=8192；总 token=9192"));
        assertTrue(message.contains("已返回正文=" + content.length() + " 字符"));
        assertFalse(message.contains(content));
        assertEquals(List.of(message), logs.list.stream().map(ILoggingEvent::getFormattedMessage).toList());
        verify(model).chat(any());
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = { "length", "content_filter", "tool_calls", "unexpected_reason" })
    void incompleteOutputPreservesFinishReasonAndUnavailableUsage(String finishReason) throws Exception {
        when(model.chat(any())).thenReturn(new ChatResponse(output("[]", "[]", "[]"), finishReason,
                TokenUsage.unavailable()));

        String message = assertThrows(IOException.class, () -> update(request())).getMessage();

        String expectedReason = finishReason == null ? "缺失（上游未返回）" : finishReason;
        assertTrue(message.contains("finish_reason=" + expectedReason));
        assertTrue(message.contains("token 用量=上游未提供"));
        assertFalse(message.contains("输出 token=0"));
        verify(model).chat(any());
    }

    @Test void rejectsOtherSessionDataAndIncompleteMessagesBeforeModel() {
        var state = TestRequests.state(List.of("事实"));
        var memory = state.memories().getFirst();
        var foreign = new Memory(memory.id(), memory.characterId(), "other-session", memory.value(), 1, "manual", "other-session", List.of(), "2000-01-01T00:00:00Z");
        var invalid = new Snapshot(state.sessionId(), state.characterId(), 0, 0, state.story(), Map.of(), List.of(foreign), List.of());
        assertThrows(IllegalArgumentException.class, () -> update(request(invalid, null, List.of())));
        var r = request();
        var broken = new UpdateRequest(r.operationId(), r.context(), 0, 2,
                List.of(new SourceMessage("assistant", 2, "assistant", "未完成", "cancelled", "2026-10-21T00:00:01Z")));
        assertThrows(IllegalArgumentException.class, () -> update(broken));
        verifyNoInteractions(model);
    }

    @Test void dismissedMemoryCannotBeRestored() throws Exception {
        var state = TestRequests.state(List.of("用户喜欢被叫阿远"));
        var old = state.memories().getFirst();
        var deleted = new Memory(old.id(), old.characterId(), old.sessionId(),
                new MemoryValue(old.value().content(), "session", "preference", "established", "dismissed"), 2, "manual", "session", List.of("user"), "2027-01-01T00:00:00Z");
        var snapshot = new Snapshot("session", "character", 0, 0, state.story(), Map.of(), List.of(deleted), List.of());
        answer(output("[]", "[" + change("", memoryValue("session")) + "]", "[]"));
        assertThrows(IOException.class, () -> update(request(snapshot, null, List.of())));
        answer(output("[]", "[" + change("mem1", memoryValue("session")) + "]", "[]"));
        assertThrows(IOException.class, () -> update(request(snapshot, null, List.of())));
    }

    @Test void manualEditsRequireEvidenceFromLaterMessages() throws Exception {
        var state = TestRequests.state(List.of("原来的称呼"));
        var old = state.memories().getFirst();
        var edited = new Memory(old.id(), old.characterId(), old.sessionId(), old.value(), 1, "manual", "session", List.of(), "2027-01-01T00:00:00Z");
        var snapshot = new Snapshot("session", "character", 0, 0, state.story(),
                Map.of("location", new FieldSource("manual", "2027-01-01T00:00:00Z", List.of())), List.of(edited), List.of());
        answer(output("[" + change("location", "\"旅馆\"") + "]", "[]", "[]"));
        var storyError = assertThrows(IOException.class, () -> update(request(snapshot, null, List.of())));
        assertTrue(storyError.getMessage().contains("人工修改"));
        answer(output("[]", "[" + change("mem1", memoryValue("session")) + "]", "[]"));
        assertThrows(IOException.class, () -> update(request(snapshot, null, List.of())));
        var prior = new Snapshot("session", "character", 0, 0, state.story(), Map.of(), state.memories(), List.of());
        assertEquals(1, update(request(prior, null, List.of())).memoryChanges().size());
    }

    @Test void manualGoalEditsAlsoRequireLaterEvidence() throws Exception {
        var state = TestRequests.state(List.of());
        var value = new GoalValue("寻找哥哥", "active", "问掌柜", "已来到旅馆寻找哥哥。");
        var goal = new Goal("goal", "session", value, 1, "manual", List.of(), "2027-01-01T00:00:00Z");
        var snapshot = new Snapshot("session", "character", 0, 0, state.story(), Map.of(), List.of(), List.of(goal));
        String update = change("goal1", "{\"status\":\"completed\",\"currentFocus\":\"\"}")
                ;
        answer(output("[]", "[]", "[" + update + "]"));
        assertThrows(IOException.class, () -> update(request(snapshot, null, List.of())));
    }

    @Test void aNewExplicitSourceCanReestablishAnOlderDismissedMemory() throws Exception {
        var state = TestRequests.state(List.of("用户喜欢被叫阿远"));
        var old = state.memories().getFirst();
        var deleted = new Memory(old.id(), old.characterId(), old.sessionId(),
                new MemoryValue(old.value().content(), "session", "preference", "established", "dismissed"),
                2, "manual", "session", List.of(), "2000-01-01T00:00:00Z");
        var snapshot = new Snapshot("session", "character", 0, 0, state.story(), Map.of(), List.of(deleted), List.of());
        answer(output("[]", "[" + change("", memoryValue("session")) + "]", "[]"));
        var result = update(request(snapshot, null, List.of()));
        assertNotEquals(deleted.id(), result.memoryChanges().getFirst().id());
    }

    @Test void actualImagesAndAllDomainsUseOneCallWithTrustedObservationSources() throws Exception {
        var bytes = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB), "png", bytes);
        var payload = new Payload("img1", ImageValidationService.sha256(bytes.toByteArray()),
                "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes.toByteArray()));
        var r = request(TestRequests.state(List.of()), List.of(new ContentPartDto("text", "我们到了旅馆", null),
                new ContentPartDto("image", null, "img1")), List.of(payload));
        String observation = "{\"assetId\":\"img1\",\"summary\":\"地图\",\"visibleDetails\":[\"红点\"],\"extractedText\":[],\"uncertainDetails\":[\"小字不清\"],\"sources\":[],\"version\":99}";
        answer(output("[" + change("location", "\"旅馆\"") + "]", "[]", "[]").replace("\"visualObservations\":[]", "\"visualObservations\":[" + observation + "]"));
        var result = update(r);
        assertEquals(1, result.visualObservations().getFirst().version());
        assertEquals("user", ((com.example.web.dto.VisualDtos.MessageSource) result.visualObservations().getFirst().sources().getFirst()).messageId());
        var captured = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chat(captured.capture());
        assertTrue(captured.getValue().getMessages().getLast().getParts().stream().anyMatch(p -> "image_url".equals(p.type())));
        answer(output("[]", "[]", "[]"));
        assertThrows(IOException.class, () -> update(r));
    }

    @Test void photoObservationHasTrueProfileSourceWithoutInventingUploadMessage() throws Exception {
        var r = photoRequest();
        answer(observations("img2"));
        var result = update(r);
        assertEquals(List.of(new CharacterPhotoSource("character", 4)), result.visualObservations().getFirst().sources());
        assertEquals(1, result.visualObservations().getFirst().version());
        assertTrue(result.memoryChanges().isEmpty());
        var captor = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chat(captor.capture());
        assertEquals(r.context().visual().imagePayloads().getFirst().dataUrl(), captor.getValue().getMessages().getLast().getParts().stream()
                .filter(p -> "image_url".equals(p.type())).findFirst().orElseThrow().imageUrl());
        var material = captor.getValue().getMessages().getLast().getParts().getFirst().text();
        var data = mapper.readTree(material.substring(material.indexOf('{')));
        assertEquals(mapper.valueToTree(List.of("img2")), data.path("actualImageAssetIds"));
        assertFalse(material.contains("base64"));
    }

    @Test void correctsInvalidPhotoIdOnceAndResendsActualImage() throws Exception {
        var r = photoRequest();
        when(model.chat(any())).thenReturn(
                new ChatResponse(observations("character_photo"), "stop", TokenUsage.unavailable()),
                new ChatResponse(observations("img2"), "stop", TokenUsage.unavailable()));

        var result = update(r);

        assertEquals("img2", result.visualObservations().getFirst().assetId());
        assertEquals(List.of(new CharacterPhotoSource("character", 4)), result.visualObservations().getFirst().sources());
        var captor = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model, times(2)).chat(captor.capture());
        for (var call : captor.getAllValues()) {
            var images = call.getMessages().get(1).getParts().stream()
                    .filter(p -> "image_url".equals(p.type())).toList();
            assertEquals(1, images.size());
            assertEquals(r.context().visual().imagePayloads().getFirst().dataUrl(), images.getFirst().imageUrl());
        }
        String correction = captor.getAllValues().getLast().getMessages().getLast().getContent();
        assertTrue(correction.contains("未传入的原图：character_photo"));
        assertTrue(correction.contains("本次原图 ID：[img2]"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing", "null"})
    void correctsMissingAssetIdUsingRejectedResultAndConcreteTemplate(String invalidId) throws Exception {
        var r = photoRequest();
        var invalid = mapper.readTree(observations("img2"));
        var observation = (com.fasterxml.jackson.databind.node.ObjectNode) invalid.path("visualObservations").get(0);
        if ("missing".equals(invalidId)) {
            observation.remove("assetId");
        } else {
            observation.putNull("assetId");
        }
        String rejected = invalid.toString();
        when(model.chat(any())).thenReturn(
                new ChatResponse(rejected, "stop", TokenUsage.unavailable()),
                new ChatResponse(observations("img2"), "stop", TokenUsage.unavailable()));

        var result = update(r);

        assertEquals("img2", result.visualObservations().getFirst().assetId());
        assertEquals(List.of(new CharacterPhotoSource("character", 4)), result.visualObservations().getFirst().sources());
        var captor = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model, times(2)).chat(captor.capture());
        var retry = captor.getAllValues().getLast();
        assertEquals(List.of("system", "user", "assistant", "user"),
                retry.getMessages().stream().map(Message::getRole).toList());
        assertEquals(rejected, retry.getMessages().get(2).getContent());
        assertTrue(retry.getMessages().getLast().getContent().contains("未传入的原图：null"));
        var parts = retry.getMessages().get(1).getParts();
        assertEquals(r.context().visual().imagePayloads().getFirst().dataUrl(), parts.stream()
                .filter(p -> "image_url".equals(p.type())).findFirst().orElseThrow().imageUrl());
        String template = parts.getLast().text();
        assertEquals("img2", mapper.readTree(template.substring(template.indexOf('{')))
                .path("visualObservations").get(0).path("assetId").asText());
    }

    @Test void rejectsPersistentUnknownDuplicateAndMissingImageReferencesWithoutSubstitution() throws Exception {
        var r = photoRequest();
        Map<String, String> invalid = Map.of(
                observations("img99"), "未传入的原图：img99",
                observations((String) null), "未传入的原图：null",
                observations("img2").replace("\"assetId\":\"img2\",", ""), "未传入的原图：null",
                observations("img2", "img2"), "重复返回视觉观察：img2",
                observations(), "缺少本次原图：[img2]");
        for (var entry : invalid.entrySet()) {
            clearInvocations(model);
            answer(entry.getKey());
            var failure = assertThrows(IOException.class, () -> update(r));
            assertTrue(failure.getMessage().contains(entry.getValue()), failure.getMessage());
            verify(model, times(2)).chat(any());
        }
    }

    @Test void photoAndNewAttachmentsKeepTheirOwnSourcesAndSharedPhotoIsSentOnce() throws Exception {
        var base = photoRequest();
        var c = base.context();
        var context = new ChatApiRequest(c.character(), c.state(), c.summary(), c.history(),
                new InputDto(c.input().text(), List.of(ContentPartDto.text(c.input().text()),
                        new ContentPartDto("image", null, "img2"),
                        new ContentPartDto("image", null, "img3"))), c.interactionSettings(),
                new Context("session", c.visual().assetCatalog(), null,
                        List.of(payload("img2"), payload("img3"))), c.operationId());
        answer(observations("img3", "img2"));

        var result = update(new UpdateRequest(base.operationId(), context, base.fromExclusiveSeq(),
                base.throughSeq(), base.messages()));

        assertEquals(List.of(new MessageSource("user", 1, c.input().text(), 2, 2)),
                result.visualObservations().getFirst().sources());
        assertEquals(List.of(new CharacterPhotoSource("character", 4),
                new MessageSource("user", 1, c.input().text(), 1, 1)),
                result.visualObservations().getLast().sources());
        var captor = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chat(captor.capture());
        var parts = captor.getValue().getMessages().getLast().getParts();
        assertEquals(2, parts.stream().filter(p -> "image_url".equals(p.type())).count());
        var material = parts.getFirst().text();
        assertEquals(mapper.valueToTree(List.of("img2", "img3")),
                mapper.readTree(material.substring(material.indexOf('{'))).path("actualImageAssetIds"));
        String template = parts.getLast().text();
        var templateObservations = mapper.readTree(template.substring(template.indexOf('{'))).path("visualObservations");
        assertEquals(2, templateObservations.size());
        assertEquals("img2", templateObservations.get(0).path("assetId").asText());
        assertEquals("img3", templateObservations.get(1).path("assetId").asText());
    }

    @Test void upstreamFailureDoesNotTriggerOutputCorrection() throws Exception {
        when(model.chat(any())).thenThrow(new IOException("模型服务连接失败"));
        var failure = assertThrows(IOException.class, () -> update(photoRequest()));
        assertEquals("模型服务连接失败", failure.getMessage());
        verify(model).chat(any());
    }

}
