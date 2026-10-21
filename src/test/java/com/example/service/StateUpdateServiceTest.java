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
import com.example.TestRequests;
import com.example.config.VisionProperties;
import com.example.llm.LLMClient;
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
        service = new StateUpdateService(model, mapper, new StateUpdatePromptBuilder(mapper),
                new ContextValidation(mapper), new ImageValidationService(vision), com.example.TestRequests.budgets());
    }

    private UpdateRequest request(Snapshot state, List<ContentPartDto> parts, List<Payload> payloads) {
        return new UpdateRequest("operation", new ChatApiRequest(new CharacterDto("林溪", "旧友", "老板", null, 1), state, com.example.TestRequests.summary(),
                List.of(), new InputDto("我们到了旅馆", parts),
                new InteractionSettingsDto(InteractionSettingsDto.ReplyLength.STANDARD, InteractionSettingsDto.NarrativeMode.SCENE),
                payloads.isEmpty() ? null : new Context("session", List.of(), null, payloads), "operation"), 0, 2,
                List.of(new SourceMessage("user", 1, "user", "我们到了旅馆", "complete", "2026-10-21T00:00:00Z"),
                        new SourceMessage("assistant", 2, "assistant", "她走入旅馆。", "complete", "2026-10-21T00:00:01Z")));
    }

    private UpdateRequest request() { return request(TestRequests.state(List.of()), null, List.of()); }
    private void answer(String content) throws Exception { when(model.chat(any())).thenReturn(new ChatResponse(content, "stop", com.example.llm.model.TokenUsage.unavailable())); }
    private String output(String story, String memory, String goal) {
        return "{\"visualObservations\":[],\"storyChanges\":" + story + ",\"memoryChanges\":" + memory + ",\"goalChanges\":" + goal + "}";
    }
    private String change(String id, String value) {
        return "{\"action\":\"" + (id.isEmpty() ? "create" : "update") + "\",\"id\":\"" + id
                + "\",\"expectedVersion\":0,\"value\":" + value + ",\"reason\":\"本轮明确发生\",\"sourceMessageIds\":[\"assistant\"]}";
    }
    private String memoryValue(String scope) {
        return "{\"content\":\"用户喜欢被叫阿远\",\"scope\":\"" + scope
                + "\",\"kind\":\"preference\",\"epistemicStatus\":\"established\",\"status\":\"active\"}";
    }

    @Test void noChangeStillReturnsCheckedRangeAndOnlyCallsOneModel() throws Exception {
        answer(output("[]", "[]", "[]"));
        var result = service.update(request());
        assertEquals(2, result.throughSeq());
        assertEquals("operation", result.operationId());
        assertTrue(result.memoryChanges().isEmpty());
        verify(model, times(1)).chat(any());
        verify(model, never()).chatStream(any(), any());
    }

    @Test void returnsCanonicalBeforeAfterAndServerAssignedIds() throws Exception {
        answer(output("[" + change("location", "\"旅馆\"") + "]", "[" + change("", memoryValue("character")) + "]",
                "[" + change("", "{\"description\":\"寻找哥哥\",\"status\":\"active\",\"currentFocus\":\"询问掌柜\",\"progressSummary\":\"为了寻找哥哥来到旅馆，发现登记册可能有线索。\"}") + "]"));
        var result = service.update(request());
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
        var snapshot = new Snapshot("session", "character", 0, 0, 0, state.story(), Map.of(), List.of(), List.of(goal));
        String progress = "为寻找哥哥来到旅馆，发现旧登记册；掌柜确认哥哥昨天离店，留下前往码头的信息。";
        String goalJson = mapper.writeValueAsString(new GoalValue("寻找哥哥", "active", "核实码头消息", progress));
        answer(output("[" + change("characterState", "\"穿着灰色外套，神情平静，手腕受伤\"") + ","
                + change("userState", "\"穿着校服，自述紧张，身体状态未明确\"") + "]", "[]",
                "[" + change("goal", goalJson).replace("expectedVersion\":0", "expectedVersion\":1") + "]"));
        var result = service.update(request(snapshot, null, List.of()));
        assertEquals(2, result.storyChanges().size());
        assertEquals("", result.storyChanges().getFirst().before().asText());
        assertEquals("穿着灰色外套，神情平静，手腕受伤", result.storyChanges().getFirst().value().asText());
        assertEquals(value.progressSummary(), result.goalChanges().getFirst().before().path("progressSummary").asText());
        assertEquals(progress, result.goalChanges().getFirst().value().path("progressSummary").asText());
        verify(model).chat(argThat(call -> call.getMessages().get(1).getParts().getFirst().text().contains(value.progressSummary())));
    }

    @Test void rejectsOldGoalShapeAndInvalidPeopleState() throws Exception {
        answer(output("[]", "[]", "[" + change("", "{\"description\":\"目标\",\"status\":\"active\",\"currentFocus\":\"\",\"clues\":[],\"milestones\":[],\"blockers\":[]}") + "]"));
        assertThrows(IOException.class, () -> service.update(request()));
        for (String field : List.of("characterState", "userState")) {
            answer(output("[" + change(field, "[\"错误的列表\"]") + "]", "[]", "[]"));
            assertThrows(IOException.class, () -> service.update(request()));
        }
    }

    @Test void rejectsInventedReferencesUnknownFieldsAndDuplicateChanges() throws Exception {
        String valid = change("location", "\"旅馆\"");
        for (String changes : List.of("[" + valid.replace("assistant", "other-session") + "]",
                "[" + valid.replace("location", "character") + "]", "[" + valid + "," + valid + "]",
                "[" + valid.replace("expectedVersion\":0", "expectedVersion\":3") + "]")) {
            answer(output(changes, "[]", "[]"));
            assertThrows(IOException.class, () -> service.update(request()));
        }
    }

    @Test void rejectsMissingListsIncompleteOutputAndOversizedValues() throws Exception {
        for (String json : List.of("{}", output("[]", "[" + change("", memoryValue("session").replace("用户喜欢被叫阿远", "字".repeat(301))) + "]", "[]"))) {
            answer(json);
            assertThrows(IOException.class, () -> service.update(request()));
        }
        when(model.chat(any())).thenReturn(new ChatResponse(output("[]", "[]", "[]"), "length", com.example.llm.model.TokenUsage.unavailable()));
        assertThrows(IOException.class, () -> service.update(request()));
    }

    @Test void rejectsOtherSessionDataAndIncompleteMessagesBeforeModel() {
        var state = TestRequests.state(List.of("事实"));
        var memory = state.memories().getFirst();
        var foreign = new Memory(memory.id(), memory.characterId(), "other-session", memory.value(), 1, "manual", "other-session", List.of(), "2000-01-01T00:00:00Z");
        var invalid = new Snapshot(state.sessionId(), state.characterId(), 0, 0, 0, state.story(), Map.of(), List.of(foreign), List.of());
        assertThrows(IllegalArgumentException.class, () -> service.update(request(invalid, null, List.of())));
        var r = request();
        var broken = new UpdateRequest(r.operationId(), r.context(), 0, 2,
                List.of(new SourceMessage("assistant", 2, "assistant", "未完成", "cancelled", "2026-10-21T00:00:01Z")));
        assertThrows(IllegalArgumentException.class, () -> service.update(broken));
        verifyNoInteractions(model);
    }

    @Test void dismissedMemoryCannotBeRestoredAndOldVersionCannotBeOverwritten() throws Exception {
        var state = TestRequests.state(List.of("用户喜欢被叫阿远"));
        var old = state.memories().getFirst();
        var deleted = new Memory(old.id(), old.characterId(), old.sessionId(),
                new MemoryValue(old.value().content(), "session", "preference", "established", "dismissed"), 2, "manual", "session", List.of("user"), "2027-01-01T00:00:00Z");
        var snapshot = new Snapshot("session", "character", 0, 0, 0, state.story(), Map.of(), List.of(deleted), List.of());
        answer(output("[]", "[" + change("", memoryValue("session")) + "]", "[]"));
        assertThrows(IOException.class, () -> service.update(request(snapshot, null, List.of())));
        answer(output("[]", "[" + change(old.id(), memoryValue("session")) + "]", "[]"));
        assertThrows(IOException.class, () -> service.update(request(snapshot, null, List.of())));
    }

    @Test void manualEditsRequireEvidenceFromLaterMessages() throws Exception {
        var state = TestRequests.state(List.of("原来的称呼"));
        var old = state.memories().getFirst();
        var edited = new Memory(old.id(), old.characterId(), old.sessionId(), old.value(), 1, "manual", "session", List.of(), "2027-01-01T00:00:00Z");
        var snapshot = new Snapshot("session", "character", 0, 0, 0, state.story(),
                Map.of("location", new FieldSource("manual", "2027-01-01T00:00:00Z", List.of())), List.of(edited), List.of());
        answer(output("[" + change("location", "\"旅馆\"") + "]", "[]", "[]"));
        var storyError = assertThrows(IOException.class, () -> service.update(request(snapshot, null, List.of())));
        assertTrue(storyError.getMessage().contains("人工修改"));
        answer(output("[]", "[" + change(old.id(), memoryValue("session")).replace("expectedVersion\":0", "expectedVersion\":1") + "]", "[]"));
        assertThrows(IOException.class, () -> service.update(request(snapshot, null, List.of())));
        var prior = new Snapshot("session", "character", 0, 0, 0, state.story(), Map.of(), state.memories(), List.of());
        assertEquals(1, service.update(request(prior, null, List.of())).memoryChanges().size());
    }

    @Test void manualGoalEditsAlsoRequireLaterEvidence() throws Exception {
        var state = TestRequests.state(List.of());
        var value = new GoalValue("寻找哥哥", "active", "问掌柜", "已来到旅馆寻找哥哥。");
        var goal = new Goal("goal", "session", value, 1, "manual", List.of(), "2027-01-01T00:00:00Z");
        var snapshot = new Snapshot("session", "character", 0, 0, 0, state.story(), Map.of(), List.of(), List.of(goal));
        String update = change("goal", "{\"description\":\"寻找哥哥\",\"status\":\"completed\",\"currentFocus\":\"\",\"progressSummary\":\"已找到哥哥。\"}")
                .replace("expectedVersion\":0", "expectedVersion\":1");
        answer(output("[]", "[]", "[" + update + "]"));
        assertThrows(IOException.class, () -> service.update(request(snapshot, null, List.of())));
    }

    @Test void aNewExplicitSourceCanReestablishAnOlderDismissedMemory() throws Exception {
        var state = TestRequests.state(List.of("用户喜欢被叫阿远"));
        var old = state.memories().getFirst();
        var deleted = new Memory(old.id(), old.characterId(), old.sessionId(),
                new MemoryValue(old.value().content(), "session", "preference", "established", "dismissed"),
                2, "manual", "session", List.of(), "2000-01-01T00:00:00Z");
        var snapshot = new Snapshot("session", "character", 0, 0, 0, state.story(), Map.of(), List.of(deleted), List.of());
        answer(output("[]", "[" + change("", memoryValue("session")) + "]", "[]"));
        var result = service.update(request(snapshot, null, List.of()));
        assertNotEquals(deleted.id(), result.memoryChanges().getFirst().id());
    }

    @Test void actualImagesAndAllDomainsUseOneCallWithTrustedObservationSources() throws Exception {
        var bytes = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB), "png", bytes);
        var payload = new Payload("image", ImageValidationService.sha256(bytes.toByteArray()),
                "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes.toByteArray()));
        var r = request(TestRequests.state(List.of()), List.of(new ContentPartDto("text", "我们到了旅馆", null),
                new ContentPartDto("image", null, "image")), List.of(payload));
        String observation = "{\"assetId\":\"image\",\"summary\":\"地图\",\"visibleDetails\":[\"红点\"],\"extractedText\":[],\"uncertainDetails\":[\"小字不清\"],\"sources\":[],\"version\":99}";
        answer(output("[" + change("location", "\"旅馆\"") + "]", "[]", "[]").replace("\"visualObservations\":[]", "\"visualObservations\":[" + observation + "]"));
        var result = service.update(r);
        assertEquals(1, result.visualObservations().getFirst().version());
        assertEquals("user", ((com.example.web.dto.VisualDtos.MessageSource) result.visualObservations().getFirst().sources().getFirst()).messageId());
        var captured = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chat(captured.capture());
        assertTrue(captured.getValue().getMessages().getLast().getParts().stream().anyMatch(p -> "image_url".equals(p.type())));
        answer(output("[]", "[]", "[]"));
        assertThrows(IOException.class, () -> service.update(r));
    }

    @Test void characterAndBudgetsAreValidatedAtEntry() {
        var r = request();
        var context = r.context();
        var oversized = new ChatApiRequest(context.character(), context.state(), new com.example.web.dto.ContextDtos.HistorySummary("字".repeat(ContextLimits.CONTEXT_CHARS + 1), 1, 1),
                context.history(), context.input(), context.interactionSettings(), context.visual(), context.operationId());
        assertThrows(IllegalArgumentException.class, () -> service.update(new UpdateRequest("operation", oversized, 0, 2, r.messages())));
        verifyNoInteractions(model);
    }
    @Test void photoObservationHasTrueProfileSourceWithoutInventingUploadMessage() throws Exception {
        var out = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB), "png", out);
        byte[] bytes = out.toByteArray();
        var payload = new Payload("photo", ImageValidationService.sha256(bytes), "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes));
        var photo = new Asset("photo", payload.sha256(), "image/png", bytes.length, 3, 2,
                List.of(new CharacterPhotoSource("character", 4)), null, List.of());
        var base = request();
        var c = base.context();
        var context = new ChatApiRequest(new CharacterDto("林溪", "旧友", "银发", "photo", 4), c.state(), c.summary(), c.history(),
                c.input(), c.interactionSettings(), new Context("session", List.of(photo), null, List.of(payload)), c.operationId());
        var r = new UpdateRequest(base.operationId(), context, base.fromExclusiveSeq(), base.throughSeq(), base.messages());
        answer("{\"visualObservations\":[{\"assetId\":\"photo\",\"summary\":\"黑发红斗篷\",\"visibleDetails\":[],\"extractedText\":[],\"uncertainDetails\":[\"饰品模糊\"],\"sources\":[],\"version\":99}],\"storyChanges\":[],\"memoryChanges\":[],\"goalChanges\":[]}");
        var result = service.update(r);
        assertEquals(List.of(new CharacterPhotoSource("character", 4)), result.visualObservations().getFirst().sources());
        assertEquals(1, result.visualObservations().getFirst().version());
        assertTrue(result.memoryChanges().isEmpty());
        var captor = org.mockito.ArgumentCaptor.forClass(ChatRequest.class);
        verify(model).chat(captor.capture());
        assertEquals(payload.dataUrl(), captor.getValue().getMessages().getLast().getParts().stream()
                .filter(p -> "image_url".equals(p.type())).findFirst().orElseThrow().imageUrl());
    }

}
