package com.example.service;

import static org.junit.jupiter.api.Assertions.*;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import com.example.TestRequests;
import com.example.config.*;
import com.example.llm.*;
import com.example.llm.model.*;
import com.example.prompt.StateUpdatePromptBuilder;
import com.example.web.dto.*;
import com.example.web.dto.StateDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;

/** 显式启用后验证部署支持整理 schema、目标局部更新和进展证据。 */
@EnabledIfSystemProperty(named = "roleplay.live-llm", matches = "true")
class StateUpdateLiveTest {
    enum Scenario { CREATE, FOCUS, PROGRESS }

    @ParameterizedTest
    @EnumSource(Scenario.class)
    void realStateUpdateUsesStructuredGoals(Scenario scenario) throws Exception {
        var mapper = new ObjectMapper();
        var llm = new LlmProperties(System.getenv().getOrDefault("LLM_BASE_URL", "https://10.21.16.197/v1/chat/completions"),
                System.getenv().getOrDefault("LLM_API_KEY", "llama"), System.getenv().getOrDefault("LLM_MODEL", "Qwen3.8-27B"),
                .8, 8192, 120);
        var serializer = new LlmRequestMapper(mapper, llm);
        var base = TestRequests.state(List.of());
        var old = new GoalValue("寻找失踪的哥哥", "active", "向旅馆掌柜询问线索", "已来到旅馆，尚未获得哥哥去向的确切线索。");
        var state = new Snapshot(base.sessionId(), base.characterId(), 1, 0, base.story(), Map.of(), List.of(),
                scenario == Scenario.CREATE ? List.of() : List.of(new Goal("goal", "session", old, 1,
                        "automatic", List.of(), "2026-10-22T00:00:00Z")), com.example.web.dto.StateDtos.VisualState.empty(), java.util.Map.of());
        String input = switch (scenario) {
            case CREATE -> "我想和你一起寻找失踪的哥哥，这是我们今后共同的长期目标。";
            case FOCUS -> "寻找哥哥的目标继续，但先不要询问掌柜，当前只关注如何取得查看旅馆登记册的许可。还没拿到许可，也没有新线索。";
            case PROGRESS -> "掌柜已经核对了登记册，确认哥哥昨天下午已离开旅馆前往码头，这是新查实的线索。";
        };
        String reply = switch (scenario) {
            case CREATE -> "她点头答应：我们一起寻找你失踪的哥哥，直到查明他的下落。";
            case FOCUS -> "她同意暂不询问掌柜，把当前关注点改为取得查看登记册的许可；尚未采取行动，也没有新进展。";
            case PROGRESS -> "她记下已查实的结果：哥哥昨天下午离开旅馆前往码头。哥哥仍未找到，下一步需要核实他在码头的下落。";
        };
        var context = new ChatApiRequest(new CharacterDto("林溪", "旧友", "一起寻找哥哥的伙伴", null, 1),
                state, TestRequests.summary(), List.of(), new InputDto(input, null),
                new InteractionSettingsDto(InteractionSettingsDto.ReplyLength.STANDARD, InteractionSettingsDto.NarrativeMode.SCENE),
                null, "operation");
        var request = new UpdateRequest("operation", context, 0, 2, 1, List.of(
                new SourceMessage("user", 1, "user", input, "complete", "2026-10-23T00:00:00Z"),
                new SourceMessage("assistant", 2, "assistant", reply, "complete", "2026-10-23T00:00:01Z")));
        try (var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            var real = new OpenAiClient(http, mapper, llm.baseUrl(), llm.apiKey(), Duration.ofSeconds(120), serializer);
            var calls = new ArrayList<ChatRequest>();
            LLMClient observed = new LLMClient() {
                @Override public ChatResponse chat(ChatRequest call) throws java.io.IOException, InterruptedException {
                    calls.add(call);
                    assertTrue(call.isThinkingEnabled());
                    assertNotNull(call.getResponseSchema());
                    assertEquals(serializer.chatBody(call, false).path("response_format"),
                            serializer.templateBody(call).path("response_format"));
                    return real.chat(call);
                }

                @Override public ChatStreamResult chatStream(ChatRequest call, Consumer<String> delta)
                        throws java.io.IOException, InterruptedException {
                    return real.chatStream(call, delta);
                }
            };
            var counter = new LlamaTokenCounter(http, mapper, serializer, llm, TestRequests.contextProperties());
            var materials = new AuxiliaryContextService(mapper, counter, TestRequests.contextProperties(),
                    new AuxiliaryContextProperties(4, 8192, 8192, 32768, 32768, 2048, 2048));
            var service = new StateUpdateService(observed, mapper, new StateUpdatePromptBuilder(mapper, TestRequests.dispatch()),
                    new ImageValidationService(com.example.TestRequests.vision()), TestRequests.budgets(), materials, new SceneImagePlanService(), com.example.TestRequests.vision());
            new ContextValidation().validate(context);
            service.validateRequest(request);

            var result = service.update(request);

            assertEquals(1, calls.size(), "合法材料应一次返回有效结果");
            assertEquals(1, result.goalChanges().size());
            var change = result.goalChanges().getFirst();
            if (scenario == Scenario.CREATE) {
                assertEquals("create", change.action());
                assertTrue(change.value().path("description").asText().contains("哥哥"));
            } else {
                assertEquals("update", change.action());
                assertEquals("goal", change.id());
                if (scenario == Scenario.FOCUS) {
                    assertEquals(old.progressSummary(), change.value().path("progressSummary").asText());
                    assertTrue(change.value().path("currentFocus").asText().contains("许可"));
                } else {
                    assertNotEquals(old.progressSummary(), change.value().path("progressSummary").asText());
                    assertTrue(change.value().path("progressSummary").asText().contains("码头"));
                }
            }
            System.out.println("整理真实回归通过：场景=" + scenario + "，调用次数=" + calls.size());
        }
    }

