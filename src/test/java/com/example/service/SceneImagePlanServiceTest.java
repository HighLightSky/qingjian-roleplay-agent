package com.example.service;

import static org.junit.jupiter.api.Assertions.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import com.example.TestRequests;
import com.example.web.dto.*;
import com.example.web.dto.VisualDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;

class SceneImagePlanServiceTest {
    final SceneImagePlanService service = new SceneImagePlanService(new ObjectMapper());
    final String hash = "a".repeat(64);
    final DispatchDtos.MessageMeta source = new DispatchDtos.MessageMeta("reply", 2, "2026-10-25T00:00:00Z", 3);

    Asset identity() {
        return new Asset("img1", hash, "image/png", 100, 32, 32, List.of(new CharacterPhotoSource("character", 1)),
                null, List.of(), hash);
    }

    ChatApiRequest context(String photo, List<Asset> assets) {
        return new ChatApiRequest(new CharacterDto("林溪", "", "", photo, 1), TestRequests.state(List.of()),
                TestRequests.summary(), List.of(), new InputDto("换成红裙，去花园", null), null,
                new Context("session", assets, null, List.of(), List.of()), "op");
    }

    @Test
    void firstTurnWithoutIdentityAcceptsFreeTextAndNoReferences() {
        var plan = service.resolvePlan("[画面计划]{\"referenceImages\":[]}\n李白站在瀑布旁。", context(null, List.of()), source);
        assertEquals("李白站在瀑布旁。", plan.prompt());
        assertTrue(plan.referenceImages().isEmpty());
        assertNull(plan.error());
        assertEquals(3, plan.sourceCheckpointVersion());
    }

    @Test
    void programInjectsIdentityMergesDuplicatesAndAllowsUnreadCatalogReferences() {
        var generation = new Asset("img2", hash, "image/png", 100, 32, 32,
                List.of(new GenerationSource("g", "p", "old", 1, "旧画面要求", false)), null, List.of(), hash);
        var plan = service.resolvePlan(
                """
                        [画面计划]{"referenceImages":[{"assetId":"img2","roles":["identity"],"scope":"历史人物"},{"assetId":"img1","roles":["outfit"],"scope":"袖口"}]}
                        用 img1 参考袖口，人物在新花园里。
                        """,
                context("img1", List.of(identity(), generation)), source);
        assertNull(plan.error());
        assertEquals(List.of("img1", "img2"), plan.referenceImages().stream().map(r -> r.assetId()).toList());
        assertEquals(List.of("identity", "outfit"), plan.referenceImages().getFirst().roles());
        assertEquals("g", plan.referenceImages().getLast().sourceGenerationId());
    }

    @Test
    void invalidSuggestionsPreserveEditablePromptAndAvailableIdentity() {
        var plan = service.resolvePlan("[画面计划]{broken}\n仍然可修改的提示词", context("img1", List.of(identity())), source);
        assertEquals("仍然可修改的提示词", plan.prompt());
        assertNotNull(plan.error());
        assertEquals("img1", plan.referenceImages().getFirst().assetId());
    }

    @Test
    void unavailableReferenceIsVisibleAndRemovableInsteadOfLosingDraft() {
        var plan = service.resolvePlan("""
                [画面计划]{"referenceImages":[{"assetId":"img8","roles":["pose"],"scope":"姿势"}]}
                站在瀑布旁
                """, context(null, List.of()), source);
        assertTrue(plan.error().contains("img8"));
        assertNull(plan.referenceImages().getFirst().sourceSha256());
    }

    @Test
    void observationPolicyDoesNotObserveGeneratedRequirements() {
        var generated = new Asset("img2", hash, "image/png", 100, 32, 32,
                List.of(new GenerationSource("g", "p", "old", 1, "白裙人物", false)), null, List.of(), hash);
        assertEquals(List.of("img3"),
                ImageObservationPolicy.observationAssetIds(context(null, List.of(generated)), List.of("img2", "img3")));
    }
}
