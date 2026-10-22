package com.example.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.*;
import com.sun.net.httpserver.HttpServer;
import com.example.TestRequests;
import com.example.config.*;
import com.example.llm.*;
import com.example.llm.model.*;
import com.example.prompt.*;
import com.example.web.dto.*;
import com.example.web.dto.ContextDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;

/** 用真实 HTTP 模板/计数接口检验预算和分批摘要，不访问外部模型。 */
class ContextFlowTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final ContextProperties properties = new ContextProperties(10000, .7, .5, 10, 100,
            4000, 1000, 500, 8, 32, 9, 1.1, 64);
    private final LLMClient model = mock(LLMClient.class);
    private HttpServer server;
    private HttpClient http;
    private LlamaTokenCounter counter;
    private ContextBudgetService budgets;
    private ContextCompactionService compaction;
    private String lastTemplate;

    @BeforeEach void setup() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/apply-template", exchange -> {
            var body = mapper.readTree(exchange.getRequestBody());
            lastTemplate = body.toString();
            StringBuilder prompt = new StringBuilder();
            for (var message : body.path("messages")) {
                prompt.append('<').append(message.path("role").asText()).append('>');
                var content = message.path("content");
                if (content.isArray()) content.forEach(p -> prompt.append(p.path("text").asText()));
                else prompt.append(content.asText());
            }
            prompt.append("<assistant>");
            byte[] bytes = mapper.writeValueAsBytes(Map.of("prompt", prompt.toString()));
            exchange.sendResponseHeaders(200, bytes.length);
            try (var out = exchange.getResponseBody()) { out.write(bytes); }
        });
        server.createContext("/tokenize", exchange -> {
            var body = mapper.readTree(exchange.getRequestBody());
            String content = body.path("content").asText();
            byte[] bytes = mapper.writeValueAsBytes(Map.of("tokens", Collections.nCopies(content.codePointCount(0, content.length()), 1)));
            exchange.sendResponseHeaders(200, bytes.length);
            try (var out = exchange.getResponseBody()) { out.write(bytes); }
        });
        server.start();
        http = HttpClient.newHttpClient();
        var llm = new LlmProperties("http://127.0.0.1:" + server.getAddress().getPort() + "/v1/chat/completions",
                "test", "test-model", .8, 1000, 5);
        var requests = new LlmRequestMapper(mapper, llm);
        counter = new LlamaTokenCounter(http, mapper, requests, llm, properties);
        var prompts = new PromptBuilder(llm);
        var vision = new VisionProperties();
        vision.setSupported(true);
        var images = new ImageValidationService(vision);
        var validation = new ContextValidation();
        budgets = new ContextBudgetService(counter, prompts, properties, vision, validation, images, mapper);
        compaction = new ContextCompactionService(properties, validation, images, budgets, counter,
                new CompactionPromptBuilder(mapper, properties), prompts, model, mapper, new ImageCache(com.example.TestRequests.dispatch(), vision, java.time.Clock.systemUTC()));
    }

    @AfterEach void close() { http.close(); server.stop(0); }

    @Test void countsChineseEmojiAndTypedHistoryWithTheDeploymentTemplate() throws Exception {
        var request = new ChatRequest(List.of(new Message("system", "角色设定"), new Message("user", "你好🌱"),
                new Message("assistant", "[台词]你好"), new Message("user", "看这段代码：x=1")), 1000, .8);
        var count = counter.count(request);
        String rendered = "<system>角色设定<user>你好🌱<assistant>[台词]你好<user>看这段代码：x=1<assistant>";
        assertEquals(rendered.codePointCount(0, rendered.length()), count.inputTokens());
        assertEquals("exact", count.accuracy());
        assertTrue(lastTemplate.contains("add_generation_prompt"));
        assertNotEquals(count.requestFingerprint(), counter.count(new ChatRequest(List.of(new Message("user", "变更")), 1000, .8)).requestFingerprint());
    }

    @Test void imageBytesNeverEnterTextTokenizerAndTheEstimateUsesDecodedDimensions() throws Exception {
        var bytes = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(1024, 512, BufferedImage.TYPE_INT_RGB), "png", bytes);
        String uri = "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes.toByteArray());
        var request = new ChatRequest(List.of(new Message("user", List.of(Message.Part.text("地图"), Message.Part.image(uri)))), 1000, .8);
        var count = counter.count(request);
        assertEquals("estimated", count.accuracy());
        assertEquals("<user>地图<assistant>".length() + (long) Math.ceil(512 * 1.1) + 64, count.inputTokens());
        assertFalse(lastTemplate.contains("base64"));
        assertFalse(lastTemplate.contains("image_url"));
    }

    @Test void thresholdAndHardCapacityUseTheConfiguredFullWindow() {
        assertFalse(budgets.evaluate(count(6999), 1000, 0).needsCompaction());
        assertTrue(budgets.evaluate(count(7000), 1000, 0).needsCompaction());
        assertTrue(budgets.evaluate(count(8900), 1000, 0).fits());
        assertFalse(budgets.evaluate(count(8901), 1000, 0).fits());
        assertThrows(ContextTooLargeException.class, () -> budgets.requireSendable(budgets.evaluate(count(8901), 1000, 0)));
        assertTrue(budgets.evaluate(count(6900), 3101, 0).needsCompaction());
    }

    @Test void fortyRoundsAreCompactedInBoundedBatchesAndTheLastTenStayVerbatim() throws Exception {
        var original = context(40, "历史剧情与约定。".repeat(12));
        when(model.chat(any())).thenReturn(new ChatResponse("{\"summary\":\"旅人在山城探访废塔，约定保留地图线索，尚未找到钥匙。\"}", "stop", TokenUsage.unavailable()));
        var current = original;
        int calls = 0;
        while (budgets.compactThroughSeq(current) > current.summary().throughSeq()) {
            var result = compaction.compact(new CompactionRequest("compact-" + calls++, current));
            assertTrue(result.afterTokens() < result.beforeTokens());
            assertTrue(result.throughSeq() <= 60);
            assertEquals(current.summary().throughSeq(), result.fromExclusiveSeq());
            current = new ChatApiRequest(current.character(), current.state(), result.summary(),
                    current.history().stream().filter(m -> m.seq() > result.throughSeq()).toList(), current.input(),
                    current.interactionSettings(), current.visual(), current.operationId());
        }
        assertTrue(calls > 1);
        assertEquals(60, current.summary().throughSeq());
        assertEquals(original.history().subList(60, 80), current.history());
        var assembled = new PromptBuilder(new LlmProperties("", "", "test", .8, 1000, 5)).build(current);
        assertTrue(assembled.getMessages().getFirst().getContent().contains(current.summary().text()));
        assertEquals(22, assembled.getMessages().size());
        verify(model, times(calls)).chat(argThat(call -> {
            try { return counter.count(call).inputTokens() <= properties.compactionBatchInputTokens(); }
            catch (Exception e) { throw new AssertionError(e); }
        }));
    }

    @Test void invalidSummaryNoReductionAndProtectedRoundsNeverAdvanceTheCursor() throws Exception {
        var request = new CompactionRequest("compact", context(11, "甲"));
        when(model.chat(any())).thenReturn(new ChatResponse(mapper.writeValueAsString(Map.of("summary", "乙".repeat(300))), "stop", TokenUsage.unavailable()));
        assertTrue(assertThrows(IOException.class, () -> compaction.compact(request)).getMessage().contains("减少"));
        when(model.chat(any())).thenReturn(new ChatResponse("{}", "stop", TokenUsage.unavailable()));
        assertThrows(IOException.class, () -> compaction.compact(request));
        assertThrows(ContextTooLargeException.class, () -> compaction.compact(new CompactionRequest("protected", context(10, "甲"))));
        assertEquals(0, request.context().summary().throughSeq());
    }

    @Test void previewAcceptsAnEmptyDraftAndRejectsInvalidHistoryAtTheBoundary() throws Exception {
        var context = context(0, "");
        var empty = new ChatApiRequest(context.character(), context.state(), context.summary(), List.of(), new InputDto("", null),
                context.interactionSettings(), null, "preview");
        assertEquals("exact", budgets.inspect(new BudgetRequest(empty, "preview", List.of())).accuracy());
        assertThrows(IllegalArgumentException.class, () -> budgets.inspect(new BudgetRequest(empty, "invalid", List.of())));
        var invalid = new ChatApiRequest(context.character(), context.state(), context.summary(),
                List.of(new HistoryMessageDto("user", "过期序号", "source", null, 0, "complete", 0)), context.input(), context.interactionSettings(), null, "preview");
        assertThrows(IllegalArgumentException.class, () -> budgets.inspect(new BudgetRequest(invalid, "preview", List.of())));
    }

    @Test void summaryRequiresWholeImageIdsAndAcceptsChineseAndPunctuationBoundaries() throws Exception {
        var base = context(11, "历史剧情与图片线索。".repeat(10));
        var first = base.history().getFirst();
        var source = new VisualDtos.MessageSource(first.id(), first.seq(), first.text(), 1, 1);
        var observation = new VisualDtos.Observation("img1", "地图红点", List.of(), List.of(), List.of(), List.of(source), 1);
        var asset = new VisualDtos.Asset("img1", "0".repeat(64), "image/png", 100, 1, 1, List.of(source), observation, List.of());
        var history = new ArrayList<>(base.history());
        history.set(0, new HistoryMessageDto(first.role(), first.text(), first.id(),
                List.of(ContentPartDto.text(first.text()), new ContentPartDto("image", null, "img1")),
                first.seq(), first.status(), first.checkpointVersion()));
        var context = new ChatApiRequest(base.character(), base.state(), base.summary(), history, base.input(),
                base.interactionSettings(), new VisualDtos.Context("session", List.of(asset), null, List.of()), base.operationId());
        var request = new CompactionRequest("compact", context);
        for (String summary : List.of("参考 img10", "参考 img100", "参考 ximg1", "参考 img1x", "参考 img01")) {
            when(model.chat(any())).thenReturn(new ChatResponse(mapper.writeValueAsString(Map.of("summary", summary)), "stop", TokenUsage.unavailable()));
            assertTrue(assertThrows(IOException.class, () -> compaction.compact(request)).getMessage().contains("遗漏图片来源引用：img1"));
        }
        for (String summary : List.of("图片img1中有红点。", "参考（img1），线索尚未解决。", "img1、img10、img100 是不同图片。")) {
            when(model.chat(any())).thenReturn(new ChatResponse(mapper.writeValueAsString(Map.of("summary", summary)), "stop", TokenUsage.unavailable()));
            assertEquals(summary, compaction.compact(request).summary().text());
        }
    }

    private TokenCount count(long count) { return new TokenCount(count, "exact", "test", "fingerprint"); }
    private ChatApiRequest context(int turns, String text) {
        List<HistoryMessageDto> history = new ArrayList<>();
        for (int i = 1; i <= turns * 2; i++) history.add(new HistoryMessageDto(i % 2 == 1 ? "user" : "assistant", text,
                "message-" + i, null, i, "complete", 0));
        return new ChatApiRequest(new CharacterDto("林溪", "旧友", "旅馆老板", null, 1), TestRequests.state(List.of()), TestRequests.summary(),
                history, new InputDto("继续", null), new InteractionSettingsDto(InteractionSettingsDto.ReplyLength.STANDARD,
                        InteractionSettingsDto.NarrativeMode.SCENE), null, "operation");
    }
}
