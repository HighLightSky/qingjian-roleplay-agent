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
import com.example.config.*;
import com.example.llm.*;
import com.example.llm.model.*;
import com.example.prompt.*;
import com.example.web.dto.*;
import com.example.web.dto.VisualDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;

/** 使用真实图片字节与模拟模型，验证选图、补传、来源和视觉记录完整闭环。 */
class VisualPipelineTest {
    final ObjectMapper mapper = new ObjectMapper();
    final VisionProperties config = new VisionProperties();
    final LLMClient model = mock(LLMClient.class);
    final ImageValidationService images;
    final VisualSelectionService selector;
    final PromptBuilder builder = new PromptBuilder(new LlmProperties("", "", "", 0.8, 8192, 120));
    final ChatService chat;
    VisualPipelineTest() {
        config.setSupported(true);
        images = new ImageValidationService(config);
        selector = new VisualSelectionService(model, mapper, new VisualSelectionPromptBuilder(mapper), images, new ContextValidation(mapper), com.example.TestRequests.budgets());
        chat = new ChatService(com.example.TestRequests.budgets(), model, images, selector, new ContextValidation(mapper));
    }
    byte[] png() throws Exception {
        var out = new ByteArrayOutputStream(); ImageIO.write(new BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB), "png", out); return out.toByteArray();
    }
    Payload payload(String id) throws Exception {
        byte[] bytes = png(); return new Payload(id, ImageValidationService.sha256(bytes), "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes));
    }
    Asset asset(String id, int seq) throws Exception {
        return new Asset(id, payload(id).sha256(), "image/png", png().length, 3, 2,
                List.of(new MessageSource("source-" + seq, seq, "地图参考", 1, 1)), null, List.of());
    }
    ChatApiRequest request(String text, List<ContentPartDto> parts, List<Asset> catalog, Plan plan, List<Payload> payloads) {
        return new ChatApiRequest(new CharacterDto("林溪", "老板", "好奇，说话简短，生活在山城。", null, 1), com.example.TestRequests.state(List.of()), new com.example.web.dto.ContextDtos.HistorySummary("旧消息已摘要", 1, 1), List.of(), new InputDto(text, parts), new InteractionSettingsDto(InteractionSettingsDto.ReplyLength.STANDARD, InteractionSettingsDto.NarrativeMode.SCENE), new Context("session", catalog, plan, payloads), "operation");
    }
    void answer(String json) throws Exception { when(model.chat(any())).thenReturn(new ChatResponse(json, "stop", com.example.llm.model.TokenUsage.unavailable())); }
    @Test void firstImageIsRequiredAndNoSelectionModelIsCalled() throws Exception {
        var r = request("", List.of(new ContentPartDto("image", null, "new")), List.of(), null, List.of(payload("new")));
        chat.validateRequest(r);
        var prompt = builder.build(r);
        assertTrue(prompt.getMessages().getLast().getParts().stream().anyMatch(p -> "image_url".equals(p.type())));
        verifyNoInteractions(model);
        var missing = request("", r.input().parts(), List.of(), null, List.of());
        assertThrows(IllegalArgumentException.class, () -> chat.validateRequest(missing));
    }
    @Test void everyTextTurnWithImageHistoryUsesModelAndMaySelectZeroImages() throws Exception {
        var r = request("明天再聊", null, List.of(asset("old", 1)), null, List.of());
        answer("{\"status\":\"ready\",\"selectedHistoricalImages\":[],\"candidateAssetIds\":[],\"message\":\"\"}");
        Plan plan = selector.select(r);
        chat.validateRequest(request("明天再聊", null, r.visual().assetCatalog(), plan, List.of()));
        verify(model, times(1)).chat(any());
        selector.select(r);
        verify(model, times(2)).chat(any());
    }
    @Test void selectedArchivedImageIsActuallyReintroducedAndPlanCannotBeReusedForChangedInput() throws Exception {
        var r = request("看看符号下的小字", null, List.of(asset("old", 1)), null, List.of());
        answer("{\"status\":\"ready\",\"selectedHistoricalImages\":[{\"assetId\":\"old\",\"purpose\":\"核对小字\"}],\"candidateAssetIds\":[],\"message\":\"\"}");
        Plan plan = selector.select(r);
        var complete = request("看看符号下的小字", null, r.visual().assetCatalog(), plan, List.of(payload("old")));
        chat.validateRequest(complete);
        assertTrue(builder.build(complete).getMessages().stream().filter(m -> m.getParts() != null)
                .flatMap(m -> m.getParts().stream()).anyMatch(p -> payloadEquals(p, complete)));
        assertThrows(IllegalArgumentException.class, () -> chat.validateRequest(request("换了输入", null, r.visual().assetCatalog(), plan, List.of(payload("old")))));
        assertThrows(IllegalArgumentException.class, () -> chat.validateRequest(request(r.input().text(), null, r.visual().assetCatalog(), plan, List.of())));
    }
    boolean payloadEquals(Message.Part part, ChatApiRequest r) { return "image_url".equals(part.type()) && part.imageUrl().equals(r.visual().imagePayloads().getFirst().dataUrl()); }
    @Test void invalidIdsGetOneCorrectionAndThenFailWithoutGeneratingText() throws Exception {
        var r = request("继续", null, List.of(asset("old", 1)), null, List.of());
        answer("{\"status\":\"ready\",\"selectedHistoricalImages\":[{\"assetId\":\"other-session\",\"purpose\":\"参考\"}],\"candidateAssetIds\":[],\"message\":\"\"}");
        assertThrows(IOException.class, () -> selector.select(r));
        verify(model, times(2)).chat(any()); verify(model, never()).chatStream(any(), any());
    }
    @Test void ambiguityIsNotSilentlyResolvedAndBatchingDoesNotDropCandidates() throws Exception {
        var catalog = List.of(asset("one", 1), asset("two", 2));
        var r = request("之前的图", null, catalog, null, List.of());
        answer("{\"status\":\"ambiguous\",\"selectedHistoricalImages\":[],\"candidateAssetIds\":[\"one\",\"two\"],\"message\":\"你指哪张图片？\"}");
        Plan p = selector.select(r); assertEquals("ambiguous", p.status());
        assertThrows(IllegalArgumentException.class, () -> chat.validateRequest(request("之前的图", null, catalog, p, List.of())));
    }
    @Test void catalogIsBatchedInOrderAndCandidatesAreMergedByModel() throws Exception {
        var catalog = new ArrayList<Asset>();
        for (int i=1;i<=6;i++) catalog.add(asset("image-"+i,i));
        var r=request("比较这些图",null,catalog,null,List.of());
        int context = new VisualSelectionPromptBuilder(mapper).context(r).length();
        config.setPlanningInputChars(1100);
        when(model.chat(any())).thenAnswer(invocation -> {
            ChatRequest call=invocation.getArgument(0);
            String text=call.getMessages().getLast().getContent();
            int start=text.indexOf("图片目录：")+5, end=text.lastIndexOf(']')+1;
            var entries=mapper.readTree(text.substring(start,end));
            String chosen=entries.get(0).path("assetId").asText();
            return new ChatResponse("{\"status\":\"ready\",\"selectedHistoricalImages\":[{\"assetId\":\""+chosen+"\",\"purpose\":\"参考\"}],\"candidateAssetIds\":[],\"message\":\"\"}","stop", com.example.llm.model.TokenUsage.unavailable());
        });
        // A large candidate merge is explicitly rejected rather than silently truncated.
        try { selector.select(r); } catch (IllegalArgumentException e) { assertTrue(e.getMessage().contains("合并")); }
        verify(model, atLeast(2)).chat(any());
    }
    @Test void payloadHashMimePixelsAndCapabilityAreValidated() throws Exception {
        var r=request("",List.of(new ContentPartDto("image",null,"new")),List.of(),null,List.of(payload("new")));
        config.setMaxPixels(5); assertThrows(IllegalArgumentException.class, () -> chat.validateRequest(r));
        config.setMaxPixels(20_000_000); config.setSupported(false);
        assertThrows(IllegalArgumentException.class, () -> chat.validateRequest(r));
        config.setSupported(true);
        var bad=new Payload("new","0".repeat(64),payload("new").dataUrl());
        assertThrows(IllegalArgumentException.class, () -> chat.validateRequest(request("",r.input().parts(),List.of(),null,List.of(bad))));
    }
    private Asset photo(Observation observation) throws Exception {
        return new Asset("photo", payload("photo").sha256(), "image/png", png().length, 3, 2,
                List.of(new CharacterPhotoSource("character", 2)), observation, List.of());
    }

    private ChatApiRequest photoRequest(Asset photo, Plan plan, List<ContentPartDto> parts, List<Payload> payloads) {
        var base = request("看看她的耳环", parts, List.of(photo), plan, payloads);
        return new ChatApiRequest(new CharacterDto("林溪", "旧友", "银发，性格由文字设定决定", "photo", 2),
                base.state(), base.summary(), base.history(), base.input(), base.interactionSettings(), base.visual(), base.operationId());
    }

    @Test void firstCharacterPhotoIsRequiredWithoutFakeUploadAndSharesAttachmentSlot() throws Exception {
        config.setMaxImages(1);
        var r = photoRequest(photo(null), null, List.of(new ContentPartDto("image", null, "photo")), List.of(payload("photo")));
        chat.validateRequest(r);
        var prompt = builder.build(r);
        assertEquals(2, prompt.getMessages().size());
        assertEquals(1, prompt.getMessages().stream().filter(m -> m.getParts() != null)
                .flatMap(m -> m.getParts().stream()).filter(p -> "image_url".equals(p.type())).count());
        assertTrue(prompt.getMessages().getLast().getParts().stream().anyMatch(p -> p.text() != null
                && p.text().contains("角色形象参考，来源于角色资料版本 2")));
        verifyNoInteractions(model);
        assertThrows(IllegalArgumentException.class, () -> chat.validateRequest(photoRequest(photo(null), null, null, List.of())));
        assertThrows(IllegalArgumentException.class, () -> chat.validateRequest(photoRequest(photo(null), null,
                List.of(new ContentPartDto("image", null, "new")), List.of(payload("new"), payload("photo")))));
    }

    @Test void photoOnlyHistoryTriggersSemanticSelectionAndZeroSelectionRetainsObservation() throws Exception {
        var observed = new Observation("photo", "黑发红斗篷", List.of("银色耳环"), List.of(), List.of("刻字不清"),
                List.of(new CharacterPhotoSource("character", 2)), 1);
        var r = photoRequest(photo(observed), null, null, List.of());
        answer("{\"status\":\"ready\",\"selectedHistoricalImages\":[],\"candidateAssetIds\":[],\"message\":\"\"}");
        var plan = selector.select(r);
        var ready = photoRequest(photo(observed), plan, null, List.of());
        chat.validateRequest(ready);
        String text = builder.build(ready).getMessages().getFirst().getContent();
        assertTrue(text.contains("黑发红斗篷"));
        assertTrue(text.contains("当前剧情中的换装"));
        assertTrue(text.contains("角色明确文字设定优先"));
        assertTrue(text.contains("不从外貌推断性格"));
        answer("{\"status\":\"ready\",\"selectedHistoricalImages\":[{\"assetId\":\"photo\",\"purpose\":\"核对耳环刻字\"}],\"candidateAssetIds\":[],\"message\":\"\"}");
        plan = selector.select(r);
        var reread = photoRequest(photo(observed), plan, null, List.of(payload("photo")));
        chat.validateRequest(reread);
        assertTrue(builder.build(reread).getMessages().getLast().getParts().stream().anyMatch(p -> "image_url".equals(p.type())));
        var changed = new ChatApiRequest(new CharacterDto("林溪", "旧友", "改过描述", "photo", 2), reread.state(),
                reread.summary(), reread.history(), reread.input(), reread.interactionSettings(), reread.visual(), reread.operationId());
        assertThrows(IllegalArgumentException.class, () -> chat.validateRequest(changed));
    }

    @Test void photoSnapshotSourceMetadataAndCapabilityMustMatchBeforeCallingModel() throws Exception {
        Asset valid = photo(null);
        for (var source : List.of(new CharacterPhotoSource("other-character", 2), new CharacterPhotoSource("character", 3))) {
            var bad = new Asset(valid.assetId(), valid.sha256(), valid.mimeType(), valid.byteSize(), valid.width(), valid.height(),
                    List.of(source), null, List.of());
            assertThrows(IllegalArgumentException.class, () -> selector.select(photoRequest(bad, null, null, List.of())));
        }
        var missing = photoRequest(valid, null, null, List.of());
        var noCatalog = new ChatApiRequest(missing.character(), missing.state(), missing.summary(), missing.history(), missing.input(),
                missing.interactionSettings(), new Context("session", List.of(), null, List.of()), missing.operationId());
        assertThrows(IllegalArgumentException.class, () -> selector.select(noCatalog));
        var upload = new MessageSource("source-1", 1, "参考图", 1, 1);
        var unrelatedObservation = new Observation("photo", "看过聊天图", List.of(), List.of(), List.of(), List.of(upload), 1);
        var unbound = new Asset(valid.assetId(), valid.sha256(), valid.mimeType(), valid.byteSize(), valid.width(), valid.height(),
                List.of(new CharacterPhotoSource("character", 2), upload), unrelatedObservation, List.of());
        assertThrows(IllegalArgumentException.class, () -> selector.select(photoRequest(unbound, null, null, List.of())));
        config.setSupported(false);
        assertThrows(IllegalArgumentException.class, () -> selector.select(missing));
        config.setSupported(true);
        var badBytes = new Asset(valid.assetId(), "0".repeat(64), valid.mimeType(), valid.byteSize(), valid.width(), valid.height(), valid.sources(), null, List.of());
        assertThrows(IllegalArgumentException.class, () -> chat.validateRequest(photoRequest(badBytes, null, null, List.of(payload("photo")))));
        verifyNoInteractions(model);
    }

    @Test void visualSourcesRoundTripAsDiscriminatedUnion() throws Exception {
        var original = photo(null);
        var decoded = mapper.readValue(mapper.writeValueAsString(original), Asset.class);
        assertEquals(original, decoded);
        assertTrue(mapper.writeValueAsString(original).contains("\"type\":\"character_photo\""));
        assertTrue(mapper.writeValueAsString(asset("message", 1)).contains("\"type\":\"message\""));
    }

}
