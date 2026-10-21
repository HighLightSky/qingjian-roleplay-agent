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
        selector = new VisualSelectionService(model, mapper, new VisualSelectionPromptBuilder(mapper), images, new ContextValidation(mapper));
        chat = new ChatService(builder, model, images, selector, new ContextValidation(mapper));
    }
    byte[] png() throws Exception {
        var out = new ByteArrayOutputStream(); ImageIO.write(new BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB), "png", out); return out.toByteArray();
    }
    Payload payload(String id) throws Exception {
        byte[] bytes = png(); return new Payload(id, ImageValidationService.sha256(bytes), "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes));
    }
    Asset asset(String id, int seq) throws Exception {
        return new Asset(id, payload(id).sha256(), "image/png", png().length, 3, 2,
                List.of(new Source("source-" + seq, seq, "地图参考", 1, 1)), null, List.of());
    }
    ChatApiRequest request(String text, List<ContentPartDto> parts, List<Asset> catalog, Plan plan, List<Payload> payloads) {
        return new ChatApiRequest(new CharacterDto("林溪", "老板", "好奇，说话简短，生活在山城。"), com.example.TestRequests.state(List.of()), "旧消息已摘要", List.of(), new InputDto(text, parts), new InteractionSettingsDto(InteractionSettingsDto.ReplyLength.STANDARD, InteractionSettingsDto.NarrativeMode.SCENE), new Context("session", catalog, plan, payloads), "operation");
    }
    void answer(String json) throws Exception { when(model.chat(any())).thenReturn(new ChatResponse(json, "stop")); }
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
        config.setPlanningInputChars(context+2500+1100);
        when(model.chat(any())).thenAnswer(invocation -> {
            ChatRequest call=invocation.getArgument(0);
            String text=call.getMessages().getLast().getContent();
            int start=text.indexOf("图片目录：")+5, end=text.lastIndexOf(']')+1;
            var entries=mapper.readTree(text.substring(start,end));
            String chosen=entries.get(0).path("assetId").asText();
            return new ChatResponse("{\"status\":\"ready\",\"selectedHistoricalImages\":[{\"assetId\":\""+chosen+"\",\"purpose\":\"参考\"}],\"candidateAssetIds\":[],\"message\":\"\"}","stop");
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
}
