package com.example.service;

import java.io.IOException;
import java.util.*;
import com.example.llm.LLMClient;
import com.example.prompt.VisualUpdatePromptBuilder;
import com.example.web.dto.VisualDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

/** 对实际送入模型的原图建立视觉观察；正文创作不能回填为图像事实。 */
@Service
public class VisualUpdateService {
    private final LLMClient client;
    private final ObjectMapper mapper;
    private final VisualUpdatePromptBuilder prompts;
    private final ChatService chat;

    public VisualUpdateService(LLMClient client, ObjectMapper mapper, VisualUpdatePromptBuilder prompts,
            ChatService chat) {
        this.client = client;
        this.mapper = mapper;
        this.prompts = prompts;
        this.chat = chat;
    }

    /** 复用正文上下文校验，独立调用视觉模型；失败不撤销已经完成的正文。 */
    public UpdateResponse update(UpdateRequest r) throws IOException, InterruptedException {
        if (r.context() == null || r.context().visual() == null
                || r.context().visual().imagePayloads().isEmpty()
                || r.userMessageId() == null || r.assistantMessageId() == null || r.assistantText() == null)
            throw new IllegalArgumentException("视觉整理请求不完整");
        chat.validateRequest(r.context());
        var response = client.chat(prompts.build(r));
        if (!"stop".equals(response.getFinishReason()))
            throw new IOException("视觉整理输出未完成");
        UpdateResponse result = mapper.readValue(response.getContent(), UpdateResponse.class);
        return validateObservations(result, r);
    }

    /** 来源和版本由业务层生成，不接受模型虚构消息 ID 或自行提高版本。 */
    public UpdateResponse validateObservations(UpdateResponse result, UpdateRequest r) throws IOException {
        Set<String> expected = new HashSet<>();
        r.context().visual().imagePayloads().forEach(p -> expected.add(p.assetId()));
        Set<String> seen = new HashSet<>();
        if (result == null || result.observations() == null)
            throw new IOException("视觉观察缺失");
        List<Observation> observations = new ArrayList<>();
        for (Observation o : result.observations()) {
            if (o == null || !expected.contains(o.assetId()) || !seen.add(o.assetId()) || o.summary() == null
                    || o.summary().isBlank() || o.summary().length() > 600 || !validList(o.visibleDetails())
                    || !validList(o.extractedText()) || !validList(o.uncertainDetails()))
                throw new IOException("视觉观察格式或来源无效");
            Asset previous = r.context().visual().assetCatalog().stream().filter(a -> a.assetId().equals(o.assetId()))
                    .findFirst().orElse(null);
            LinkedHashSet<String> sources = new LinkedHashSet<>();
            if (previous != null)
                previous.sources().forEach(s -> sources.add(s.messageId()));
            sources.add(r.userMessageId());
            int version = previous == null || previous.observation() == null ? 1 : previous.observation().version() + 1;
            observations.add(new Observation(o.assetId(), o.summary(), o.visibleDetails(), o.extractedText(),
                    o.uncertainDetails(), List.copyOf(sources), version));
        }
        if (!seen.equals(expected))
            throw new IOException("视觉观察未覆盖实际图片");
        return new UpdateResponse(observations);
    }

    private static boolean validList(List<String> values) {
        return values != null && values.size() <= 20 && values.stream().allMatch(v -> v != null && v.length() <= 300);
    }
}
