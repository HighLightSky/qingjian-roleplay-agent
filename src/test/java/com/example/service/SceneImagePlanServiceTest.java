package com.example.service;

import static org.junit.jupiter.api.Assertions.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import com.example.TestRequests;
import com.example.web.dto.*;
import com.example.web.dto.VisualDtos.*;
import com.example.web.dto.SceneImageDtos.Reference;
import com.fasterxml.jackson.databind.ObjectMapper;

class SceneImagePlanServiceTest {
    final SceneImagePlanService service = new SceneImagePlanService(new ObjectMapper(), TestRequests.vision(),
            TestRequests.generation("http://localhost"));
    final String hash = "a".repeat(64);
    Asset identity() {
        return new Asset("img1", hash, "image/png", 100, 32, 32, List.of(new CharacterPhotoSource("character", 1)),
                null, List.of(), hash);
    }
    ChatApiRequest context(List<Asset> assets) {
        return new ChatApiRequest(new CharacterDto("林溪", "", "", "img1", 1), TestRequests.state(List.of()),
                TestRequests.summary(), List.of(), new InputDto("换成红裙，去花园", null), null,
                new Context(
                        "session", assets, null, assets.stream()
                                .map(a -> new Payload(a.assetId(), a.sha256(), "data:image/png;base64,AA==")).toList(),
                        List.of()),
                "op");
    }
    String output(String continuity, String previous, String refs) {
        return "[画面计划]{\"action\":\"create\",\"continuity\":\"" + continuity + "\",\"previousPlanId\":\"" + previous
                + "\",\"target\":{\"subject\":\"林溪\",\"outfit\":\"红裙\",\"pose\":\"站立微笑\",\"environment\":\"花园\",\"light\":\"白天\",\"material\":\"棉布\",\"composition\":\"全身\",\"style\":\"写实\"},\"referenceImages\":"
                + refs
                + "}\n[参考图说明]以 <image1> 仅作身份参考，重建背景。\n[主体]林溪穿红裙站立微笑。\n[环境]花园。\n[光线]白天。\n[材质]棉布。\n[构图]全身。\n[风格]写实。\n[画面摘要]林溪穿红裙站在花园微笑，白天，全身写实像。";
    }
    @Test
    void newSceneAndExplicitOutfitStayInTargetAndBindOriginalReference() throws Exception {
        var input = context(List.of(identity()));
        String raw = output("new_scene", "",
                "[{\"assetId\":\"img1\",\"roles\":[\"base\",\"identity\"],\"scope\":\"只参照脸部身份\"}]");
        var plan = service.resolvePlan(raw, input, new DispatchDtos.MessageMeta("reply", 2, "2026-10-25T00:00:00Z", 3));
        assertEquals("ready", plan.status());
        assertEquals("红裙", plan.target().get("outfit"));
        assertEquals("花园", plan.target().get("environment"));
        assertEquals("", input.state().visualState().outfit());
        assertEquals(3, plan.sourceCheckpointVersion());
        assertEquals(hash, plan.referenceImages().getFirst().sourceSha256());
        assertEquals(service.fingerprint(plan), plan.fingerprint());
    }

    @Test
    void roleValidationRejectsMissingIdentityAndMismatchedNumbering() {
        assertThrows(IllegalArgumentException.class, () -> service
                .validateReferences(List.of(new Reference("img2", List.of("base"), "环境", hash, null)), "img1"));
        assertThrows(IllegalArgumentException.class, () -> service.validateReferences(
                List.of(new Reference("img2", List.of("base", "identity"), "人物", hash, null)), "img1"));
        assertThrows(IllegalArgumentException.class, () -> service
                .validateReferences(List.of(new Reference("img1", List.of("identity"), "人物", hash, null)), "img1"));
    }

    @Test
    void continuingUsesEligiblePreviousSceneButExplicitOutfitAndLocationRemainNewTargets() throws Exception {
        var previous = new Asset(
                "img2", hash, "image/png", 100, 32, 32, List.of(new GenerationSource("generation", "previous-plan",
                        "old-reply", 2, "old-scene", "白裙，室内", false, Map.of("outfit", "白裙", "environment", "室内"))),
                null, List.of(), hash);
        var input = context(List.of(identity(), previous));
        var refs = "[{\"assetId\":\"img2\",\"roles\":[\"base\",\"continuity\"],\"scope\":\"延续布料\"},"
                + "{\"assetId\":\"img1\",\"roles\":[\"identity\"],\"scope\":\"只参照脸部身份\"}]";
        String continued = output("continue_scene", "gen1", refs).replace("以 <image1> 仅作身份参考，重建背景。",
                "以 <image1> 为底图，只延续布料质感；人物参照 <image2>，红裙和花园以文字为准。");
        var source = new DispatchDtos.MessageMeta("reply", 4, "2026-10-25T00:00:00Z", 1);
        var plan = service.resolvePlan(continued, input, source);
        assertEquals("old-scene", plan.sceneId());
        assertEquals("previous-plan", plan.previousPlanId());
        assertEquals("红裙", plan.target().get("outfit"));
        assertEquals("花园", plan.target().get("environment"));
        assertEquals("generation", plan.referenceImages().getFirst().sourceGenerationId());
        var newScene = service.resolvePlan(continued.replace("continue_scene", "new_scene"), input, source);
        assertNotEquals("old-scene", newScene.sceneId());
        var hidden = new ChatApiRequest(input.character(), input.state(), input.summary(), input.history(),
                input.input(), input.interactionSettings(), new Context("session", input.visual().assetCatalog(), null,
                        List.of(input.visual().imagePayloads().getFirst()), List.of()),
                "op");
        assertThrows(IllegalArgumentException.class, () -> service.resolvePlan(continued, hidden, source));
    }

    @Test
    void observationPolicyUsesOnlyFirstObservationAndExcludesGeneratedDescriptions() {
        var previous = new Observation("img1", "人物", List.of(), List.of(), List.of(), identity().sources(), 4);
        var observed = new Asset("img1", hash, "image/png", 100, 32, 32, identity().sources(), previous, List.of(),
                hash);
        var generated = new Asset("img2", hash, "image/png", 100, 32, 32,
                List.of(new GenerationSource("g", "p", "reply", 2, "scene", "白裙人物", false, Map.of("outfit", "白裙"))),
                null, List.of(), hash);
        assertEquals(List.of("img3"), ImageObservationPolicy.observationAssetIds(context(List.of(observed, generated)),
                List.of("img1", "img2", "img3")));
        assertEquals(4, previous.version());
    }
}
