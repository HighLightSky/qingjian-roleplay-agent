package com.example.service;

import static org.junit.jupiter.api.Assertions.*;

import java.io.ByteArrayInputStream;
import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import javax.imageio.ImageIO;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.beans.factory.config.YamlPropertiesFactoryBean;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.core.env.PropertiesPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.ClassPathResource;

import com.example.TestRequests;
import com.example.config.*;
import com.example.image.QwenImageClient;
import com.example.llm.*;
import com.example.prompt.*;
import com.example.web.dto.*;
import com.example.web.dto.SceneImageDtos.*;
import com.example.web.dto.SceneImageDtos.Source;
import com.example.web.dto.StateDtos.*;
import com.example.web.dto.VisualDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;

/** 显式启用后访问真实整理及图像服务，测试产物保存在 target，不写入浏览器数据。 */
@EnabledIfSystemProperty(named = "roleplay.live-images", matches = "true")
class SceneGenerationLiveTest {
    @Test
    void stateGeneratedPromptsCreatePoseOutfitAndReadingScenes() throws Exception {
        var yaml = new YamlPropertiesFactoryBean();
        yaml.setResources(new ClassPathResource("application.yml"));
        var environment = new StandardEnvironment();
        environment.getPropertySources().addLast(new PropertiesPropertySource("application", Objects.requireNonNull(yaml.getObject())));
        var binder = Binder.get(environment);
        var llm = binder.bind("roleplay.llm", Bindable.of(LlmProperties.class)).get();
        var generation = binder.bind("roleplay.image-generation", Bindable.of(ImageGenerationProperties.class)).get();
        var vision = binder.bind("roleplay.vision", Bindable.of(VisionProperties.class)).get();
        var contextConfig = binder.bind("roleplay.context", Bindable.of(ContextProperties.class)).get();
        var auxiliary = binder.bind("roleplay.auxiliary", Bindable.of(AuxiliaryContextProperties.class)).get();
        var dispatch = binder.bind("roleplay.dispatch", Bindable.of(DispatchProperties.class)).get();
        var mapper = new ObjectMapper();
        var output = Path.of("target/scene-generation-live");
        Files.createDirectories(output);
        try (var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            var imageClient = new QwenImageClient(http, mapper, generation);
            var validation = new ImageGenerationValidation(generation, vision);
            var initial = new GenerationRequest(UUID.randomUUID().toString(), new Source("seed", "session", "assistant", 2, 1),
                    "一位二十六岁的成年女性，黑色长发，穿白衬衫与红色斗篷，正面站立在明亮书房内，双手自然垂在身体两侧，背景有木书桌、椅子与窗户，写实摄影，全身构图。",
                    generation.defaultWidth(), generation.defaultHeight(), List.of());
            var seedSubmission = validation.validateRequest(initial);
            byte[] seed = imageClient.edit(UUID.randomUUID().toString(), seedSubmission.effectivePrompt(),
                    List.of(validation.blackCanvas(seedSubmission)));
            validation.validateOutput(seed);
            Files.write(output.resolve("identity.png"), seed);
            var decoded = ImageIO.read(new ByteArrayInputStream(seed));
            String hash = ImageValidationService.sha256(seed);
            var asset = new Asset("img1", hash, "image/png", seed.length, decoded.getWidth(), decoded.getHeight(),
                    List.of(new CharacterPhotoSource("character", 1)), null, List.of(), hash);
            var payload = new Payload("img1", hash, "data:image/png;base64," + Base64.getEncoder().encodeToString(seed));
            var serializer = new LlmRequestMapper(mapper, llm);
            var client = new OpenAiClient(http, mapper, llm.baseUrl(), llm.apiKey(), Duration.ofSeconds(llm.timeoutSeconds()), Duration.ofSeconds(5), serializer);
            var counter = new LlamaTokenCounter(http, mapper, serializer, llm, contextConfig);
            var contexts = new AuxiliaryContextService(mapper, counter, contextConfig, auxiliary);
            var images = new ImageValidationService(vision);
            var budgets = new ContextBudgetService(counter, new PromptBuilder(llm, vision), contextConfig, vision,
                    new ContextValidation(), images, mapper);
            var state = new StateUpdateService(client, mapper, new StateUpdatePromptBuilder(mapper, dispatch), images,
                    budgets, contexts, new SceneImagePlanService(), vision);
            var results = mapper.createObjectNode();
            var scenes = new LinkedHashMap<String, String>();
            scenes.put("pose", "她穿着原来的红色斗篷，侧身站在窗边，右手扶住窗台，目视窗外，双脚落地。");
            scenes.put("outfit", "她脱下红色斗篷，穿着里面的白色衬衫，站在书桌旁，斗篷搭在椅背上。");
            scenes.put("reading", "她脱下红色斗篷并搭在椅背上，穿白色衬衫，坐在书桌旁的椅子上，双脚落地，左手扶住桌上的书，右手搭在书页边缘，低头阅读。");
            for (var scene : scenes.entrySet()) {
                var context = new ChatApiRequest(new CharacterDto("林溪", "旧友", "二十六岁的成年女性", "img1", 1),
                        TestRequests.state(List.of()), TestRequests.summary(), List.of(), new InputDto("继续当前场景。", null),
                        new InteractionSettingsDto(InteractionSettingsDto.ReplyLength.STANDARD, InteractionSettingsDto.NarrativeMode.SCENE),
                        new Context("session", List.of(asset), null, List.of(payload), List.of()), "scene-" + scene.getKey());
                var request = new UpdateRequest(context.operationId(), context, 0, 2, 1, List.of(
                        new SourceMessage("user", 1, "user", context.input().textOf(), "complete", "2026-10-25T00:00:00Z"),
                        new SourceMessage("assistant", 2, "assistant", scene.getValue(), "complete", "2026-10-25T00:00:01Z")));
                state.validateRequest(request);
                var result = state.update(request);
                assertTrue(result.scenePlan().prompt().contains("<image2>"));
                var imageRequest = new GenerationRequest(UUID.randomUUID().toString(), initial.source(), result.scenePlan().prompt(),
                        generation.defaultWidth(), generation.defaultHeight(),
                        List.of(new InputImage("img1", result.scenePlan().referenceImages().getFirst().scope(), hash, hash, null)));
                var submission = validation.validateRequest(imageRequest);
                byte[] generated = imageClient.edit(UUID.randomUUID().toString(), submission.effectivePrompt(), List.of(
                        validation.blackCanvas(submission), new QwenImageClient.Image("img1", "image/png", decoded.getWidth(), decoded.getHeight(), seed)));
                validation.validateOutput(generated);
                var dimensions = ImageIO.read(new ByteArrayInputStream(generated));
                assertEquals(submission.width(), dimensions.getWidth());
                assertEquals(submission.height(), dimensions.getHeight());
                Files.write(output.resolve(scene.getKey() + ".png"), generated);
                results.set(scene.getKey(), mapper.valueToTree(result));
                Files.writeString(output.resolve("results.json"), mapper.writerWithDefaultPrettyPrinter().writeValueAsString(results));
                System.out.println("实际生图通过：场景=" + scene.getKey() + "，画幅=" + dimensions.getWidth() + "×" + dimensions.getHeight());
            }
        }
    }
}