    @Test
    void realScenePromptsFollowPoseOutfitAndReadingWithoutRewritingIdentity() throws Exception {
        var mapper = new ObjectMapper();
        var llm = new LlmProperties(System.getenv().getOrDefault("LLM_BASE_URL", "https://10.21.16.197/v1/chat/completions"),
                System.getenv().getOrDefault("LLM_API_KEY", "llama"), System.getenv().getOrDefault("LLM_MODEL", "Qwen3.8-27B"),
                .8, 8192, 120);
        var serializer = new LlmRequestMapper(mapper, llm);
        var scenario = com.example.SelectionFixtures.scenario(com.example.SelectionFixtures.History.NONE,
                com.example.SelectionFixtures.Photo.OBSERVED);
        var original = scenario.context();
        var checks = Map.of(
                "pose", "她穿着原来的红色斗篷，侧身站在窗边，右手扶住窗台，目视窗外，双脚落地。",
                "outfit", "她已经脱下红色斗篷，穿着里面的白色衬衫，站在书桌旁，外套搭在椅背上。",
                "reading", "她脱下红色斗篷并搭在椅背上，穿白色衬衫，坐在书桌旁的椅子上，双脚落地，左手扶住桌上的书，右手搭在书页边缘，低头阅读。");
        var saved = mapper.createObjectNode();
        try (var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            var client = new OpenAiClient(http, mapper, llm.baseUrl(), llm.apiKey(), Duration.ofSeconds(120), serializer);
            var counter = new LlamaTokenCounter(http, mapper, serializer, llm, TestRequests.contextProperties());
            var contexts = new AuxiliaryContextService(mapper, counter, TestRequests.contextProperties(),
                    new AuxiliaryContextProperties(4, 8192, 8192, 32768, 32768, 2048, 2048));
            var service = new StateUpdateService(client, mapper, new StateUpdatePromptBuilder(mapper, TestRequests.dispatch()),
                    new ImageValidationService(TestRequests.vision()), TestRequests.budgets(), contexts,
                    new SceneImagePlanService(), TestRequests.vision());
            for (var entry : checks.entrySet()) {
                var context = new ChatApiRequest(original.character(), original.state(), original.summary(), List.of(),
                        new InputDto("继续当前场景。", null), original.interactionSettings(), original.visual(), "scene-" + entry.getKey());
                var request = new UpdateRequest(context.operationId(), context, 0, 2, 3, List.of(
                        new SourceMessage("user", 1, "user", context.input().textOf(), "complete", "2026-10-25T00:00:00Z"),
                        new SourceMessage("assistant", 2, "assistant", entry.getValue(), "complete", "2026-10-25T00:00:01Z")));
                service.validateRequest(request);
                var result = service.update(request);
                String prompt = result.scenePlan().prompt();
                assertTrue(prompt.contains("<image2>"), "身份应直接引用自动角色照片");
                assertFalse(prompt.contains("img2"));
                assertFalse(prompt.contains("\n"), "画面指令应为单段");
                assertEquals("img2", result.scenePlan().referenceImages().getFirst().assetId());
                assertEquals(3, result.scenePlan().sourceCheckpointVersion());
                if (entry.getKey().equals("reading")) {
                    assertTrue(prompt.contains("椅"));
                    assertTrue(prompt.contains("书"));
                }
                saved.set(entry.getKey(), mapper.valueToTree(result));
                System.out.println("画面真实回归通过：场景=" + entry.getKey() + "，提示词字数=" + prompt.codePointCount(0, prompt.length()));
            }
        }
        java.nio.file.Files.writeString(java.nio.file.Path.of("target/scene-live-results.json"),
                mapper.writerWithDefaultPrettyPrinter().writeValueAsString(saved));
    }
}
