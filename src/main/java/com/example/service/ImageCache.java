package com.example.service;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.time.Clock;
import java.util.*;
import javax.imageio.ImageIO;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import com.example.config.DispatchProperties;
import com.example.config.VisionProperties;
import com.example.web.dto.DispatchDtos.ImageRef;
import com.example.web.dto.VisualDtos.Payload;

/** 缓存只保存经验证的原图，绝对期限不会因读取续期。 */
@Service
public class ImageCache {
    private final DispatchProperties config;
    private final VisionProperties vision;
    private final Clock clock;
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private long size;

    private static final class Entry {
        final byte[] bytes;
        final String mime;
        final int width, height;
        final long created;
        long accessed;
        int pins;

        Entry(byte[] bytes, String mime, int width, int height, long now) {
            this.bytes = bytes;
            this.mime = mime;
            this.width = width;
            this.height = height;
            created = now;
            accessed = now;
        }
    }

    public ImageCache(DispatchProperties config, VisionProperties vision, Clock clock) {
        this.config = config;
        this.vision = vision;
        this.clock = clock;
    }

    private boolean expired(Entry entry) {
        long now = clock.millis();
        return now - entry.created >= config.imageLifetimeSeconds() * 1000L
                || now - entry.accessed >= config.imageIdleSeconds() * 1000L;
    }

    public synchronized List<String> missing(List<String> hashes) {
        List<String> requested = validatedHashes(hashes);
        cleanup();
        return requested.stream().filter(h -> {
            Entry entry = entries.get(h);
            return entry == null || expired(entry);
        }).toList();
    }

    public record CacheStats(int imageCount, long bytes, int inUseImageCount, long inUseBytes) {
    }

    public record ClearResult(int releasedImageCount, long releasedBytes) {
    }

    public synchronized CacheStats stats(List<String> hashes) {
        List<String> requested = validatedHashes(hashes);
        cleanup();
        int count = 0, inUseCount = 0;
        long bytes = 0, inUseBytes = 0;
        for (String key : requested) {
            Entry entry = entries.get(key);
            if (entry == null)
                continue;
            count++;
            bytes += entry.bytes.length;
            if (entry.pins > 0) {
                inUseCount++;
                inUseBytes += entry.bytes.length;
            }
        }
        return new CacheStats(count, bytes, inUseCount, inUseBytes);
    }

    public synchronized ClearResult clear(List<String> hashes) {
        List<String> requested = validatedHashes(hashes);
        for (String key : requested) {
            Entry entry = entries.get(key);
            if (entry != null && entry.pins > 0)
                throw new DispatchException(HttpStatus.CONFLICT, "IMAGE_IN_USE", "图片正在被任务使用，请在任务完成后重试");
        }
        int count = 0;
        long bytes = 0;
        for (String key : requested) {
            Entry entry = entries.get(key);
            if (entry == null)
                continue;
            count++;
            bytes += entry.bytes.length;
            remove(key);
        }
        return new ClearResult(count, bytes);
    }

    private static List<String> validatedHashes(List<String> hashes) {
        StateValidation.collection(hashes, "图片哈希");
        hashes.forEach(ImageCache::hash);
        return hashes.stream().distinct().toList();
    }

    public void put(String sha256, byte[] bytes) {
        putValidated(sha256, bytes, vision.getMaxImageBytes(), vision.getMaxPixels());
    }

    public void putGenerationInput(String sha256, byte[] bytes, long maxBytes, long maxPixels) {
        putValidated(sha256, bytes, maxBytes, maxPixels);
    }

    private void putValidated(String sha256, byte[] bytes, long maxBytes, long maxPixels) {
        hash(sha256);
        if (bytes.length == 0 || bytes.length > maxBytes)
            throw new IllegalArgumentException("图片体积超限：实际 " + bytes.length + " 字节，上限 " + maxBytes);
        if (!ImageValidationService.sha256(bytes).equals(sha256))
            throw new IllegalArgumentException("图片哈希与上传内容不一致");
        String mime;
        int width, height;
        try (var stream = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers = ImageIO.getImageReaders(stream);
            if (!readers.hasNext())
                throw new IllegalArgumentException("图片无法解码");
            var reader = readers.next();
            try {
                reader.setInput(stream);
                mime = switch (reader.getFormatName().toLowerCase(Locale.ROOT)) {
                    case "png" -> "image/png";
                    case "jpeg", "jpg" -> "image/jpeg";
                    default -> throw new IllegalArgumentException("仅支持静态 JPEG、PNG 图片");
                };
                width = reader.getWidth(0);
                height = reader.getHeight(0);
                if (width < 1 || height < 1 || (long) width * height > maxPixels)
                    throw new IllegalArgumentException("图片像素超过部署限制");
                if (reader.getNumImages(true) != 1 || reader.read(0) == null)
                    throw new IllegalArgumentException("仅支持可解码的静态图片");
            } finally {
                reader.dispose();
            }
        } catch (IOException e) {
            throw new IllegalArgumentException("图片无法解码", e);
        }
        synchronized (this) {
            cleanup();
            Entry existing = entries.get(sha256);
            if (existing != null) {
                if (expired(existing))
                    throw new DispatchException(HttpStatus.CONFLICT, "IMAGE_IN_USE", "过期原图仍被任务使用，请稍后上传");
                existing.accessed = clock.millis();
                return;
            }
            while (size + bytes.length > config.imageCacheBytes()) {
                var oldest = entries.entrySet().stream().filter(e -> e.getValue().pins == 0)
                        .min(Comparator.comparingLong(e -> e.getValue().accessed));
                if (oldest.isEmpty())
                    throw new DispatchException(HttpStatus.INSUFFICIENT_STORAGE, "IMAGE_CACHE_FULL",
                            "原图缓存容量不足，请减少候选图片或等待当前任务完成");
                remove(oldest.get().getKey());
            }
            entries.put(sha256, new Entry(bytes, mime, width, height, clock.millis()));
            size += bytes.length;
        }
    }

