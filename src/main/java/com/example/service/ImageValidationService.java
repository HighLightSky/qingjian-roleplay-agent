package com.example.service;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.*;
import javax.imageio.ImageIO;
import com.example.config.VisionProperties;
import com.example.web.dto.*;
import com.example.web.dto.VisualDtos.*;
import org.springframework.stereotype.Service;

/** 在模型调用前校验真实原图；不信任文件扩展名、浏览器尺寸或客户端哈希声明。 */
@Service
public class ImageValidationService {
    public static final long MAX_REQUEST_BYTES = 64L * 1024 * 1024;
    private final VisionProperties properties;

    public ImageValidationService(VisionProperties properties) {
        this.properties = properties;
    }

    public VisionProperties properties() {
        return properties;
    }

    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** 本轮图片由有序内容块直接确定，不能被历史选图模型移除。 */
    public static List<String> newIds(ChatApiRequest request) {
        return request.input().content().stream().filter(p -> "image".equals(p.type()))
                .map(ContentPartDto::assetId).toList();
    }

    public static List<Asset> catalog(ChatApiRequest r) {
        return r.visual() == null ? List.of() : r.visual().assetCatalog();
    }

    /** 校验当前会话提供的目录及消息来源；同一 Blob 去重不代表跨会话共享。 */
    public void validateReferences(ChatApiRequest r) {
        Set<String> ids = new HashSet<>();
        int lastSeq = 0;
        for (Asset a : catalog(r)) {
            if (a == null || a.assetId() == null || a.assetId().isBlank() || !ids.add(a.assetId())
                    || a.sha256() == null || !a.sha256().matches("[a-f0-9]{64}")
                    || a.sources() == null || a.sources().isEmpty())
                throw new IllegalArgumentException("图片目录或来源无效");
            validateMetadata(a.mimeType(), a.byteSize(), a.width(), a.height());
            for (Source source : a.sources()) {
                if (source == null || source.messageId() == null || source.seq() < 1 || source.imageIndex() < 1
                        || source.text() == null)
                    throw new IllegalArgumentException("图片来源无效");
            }
            int firstSeq = a.sources().getFirst().seq();
            if (firstSeq < lastSeq)
                throw new IllegalArgumentException("图片目录必须按上传顺序排列");
            lastSeq = firstSeq;
            if (a.observation() != null && !a.assetId().equals(a.observation().assetId()))
                throw new IllegalArgumentException("视觉观察引用无效");
        }
        Set<String> inputIds = new HashSet<>();
        for (ContentPartDto p : r.input().content()) {
            if (p == null || !("text".equals(p.type()) || "image".equals(p.type()))
                    || ("text".equals(p.type()) && p.text() == null)
                    || ("image".equals(p.type()) && (p.assetId() == null || p.assetId().isBlank())))
                throw new IllegalArgumentException("输入内容块无效");
            if ("image".equals(p.type()) && !inputIds.add(p.assetId()))
                throw new IllegalArgumentException("本轮包含重复图片引用");
        }
        for (HistoryMessageDto h : r.history()) {
            if (h.parts() == null)
                continue;
            for (ContentPartDto p : h.parts()) {
                if (p == null || !("text".equals(p.type()) || "image".equals(p.type())))
                    throw new IllegalArgumentException("历史内容块无效");
                if ("image".equals(p.type()) && (!"user".equals(h.role()) || !ids.contains(p.assetId())
                        || catalog(r).stream().filter(a -> a.assetId().equals(p.assetId()))
                                .noneMatch(a -> a.sources().stream().anyMatch(s -> s.messageId().equals(h.id())))))
                    throw new IllegalArgumentException("历史图片来源不一致");
            }
        }
        if ((!ids.isEmpty() || !inputIds.isEmpty())
                && (r.visual() == null || r.visual().sessionId() == null || r.visual().sessionId().isBlank()))
            throw new IllegalArgumentException("图片上下文缺少会话 ID");
        if ((!ids.isEmpty() || !inputIds.isEmpty()) && !properties.isSupported())
            throw new IllegalArgumentException("当前模型未启用视觉能力，请配置 ROLEPLAY_VISION_SUPPORTED 并完成视觉联调");
    }

    private void validateMetadata(String mime, long size, int width, int height) {
        if (!Set.of("image/jpeg", "image/png").contains(mime == null ? "" : mime) || size < 1
                || size > properties.getMaxImageBytes() || width < 1 || height < 1
                || (long) width * height > properties.getMaxPixels())
            throw new IllegalArgumentException("图片格式、体积或像素超限");
    }

    public void validateLimits(Collection<String> ids) {
        if (ids.size() > properties.getMaxImages())
            throw new IllegalArgumentException("本轮图片数量超限，请减少图片");
    }

    /** 载荷必须恰好覆盖计划所需图片；先验体积和像素，再完整解码，避免静默漏图。 */
    public void validatePayloads(ChatApiRequest r, Collection<String> required) {
        List<Payload> payloads = r.visual() == null ? List.of() : r.visual().imagePayloads();
        Set<String> seen = new HashSet<>();
        long total = 0;
        for (Payload p : payloads) {
            if (p == null || !required.contains(p.assetId()) || !seen.add(p.assetId()) || p.dataUrl() == null)
                throw new IllegalArgumentException("图片载荷引用无效");
            total += p.dataUrl().length();
            if (total > MAX_REQUEST_BYTES)
                throw new IllegalArgumentException("图片请求体超限");
            int comma = p.dataUrl().indexOf(',');
            if (comma < 0)
                throw new IllegalArgumentException("图片 data URL 无效");
            String mime = switch (p.dataUrl().substring(0, comma)) {
                case "data:image/png;base64" -> "image/png";
                case "data:image/jpeg;base64" -> "image/jpeg";
                default -> throw new IllegalArgumentException("仅支持静态 JPEG、PNG");
            };
            try {
                byte[] bytes = Base64.getDecoder().decode(p.dataUrl().substring(comma + 1));
                if (!sha256(bytes).equals(p.sha256()))
                    throw new IllegalArgumentException("图片哈希不一致");
                try (var stream = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
                    var readers = ImageIO.getImageReaders(stream);
                    if (!readers.hasNext())
                        throw new IllegalArgumentException("图片无法解码");
                    var reader = readers.next();
                    try {
                        reader.setInput(stream);
                        String format = reader.getFormatName().toLowerCase(Locale.ROOT);
                        if (!(mime.equals("image/png") ? format.equals("png")
                                : format.equals("jpeg") || format.equals("jpg")))
                            throw new IllegalArgumentException("图片真实格式与声明不符");
                        int width = reader.getWidth(0), height = reader.getHeight(0);
                        validateMetadata(mime, bytes.length, width, height);
                        if (reader.read(0) == null)
                            throw new IllegalArgumentException("图片无法解码");
                        for (Asset a : catalog(r))
                            if (a.assetId().equals(p.assetId()) &&
                                    (!a.sha256().equals(p.sha256()) || a.width() != width || a.height() != height
                                            || a.byteSize() != bytes.length))
                                throw new IllegalArgumentException("原图与目录元信息不一致");
                    } finally {
                        reader.dispose();
                    }
                }
            } catch (IOException e) {
                throw new IllegalArgumentException("图片无法解码", e);
            }
        }
        if (!seen.equals(new HashSet<>(required)))
            throw new IllegalArgumentException("缺少必需原图，请重新选择或恢复本地图片");
    }
}
