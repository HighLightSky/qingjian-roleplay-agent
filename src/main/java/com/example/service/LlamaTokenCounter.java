package com.example.service;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import javax.imageio.ImageIO;

import org.springframework.stereotype.Component;
import com.example.config.ContextProperties;
import com.example.config.LlmProperties;
import com.example.llm.LlmRequestMapper;
import com.example.llm.model.ChatRequest;
import com.example.llm.model.Message;
import com.example.web.dto.ContextDtos.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** 使用实际部署的聊天模板和 tokenizer；视觉输入明确采用尺寸估算。 */
@Component
public class LlamaTokenCounter {
    private final HttpClient http;
    private final ObjectMapper mapper;
    private final LlmRequestMapper requests;
    private final LlmProperties llm;
    private final ContextProperties properties;

    public LlamaTokenCounter(HttpClient http, ObjectMapper mapper, LlmRequestMapper requests,
            LlmProperties llm, ContextProperties properties) {
        this.http = http;
        this.mapper = mapper;
        this.requests = requests;
        this.llm = llm;
        this.properties = properties;
    }

    public TokenCount count(ChatRequest request) throws IOException, InterruptedException {
        List<Message> text = new ArrayList<>();
        List<ImageMetadata> images = new ArrayList<>();
        for (Message m : request.getMessages()) {
            if (m.getParts() == null) {
                text.add(m);
            } else {
                var parts = new ArrayList<Message.Part>();
                for (Message.Part part : m.getParts()) {
                    if ("text".equals(part.type()))
                        parts.add(part);
                    else
                        images.add(dimensions(part.imageUrl()));
                }
                text.add(new Message(m.getRole(), parts));
            }
        }
        return countText(new ChatRequest(text, request.getMaxTokens(), request.getTemperature()), images);
    }

    public TokenCount countText(ChatRequest request, List<ImageMetadata> images)
            throws IOException, InterruptedException {
        ObjectNode template = requests.templateBody(request);
        JsonNode rendered = post("/apply-template", template);
        if (!rendered.path("prompt").isTextual())
            throw new IOException("模板计数接口缺少 prompt 字段");
        long count = tokenize(rendered.path("prompt").textValue());
        for (ImageMetadata image : images)
            count += estimateImageTokens(image.width(), image.height());
        String fingerprint = ImageValidationService.sha256(
                (template + "\n" + images + "\n" + properties).getBytes(StandardCharsets.UTF_8));
        return new TokenCount(count, images.isEmpty() ? "exact" : "estimated", llm.model(), fingerprint);
    }

    public long tokenize(String text) throws IOException, InterruptedException {
        ObjectNode body = mapper.createObjectNode().put("model", llm.model())
                .put("content", text).put("add_special", false).put("parse_special", true);
        JsonNode tokenized = post("/tokenize", body);
        if (!tokenized.path("tokens").isArray())
            throw new IOException("计数接口缺少 tokens 数组");
        return tokenized.path("tokens").size();
    }

    public long estimateImageTokens(int width, int height) {
        long grids = ((width + (long) properties.visionGridPixels() - 1) / properties.visionGridPixels())
                * ((height + (long) properties.visionGridPixels() - 1) / properties.visionGridPixels());
        return (long) Math.ceil(Math.max(properties.visionMinGrids(), grids) * properties.visionTokenMultiplier())
                + properties.visionTokenOverhead();
    }

    private ImageMetadata dimensions(String dataUrl) throws IOException {
        byte[] bytes = Base64.getDecoder().decode(dataUrl.substring(dataUrl.indexOf(',') + 1));
        try (var stream = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers = ImageIO.getImageReaders(stream);
            if (!readers.hasNext())
                throw new IOException("计数所需原图无法读取");
            var reader = readers.next();
            try {
                reader.setInput(stream);
                return new ImageMetadata("", reader.getWidth(0), reader.getHeight(0));
            } finally {
                reader.dispose();
            }
        }
    }

    private JsonNode post(String path, ObjectNode body) throws IOException, InterruptedException {
        URI uri = URI.create(llm.baseUrl()).resolve(path);
        var request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(llm.timeoutSeconds()))
                .header("Authorization", "Bearer " + llm.apiKey()).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body))).build();
        var response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
        try (var stream = response.body()) {
            if (response.statusCode() < 200 || response.statusCode() >= 300)
                throw new IOException("模型计数接口 " + path + " 返回 HTTP " + response.statusCode());
            int limit = Math.toIntExact(ImageValidationService.MAX_REQUEST_BYTES);
            byte[] bytes = stream.readNBytes(limit + 1);
            if (bytes.length > limit)
                throw new IOException("模型计数结果超过体积上限");
            return mapper.readTree(bytes);
        }
    }
}
