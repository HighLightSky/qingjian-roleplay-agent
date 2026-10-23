package com.example.service;

import static org.junit.jupiter.api.Assertions.*;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.*;
import java.util.function.Consumer;

import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import com.example.SelectionFixtures;
import com.example.TestRequests;
import com.example.config.*;
import com.example.llm.*;
import com.example.llm.model.*;
import com.example.prompt.*;
import com.fasterxml.jackson.databind.ObjectMapper;

/** 显式启用后才访问真实部署；证书信任由运行环境配置，不修改生产 TLS 行为。 */
@EnabledIfSystemProperty(named = "roleplay.live-llm", matches = "true")
class VisualSelectionLiveTest {
    @ParameterizedTest
    @MethodSource("com.example.SelectionFixtures#cases")
    void realSelectionHandlesHistoryAndReferencePhotoCombinations(SelectionFixtures.History history,
            SelectionFixtures.Photo photo) throws Exception {
        var mapper = new ObjectMapper();
        var llm = new LlmProperties(System.getenv().getOrDefault("LLM_BASE_URL", "https://10.21.16.197/v1/chat/completions"),
                System.getenv().getOrDefault("LLM_API_KEY", "llama"), System.getenv().getOrDefault("LLM_MODEL", "Qwen3.8-27B"), .8, 8192, 45);
        var requests = new LlmRequestMapper(mapper, llm);
        var scenario = SelectionFixtures.scenario(history, photo);
        var context = scenario.context();
        var vision = new VisionProperties();
        vision.setSupported(true);
        var images = new ImageValidationService(vision);
        new ContextValidation().validate(context);
        images.validateReferences(context);
        try (var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            var counter = new LlamaTokenCounter(http, mapper, requests, llm, TestRequests.contextProperties());
            var materials = new AuxiliaryContextService(mapper, counter, TestRequests.contextProperties(),
                    new AuxiliaryContextProperties(4, 8192, 8192, 32768, 32768, 2048, 2048));
            var real = new OpenAiClient(http, mapper, llm.baseUrl(), llm.apiKey(), Duration.ofSeconds(45), requests);
            var calls = new ArrayList<ChatRequest>();
            var usage = new ArrayList<TokenUsage>();
            LLMClient observed = new LLMClient() {
                @Override public ChatResponse chat(ChatRequest request) throws java.io.IOException, InterruptedException {
                    calls.add(request);
                    assertFalse(request.isThinkingEnabled());
                    assertNotNull(request.getResponseSchema());
                    assertEquals(requests.chatBody(request, false).path("response_format"),
                            requests.templateBody(request).path("response_format"));
                    var response = real.chat(request);
                    assertTrue(mapper.readTree(response.getContent()).isObject());
                    usage.add(response.getUsage());
                    return response;
                }
                @Override public ChatStreamResult chatStream(ChatRequest request, Consumer<String> delta)
                        throws java.io.IOException, InterruptedException {
                    return real.chatStream(request, delta);
                }
            };
            long started = System.nanoTime();
            var service = new VisualSelectionService(observed, mapper, new VisualSelectionPromptBuilder(TestRequests.dispatch(), vision), images, materials);
            var plan = service.select(context);
            assertEquals("ready", plan.status());
            Set<String> selected = new HashSet<>();
            plan.selectedHistoricalImages().forEach(image -> selected.add(image.assetId()));
            assertTrue(selected.containsAll(scenario.expectedSelected()), plan.toString());
            assertEquals(ImageValidationService.selectableCatalog(context).isEmpty() ? 0 : 1, calls.size());
            selected.addAll(ImageValidationService.requiredIds(context));
            var payloads = scenario.images().stream().filter(p -> selected.contains(p.assetId())).toList();
            var prepared = ChatDispatchService.withImages(context, plan, payloads);
            var body = new PromptBuilder(llm).build(prepared);
            assertEquals(selected.size(), body.getMessages().stream().filter(m -> m.getParts() != null)
                    .flatMap(m -> m.getParts().stream()).filter(p -> "image_url".equals(p.type())).count());
            assertTrue(body.isThinkingEnabled());
            assertNull(body.getResponseSchema());
            System.out.println(mapper.createObjectNode().put("history", history.name()).put("photo", photo.name())
                    .put("calls", calls.size()).put("elapsedMs", (System.nanoTime() - started) / 1_000_000)
                    .set("usage", mapper.valueToTree(usage)));
        }
    }
}
