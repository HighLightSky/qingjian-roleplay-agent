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
    public static final long MAX_REQUEST_BYTES = ContextLimits.REQUEST_BYTES;
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

    public static List<MissingAsset> missingAssets(ChatApiRequest r) {
        return r.visual() == null ? List.of() : r.visual().missingAssets();
    }

    public static List<ReferencedAsset> referencedAssets(ChatApiRequest r) {
        var assets = new ArrayList<ReferencedAsset>(catalog(r));
        assets.addAll(missingAssets(r));
        return assets;
    }

    /** 首次照片与本轮附件共同占用不同资产名额。 */
    public static List<String> requiredIds(ChatApiRequest request) {
        var ids = new LinkedHashSet<>(newIds(request));
        catalog(request).stream().filter(a -> a.observation() == null && a.sources().stream()
                .anyMatch(s -> s instanceof CharacterPhotoSource)).forEach(a -> ids.add(a.assetId()));
        return List.copyOf(ids);
    }

    public static List<Asset> selectableCatalog(ChatApiRequest request) {
        Set<String> required = new HashSet<>(requiredIds(request));
        return catalog(request).stream().filter(a -> !required.contains(a.assetId()))
                .filter(a -> a.observation() != null || a.sources().stream()
                .anyMatch(s -> s instanceof MessageSource || s instanceof GenerationSource g && !g.rejected())).toList();
    }

    /** 校验来源与快照一致；无状态接口不认证浏览器数据库所有权。 */
    public void validateReferences(ChatApiRequest r) {
        var referenced = referencedAssets(r);
        StateValidation.collection(referenced, "图片目录与缺失图片");
        Set<String> missingIds = new HashSet<>();
        Set<String> ids = new HashSet<>();
        int lastAvailableSeq = 0;
        int lastMissingSeq = 0;
        int photoSources = 0;
        for (ReferencedAsset a : referenced) {
            if (a == null)
                throw new IllegalArgumentException("图片目录项不能为空");
            ImageIds.requireValid(a.assetId());
            if (a instanceof MissingAsset) missingIds.add(a.assetId());
            if (!ids.add(a.assetId()) || a.sources() == null || a.sources().isEmpty())
                throw new IllegalArgumentException("图片目录或来源无效");
            StateValidation.collection(a.sources(), "图片来源");
            if (a instanceof Asset available) {
                if (available.sha256() == null || !available.sha256().matches("[a-f0-9]{64}")
                        || !available.sourceSha256().matches("[a-f0-9]{64}"))
                    throw new IllegalArgumentException("图片哈希无效");
                validateMetadata(available.mimeType(), available.byteSize(), available.width(), available.height());
            }
            int firstSeq = 0;
            boolean hasPhoto = false;
            Set<Source> unique = new HashSet<>();
            for (Source source : a.sources()) {
                if (source == null || !unique.add(source))
                    throw new IllegalArgumentException("图片来源缺失或重复");
                if (source instanceof MessageSource m) {
                    StateValidation.id(m.messageId());
                    if (m.seq() < 1 || m.imageIndex() < 1 || m.uploadIndex() < 1)
                        throw new IllegalArgumentException("图片消息来源无效");
                    StateValidation.text(m.text());
                    if (firstSeq == 0) firstSeq = m.seq();
                } else if (source instanceof GenerationSource generated) {
                    StateValidation.id(generated.generationId());
                    StateValidation.id(generated.planId());
                    StateValidation.id(generated.messageId());
                    StateValidation.nonblank(generated.summary());
                    if (generated.seq() < 1 || generated.rejected()) throw new IllegalArgumentException("生成图片来源无效或已排除");
                    for (var message : r.history()) {
                        if ((message.id().equals(generated.messageId()) || message.seq() == generated.seq())
                                && (!message.id().equals(generated.messageId()) || message.seq() != generated.seq()
                                    || !"assistant".equals(message.role()))) throw new IllegalArgumentException("生成图片来源与历史不一致");
                    }
                } else if (source instanceof CharacterPhotoSource photo) {
                    photoSources++;
                    hasPhoto = true;
                    if (!a.assetId().equals(r.character().appearancePhotoAssetId())
                            || !r.state().characterId().equals(photo.characterId())
                            || r.character().profileVersion() != photo.profileVersion())
                        throw new IllegalArgumentException("角色照片与会话快照不一致");
                }
            }
            // 照片目录可提前出现；聊天上传的相对顺序仍保持不变。
            if (!hasPhoto && firstSeq > 0) {
                boolean missing = a instanceof MissingAsset;
                if (firstSeq < (missing ? lastMissingSeq : lastAvailableSeq))
                    throw new IllegalArgumentException("图片目录必须按上传顺序排列");
                if (missing) lastMissingSeq = firstSeq;
                else lastAvailableSeq = firstSeq;
            }
            if (a.observation() != null) {
                Observation o = a.observation();
                StateValidation.visualContent(o);
                if (!a.assetId().equals(o.assetId()) || o.version() < 1
                        || o.sources().isEmpty() || !a.sources().containsAll(o.sources())
                        || hasPhoto && o.sources().stream().noneMatch(s -> s instanceof CharacterPhotoSource))
                    throw new IllegalArgumentException("视觉观察引用或来源无效");
            }
        }
        if (photoSources != (r.character().appearancePhotoAssetId() == null ? 0 : 1))
            throw new IllegalArgumentException("角色快照照片必须恰好有一个目录来源");
        Set<String> inputIds = new HashSet<>();
        for (ContentPartDto p : r.input().content()) {
            if (p == null || !("text".equals(p.type()) || "image".equals(p.type()))
                    || ("text".equals(p.type()) && p.text() == null))
                throw new IllegalArgumentException("输入内容块无效");
            if ("image".equals(p.type())) ImageIds.requireValid(p.assetId());
            if ("image".equals(p.type()) && missingIds.contains(p.assetId()))
                throw new IllegalArgumentException("本轮新附件不能声明为原件缺失：" + p.assetId());
            if ("image".equals(p.type()) && !inputIds.add(p.assetId()))
                throw new IllegalArgumentException("本轮包含重复图片引用");
        }
        for (HistoryMessageDto h : r.history()) {
            for (ContentPartDto p : h.parts()) {
                if (p == null || !("text".equals(p.type()) || "image".equals(p.type())))
                    throw new IllegalArgumentException("历史内容块无效");
                if ("image".equals(p.type()) && (!"user".equals(h.role()) || !ids.contains(p.assetId())
                        || referenced.stream().filter(a -> a.assetId().equals(p.assetId()))
                                .noneMatch(a -> a.sources().stream().anyMatch(s -> s instanceof MessageSource m && m.messageId().equals(h.id())))))
                    throw new IllegalArgumentException("历史图片来源不一致");
            }
        }
        for (ReferencedAsset a : referenced) {
            for (Source source : a.sources()) {
                if (source instanceof MessageSource m) {
                    for (HistoryMessageDto h : r.history()) {
                        if ((h.id().equals(m.messageId()) || h.seq() == m.seq())
                                && (!h.id().equals(m.messageId()) || h.seq() != m.seq() || !"user".equals(h.role())
                                || h.parts().stream().filter(p -> "image".equals(p.type()))
                                    .skip(m.imageIndex() - 1L).findFirst()
                                    .filter(p -> a.assetId().equals(p.assetId())).isEmpty()))
                            throw new IllegalArgumentException("图片消息位置与历史不一致");
                    }
                }
            }
        }
        if ((!ids.isEmpty() || !inputIds.isEmpty())
                && (r.visual() == null || r.visual().sessionId() == null || r.visual().sessionId().isBlank()))
            throw new IllegalArgumentException("图片上下文缺少会话 ID");
        if ((!catalog(r).isEmpty() || !inputIds.isEmpty()) && !properties.isSupported())
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

}
