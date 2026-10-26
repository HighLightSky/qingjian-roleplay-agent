package com.example.llm;

import static org.junit.jupiter.api.Assertions.*;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.List;
import java.util.Objects;

import com.example.config.LlmProperties;
import com.example.llm.model.ChatRequest;
import com.example.llm.model.Message;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.config.YamlPropertiesFactoryBean;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.core.env.PropertiesPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.ClassPathResource;

/** 显式启用后验证实际模型的思考预算与正文分离，不保存生成内容。 */
@EnabledIfSystemProperty(named = "roleplay.live-llm", matches = "true")
@Timeout(180)
class BodyReasoningLiveTest {
    @ParameterizedTest
    @ValueSource(ints = {16, 2048})
    void reasoningBudgetStillAllowsACompleteAnswer(int budget) throws Exception {
        var yaml = new YamlPropertiesFactoryBean();
        yaml.setResources(new ClassPathResource("application.yml"));
        var environment = new StandardEnvironment();
        environment.getPropertySources().addLast(new PropertiesPropertySource("application",
                Objects.requireNonNull(yaml.getObject())));
        var config = Binder.get(environment).bind("roleplay.llm", Bindable.of(LlmProperties.class)).get();
        var mapper = new ObjectMapper();
        var request = new ChatRequest(List.of(new Message("user",
                "计算1234567乘7654321，先逐位核对进位，最后以[台词]开头仅输出乘积。")),
                config.generationMaxTokens(), 0.0, true);
        request.setReasoningBudgetTokens(budget);
        var reasoning = new StringBuilder();
        var content = new StringBuilder();
        try (var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            var client = new OpenAiClient(http, mapper, config.baseUrl(), config.apiKey(),
                    Duration.ofSeconds(config.timeoutSeconds()), Duration.ofSeconds(config.firstTokenTimeoutSeconds()),
                    new LlmRequestMapper(mapper, config));
            var result = client.chatStream(request, delta -> {
                reasoning.append(delta.reasoningContent());
                content.append(delta.content());
            });
            assertEquals("stop", result.finishReason());
            assertFalse(reasoning.toString().isBlank(), "真实模型未返回思考内容");
            assertFalse(content.toString().isBlank(), "思考预算结束后未返回正文");
            System.out.printf("正文思考实测：预算=%d，思考字符=%d，正文字符=%d，结束原因=%s%n",
                    budget, reasoning.length(), content.length(), result.finishReason());
        }
    }
}
