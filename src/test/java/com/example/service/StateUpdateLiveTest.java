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
import com.example.llm.model.StreamDelta;
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
                .8, 8192, 120, 60, 2048, 32);
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
            var real = new OpenAiClient(http, mapper, llm.baseUrl(), llm.apiKey(), Duration.ofSeconds(120), Duration.ofSeconds(5), serializer);
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

                @Override public ChatStreamResult chatStream(ChatRequest call, Consumer<StreamDelta> delta)
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
    void realScenePromptsKeepPoseQueriesVisibleAndSeparateFromStory() throws Exception {
        var mapper = new ObjectMapper();
        var llm = new LlmProperties(System.getenv().getOrDefault("LLM_BASE_URL", "https://10.21.16.197/v1/chat/completions"),
                System.getenv().getOrDefault("LLM_API_KEY", "llama"), System.getenv().getOrDefault("LLM_MODEL", "Qwen3.8-27B"),
                .8, 8192, 120, 60, 2048, 32);
        var serializer = new LlmRequestMapper(mapper, llm);
        var scenario = com.example.SelectionFixtures.scenario(com.example.SelectionFixtures.History.NONE,
                com.example.SelectionFixtures.Photo.OBSERVED);
        var original = scenario.context();
        var checks = Map.of(
                "pose", "她穿着原来的红色斗篷，侧身站在窗边，右手扶住窗台，目视窗外，双脚落地。",
                "outfit", "她已经脱下红色斗篷，穿着里面的白色衬衫，站在书桌旁，外套搭在椅背上。",
                "reading", "她脱下红色斗篷并搭在椅背上，穿白色衬衫，坐在书桌旁的椅子上，双脚落地，左手扶住桌上的书，右手搭在书页边缘，低头阅读。",
                "hotel", "林溪这位年轻的女旅馆老板穿着浅蓝针织开衫和白裙，开心地在酒店门口台阶下站着，身体微侧，右手握着牛皮纸袋提手，左臂垂在身侧，稍偏头看向一侧。夕阳照着玻璃门，她等着与旧友继续逛街。",
                "closeup", "当前画面为双手局部特写，只可见手和手腕：一只手的掌心覆盖另一只手的手背，手指放松。无法分辨人物自身的左右手，其他身体部位和周围物体均不在画面内。她刚才从学校出来，穿着红色斗篷，心里有些紧张。",
                "stride", "当前静态画面为行走姿态，躯干直立，双腿前后分开，一条腿的膝部略弯，双臂自然前后错开。无法确认人物自身左右；看不到与物体的接触。她在热闹街道上准备跑向酒店，之后打算推门进去找朋友。");
        var saved = mapper.createObjectNode();
        try (var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            var client = new OpenAiClient(http, mapper, llm.baseUrl(), llm.apiKey(), Duration.ofSeconds(120), Duration.ofSeconds(5), serializer);
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
                String poseQuery = result.scenePlan().poseQuery();
                assertFalse(poseQuery.isBlank(), "姿态检索描述必须独立返回");
                assertEquals("img2", result.scenePlan().characterReferenceAssetId());
                assertTrue(prompt.contains("<image2>"), "身份应直接引用自动角色照片");
                assertFalse(prompt.contains("img2"));
                assertFalse(prompt.contains("\n"), "画面指令应为单段");
                assertEquals("img2", result.scenePlan().referenceImages().getFirst().assetId());
                assertEquals(3, result.scenePlan().sourceCheckpointVersion());
                if (entry.getKey().equals("reading")) {
                    assertTrue(poseQuery.contains("坐"));
                    assertTrue(poseQuery.contains("书"));
                }
                if (entry.getKey().equals("outfit")) {
                    assertTrue(poseQuery.contains("站"), "应保留有依据的站姿：" + poseQuery);
                    for (String excluded : List.of("桌", "椅", "斗篷", "衬衫", "外套")) {
                        assertFalse(poseQuery.contains(excluded), "缺少姿态细节时不能用背景或服装凑数：" + poseQuery);
                    }
                }
                if (entry.getKey().equals("pose")) {
                    assertTrue(poseQuery.contains("窗台"), "应保留有依据的支撑接触：" + poseQuery);
                    assertFalse(poseQuery.contains("窗外"), "头部方向不应夹带场景目标：" + poseQuery);
                }
                if (entry.getKey().equals("hotel")) {
                    for (String excluded : List.of("林溪", "年轻", "女", "老板", "针织", "裙", "开心", "酒店", "旅馆", "门", "台阶", "牛皮", "夕阳", "玻璃", "旧友", "逛街")) {
                        assertFalse(poseQuery.contains(excluded), "姿态描述混入剧情或外观信息：" + poseQuery);
                    }
                    assertTrue(poseQuery.contains("站"), "应保留整体站姿：" + poseQuery);
                    assertTrue(poseQuery.contains("提手"), "应保留有依据的手部接触：" + poseQuery);
                }
                if (entry.getKey().equals("closeup")) {
                    for (String excluded : List.of("左", "右", "站", "坐", "肩", "躯干", "头", "腿", "脚", "膝", "椅", "桌", "学校", "斗篷", "紧张")) {
                        assertFalse(poseQuery.contains(excluded), "局部特写不应补全不可见信息或猜测左右：" + poseQuery);
                    }
                    assertTrue(poseQuery.contains("掌心"), "应保留可见的掌心接触：" + poseQuery);
                    assertTrue(poseQuery.contains("手背"), "应保留可见的手背接触：" + poseQuery);
                }
                if (entry.getKey().equals("stride")) {
                    for (String excluded : List.of("左", "右", "街道", "酒店", "准备", "跑向", "之后", "推门", "朋友", "椅", "扶", "握")) {
                        assertFalse(poseQuery.contains(excluded), "静态姿态不应混入运动过程或臆测接触：" + poseQuery);
                    }
                    assertTrue(poseQuery.contains("前后"), "应保留双腿或双臂的静态位置：" + poseQuery);
                }
                saved.set(entry.getKey(), mapper.valueToTree(result));
                System.out.println("画面真实回归通过：场景=" + entry.getKey() + "，提示词字数=" + prompt.codePointCount(0, prompt.length()));
            }
        }
        java.nio.file.Files.writeString(java.nio.file.Path.of("target/scene-live-results.json"),
                mapper.writerWithDefaultPrettyPrinter().writeValueAsString(saved));
    }
}