    public synchronized Lease pin(List<ImageRef> refs) {
        StateValidation.collection(refs, "图片引用");
        Set<String> ids = new HashSet<>();
        for (ImageRef ref : refs) {
            ImageIds.requireValid(ref.assetId());
            hash(ref.sha256());
            if (!ids.add(ref.assetId()))
                throw new IllegalArgumentException("原图编号重复：" + ref.assetId());
        }
        var absent = missing(refs.stream().map(ImageRef::sha256).toList());
        if (!absent.isEmpty())
            throw new DispatchException(HttpStatus.CONFLICT, "IMAGE_CACHE_MISS", "原图缓存缺失：" + String.join(",", absent));
        Map<String, Entry> pinned = new LinkedHashMap<>();
        for (ImageRef ref : refs) {
            Entry entry = entries.get(ref.sha256());
            entry.pins++;
            entry.accessed = clock.millis();
            pinned.put(ref.assetId(), entry);
        }
        return new Lease(refs, pinned);
    }

    public final class Lease implements AutoCloseable {
        private final List<ImageRef> refs;
        private final Map<String, Entry> pinned;
        private boolean closed;

        private Lease(List<ImageRef> refs, Map<String, Entry> pinned) {
            this.refs = refs;
            this.pinned = pinned;
        }

        public List<com.example.image.QwenImageClient.Image> binaryImages(Collection<String> ids) {
            return ids.stream().map(id -> {
                Entry entry = Objects.requireNonNull(pinned.get(id), "缓存引用缺少图片：" + id);
                return new com.example.image.QwenImageClient.Image(id, entry.mime, entry.width, entry.height, entry.bytes);
            }).toList();
        }

        public List<Payload> payloads(Collection<String> ids) {
            return ids.stream().map(id -> {
                Entry entry = Objects.requireNonNull(pinned.get(id), "缓存引用缺少原图：" + id);
                String sha = refs.stream().filter(r -> r.assetId().equals(id)).findFirst().orElseThrow().sha256();
                return new Payload(id, sha,
                        "data:" + entry.mime + ";base64," + Base64.getEncoder().encodeToString(entry.bytes));
            }).toList();
        }

        public void validateCatalog(com.example.web.dto.ChatApiRequest request) {
            for (var asset : ImageValidationService.catalog(request)) {
                Entry entry = Objects.requireNonNull(pinned.get(asset.assetId()), "目录缺少缓存引用：" + asset.assetId());
                String sha = refs.stream().filter(r -> r.assetId().equals(asset.assetId())).findFirst().orElseThrow()
                        .sha256();
                if (!sha.equals(asset.sha256()) || !entry.mime.equals(asset.mimeType()) || entry.width != asset.width()
                        || entry.height != asset.height() || entry.bytes.length != asset.byteSize())
                    throw new IllegalArgumentException("原图与目录元信息不一致：" + asset.assetId());
            }
        }

        @Override
        public void close() {
            synchronized (ImageCache.this) {
                if (closed)
                    return;
                closed = true;
                pinned.values().forEach(e -> e.pins--);
                pinned.clear();
                cleanup();
            }
        }
    }

    public synchronized void cleanup() {
        var keys = entries.entrySet().stream().filter(e -> e.getValue().pins == 0 && expired(e.getValue()))
                .map(Map.Entry::getKey).toList();
        keys.forEach(this::remove);
    }

    private void remove(String key) {
        size -= entries.remove(key).bytes.length;
    }

    static void hash(String value) {
        if (value == null || !value.matches("[a-f0-9]{64}"))
            throw new IllegalArgumentException("图片 SHA-256 格式无效");
    }
}
