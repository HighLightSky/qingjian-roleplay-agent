package com.example.image;

import java.io.*;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpTimeoutException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.*;
import org.springframework.http.converter.FormHttpMessageConverter;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import com.example.config.ImageGenerationProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.DeserializationFeature;

/** 长连接只由生成请求持有，取消在另一个 HTTP 请求中执行。 */
@Component
public class QwenImageClient {
    public record Image(String assetId, String mimeType, int width, int height, byte[] bytes) {
    }

    public static class ServiceError extends IOException {
        private final int status;
        private final String code;
        public ServiceError(int status, String code, String message) {
            super(message);
            this.status = status;
            this.code = code;
        }
        public int status() {
            return status;
        }
        public String code() {
            return code;
        }
    }

    private final HttpClient client;
    private final ObjectMapper mapper;
    private final ImageGenerationProperties config;

    public QwenImageClient(HttpClient client, ObjectMapper mapper, ImageGenerationProperties config) {
        this.client = client;
        this.mapper = mapper;
        this.config = config;
    }

    public byte[] edit(String taskId, String prompt, List<Image> images, JsonNode pose)
            throws IOException, InterruptedException {
        ready();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(config.timeoutSeconds());
        var parts = new LinkedMultiValueMap<String, Object>();
        parts.add("prompt", prompt);
        if (pose != null)
            parts.add("pose", mapper.writeValueAsString(pose));
        for (int i = 0; i < images.size(); i++) {
            var image = images.get(i);
            final String filename = "image" + (i + 1) + (image.mimeType().equals("image/png") ? ".png" : ".jpg");
            var resource = new ByteArrayResource(image.bytes()) {
                @Override
                public String getFilename() {
                    return filename;
                }
            };
            var headers = new HttpHeaders();
            headers.setContentType(MediaType.parseMediaType(image.mimeType()));
            parts.add("images", new HttpEntity<>(resource, headers));
        }
        var body = new ByteArrayOutputStream();
        var headers = new HttpHeaders();
        new FormHttpMessageConverter().write(parts, MediaType.MULTIPART_FORM_DATA, new HttpOutputMessage() {
            public OutputStream getBody() {
                return body;
            }
            public HttpHeaders getHeaders() {
                return headers;
            }
        });
        if (body.size() > config.maxRequestBytes())
            throw new IllegalArgumentException("生图 multipart 请求体超限");
        var request = request("/api/image/edit", config.timeoutSeconds()).header("X-Task-ID", taskId)
                .header("Content-Type", headers.getContentType().toString())
                .POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray())).build();
        var response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
        try (var stream = response.body()) {
            if (response.statusCode() != 200)
                throw readError(response.statusCode(), response.headers(), stream, deadline);
            if (!response.headers().firstValue("Content-Type").orElse("").split(";")[0].equalsIgnoreCase("image/png"))
                throw new ServiceError(502, "INVALID_OUTPUT", "生图服务未返回 PNG");
            byte[] bytes = readLimited(stream, Math.toIntExact(config.maxOutputBytes()), deadline);
            if (bytes.length > config.maxOutputBytes())
                throw new ServiceError(502, "INVALID_OUTPUT", "生成图片体积超限");
            return bytes;
        }
    }

    public void ready() throws IOException, InterruptedException {
        json(request("/ready", config.readyTimeoutSeconds()).GET().build(), config.readyTimeoutSeconds(), 65536);
    }

    public JsonNode searchPoses(String query, String library) throws IOException, InterruptedException {
        ready();
        var body = mapper.writeValueAsBytes(Map.of("query", query, "top_k", config.poseSearchTopK(), "library", library));
        return json(request("/api/pose/search", config.poseSearchTimeoutSeconds())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(body)).build(), config.poseSearchTimeoutSeconds(),
                config.poseSearchMaxResponseBytes());
    }

    private JsonNode json(HttpRequest request, int seconds, int maxBytes) throws IOException, InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        var response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
        try (var stream = response.body()) {
            if (response.statusCode() != 200)
                throw readError(response.statusCode(), response.headers(), stream, deadline);
            if (!response.headers().firstValue("Content-Type").orElse("").split(";")[0]
                    .equalsIgnoreCase("application/json"))
                throw new ServiceError(502, "IMAGE_SERVICE_PROTOCOL", "图像服务未返回 JSON");
            var result = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .readTree(readLimited(stream, maxBytes, deadline));
            if (result == null || !result.isObject())
                throw new ServiceError(502, "IMAGE_SERVICE_PROTOCOL", "图像服务返回的 JSON 不是对象");
            return result;
        }
    }

    public void cancel(String taskId) throws IOException, InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(config.cancelTimeoutSeconds());
        var response = client.send(request("/api/image/edit/" + taskId + "/cancel", config.cancelTimeoutSeconds())
                .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofInputStream());
        try (var body = response.body()) {
            if (response.statusCode() != 202)
                throw readError(response.statusCode(), response.headers(), body, deadline);
            var result = mapper.readTree(readLimited(body, 65536, deadline));
            if (result == null || !taskId.equals(result.path("task_id").asText())
                    || !"cancelling".equals(result.path("status").asText()))
                throw new ServiceError(502, "INVALID_CANCEL_RESPONSE", "取消响应与任务不一致");
        }
    }

    private HttpRequest.Builder request(String path, int seconds) {
        return HttpRequest.newBuilder(URI.create(config.baseUrl().replaceAll("/$", "") + path))
                .version(HttpClient.Version.HTTP_1_1).timeout(Duration.ofSeconds(seconds))
                .header("Authorization", "Bearer " + config.apiToken());
    }

    private ServiceError readError(int status, java.net.http.HttpHeaders headers, InputStream body, long deadline)
            throws IOException, InterruptedException {
        byte[] bytes = readLimited(body, 65536, deadline);
        if (headers.firstValue("Content-Type").orElse("").startsWith("application/json")) {
            var node = mapper.readTree(bytes);
            if (node != null && node.path("error").path("code").isTextual()) {
                String message = node.path("error").path("message").asText("生图服务返回错误");
                if (node.path("request_id").isTextual())
                    message += "（服务请求 ID：" + node.path("request_id").asText() + "）";
                return new ServiceError(status, node.path("error").path("code").asText(), message);
            }
        }
        return new ServiceError(status, "HTTP_" + status, "生图服务返回 HTTP " + status);
    }
    private byte[] readLimited(InputStream input, int limit, long deadline) throws IOException, InterruptedException {
        var reading = new FutureTask<byte[]>(() -> input.readNBytes(limit + 1));
        Thread.startVirtualThread(reading);
        try {
            byte[] bytes = reading.get(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
            if (bytes.length > limit)
                throw new IOException("生图响应体超过资源限制");
            return bytes;
        } catch (TimeoutException e) {
            // 仅请求截止时间关闭连接；用户停止必须通过独立 cancel 连接。
            input.close();
            reading.cancel(true);
            throw new HttpTimeoutException("生图服务响应超时，结果未知");
        } catch (ExecutionException e) {
            if (e.getCause() instanceof IOException io)
                throw io;
            throw new IOException("读取生图响应失败", e.getCause());
        }
    }

}
