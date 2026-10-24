package com.example.service;

import static org.junit.jupiter.api.Assertions.*;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.time.Duration;
import java.util.List;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import com.example.*;
import com.example.config.*;
import com.example.web.dto.DispatchDtos.ImageRef;

class ImageCacheTest {
    @Test void statsDoNotRenewIdleExpiryAndIncludeExpiredPinnedBytes() throws Exception {
        var clock = new MutableClock();
        var cache = new ImageCache(TestRequests.dispatch(), com.example.TestRequests.vision(), clock);
        byte[] bytes = image(9);
        String hash = ImageValidationService.sha256(bytes);
        cache.put(hash, bytes);
        clock.advance(Duration.ofMinutes(29));
        assertEquals(bytes.length, cache.stats(List.of(hash)).bytes());
        clock.advance(Duration.ofMinutes(1));
        assertEquals(0, cache.stats(List.of(hash)).imageCount());
        cache.put(hash, bytes);
        try (var lease = cache.pin(List.of(new ImageRef("img1", hash), new ImageRef("img2", hash)))) {
            clock.advance(Duration.ofHours(3));
            var stats = cache.stats(List.of(hash, hash));
            assertEquals(new ImageCache.CacheStats(1, bytes.length, 1, bytes.length), stats);
            assertFalse(lease.payloads(List.of("img1")).isEmpty());
        }
        assertEquals(0, cache.stats(List.of(hash)).bytes());
    }

    @Test void concurrentUploadsPinsAndClearsPreserveCapacityAccounting() throws Exception {
        var config = TestRequests.dispatch();
        byte[] bytes = image(10), other = image(11);
        String hash = ImageValidationService.sha256(bytes);
        var small = new DispatchProperties(Math.max(bytes.length, other.length), config.imageIdleSeconds(), config.imageLifetimeSeconds(),
                config.taskTimeoutSeconds(), config.resultRetentionSeconds(), config.maxResults(),
                config.resultCacheBytes(), config.cleanupSeconds(), config.selectionOutputTokens(), config.stateOutputTokens());
        var cache = new ImageCache(small, com.example.TestRequests.vision(), new MutableClock());
        try (var executor = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var start = new java.util.concurrent.CountDownLatch(1);
            var workers = new java.util.ArrayList<java.util.concurrent.Future<?>>();
            for (int thread = 0; thread < 6; thread++) {
                workers.add(executor.submit(() -> {
                    start.await();
                    for (int i = 0; i < 40; i++) {
                        cache.put(hash, bytes);
                        try (var lease = cache.pin(List.of(new ImageRef("img1", hash)))) {
                            assertEquals(bytes.length, cache.stats(List.of(hash)).inUseBytes());
                            assertFalse(lease.payloads(List.of("img1")).isEmpty());
                        } catch (DispatchException e) {
                            assertEquals("IMAGE_CACHE_MISS", e.code());
                        }
                        try {
                            cache.clear(List.of(hash));
                        } catch (DispatchException e) {
                            assertEquals("IMAGE_IN_USE", e.code());
                        }
                    }
                    return null;
                }));
            }
            start.countDown();
            for (var worker : workers) worker.get(20, java.util.concurrent.TimeUnit.SECONDS);
        }
        cache.clear(List.of(hash));
        assertEquals(0, cache.stats(List.of(hash)).bytes());
        cache.put(hash, bytes);
        assertEquals(bytes.length, cache.clear(List.of(hash)).releasedBytes());
        cache.put(hash, bytes);
        String otherHash = ImageValidationService.sha256(other);
        cache.put(otherHash, other);
        assertEquals(new ImageCache.CacheStats(1, other.length, 0, 0), cache.stats(List.of(hash, otherHash)));
    }
    private byte[] image(int color) throws Exception {
        var image = new BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB);
        image.setRGB(0, 0, color);
        var out = new ByteArrayOutputStream(); ImageIO.write(image, "png", out); return out.toByteArray();
    }
    @Test void validatesOnceAndDeduplicatesContentAcrossAssetNames() throws Exception {
        var clock = new MutableClock(); var cache = new ImageCache(TestRequests.dispatch(), com.example.TestRequests.vision(), clock);
        byte[] bytes = image(2); String hash = ImageValidationService.sha256(bytes);
        cache.put(hash, bytes); cache.put(hash, bytes);
        try (var lease = cache.pin(List.of(new ImageRef("img1", hash), new ImageRef("img2", hash)))) {
            assertEquals(lease.payloads(List.of("img1")).getFirst().dataUrl(), lease.payloads(List.of("img2")).getFirst().dataUrl());
        }
        assertThrows(IllegalArgumentException.class, () -> cache.put("0".repeat(64), bytes));
        assertThrows(IllegalArgumentException.class, () -> cache.put(ImageValidationService.sha256(new byte[]{1}), new byte[]{1}));
    }
    @Test void idleAndAbsoluteExpiryAreIndependentAndPinnedImagesSurvive() throws Exception {
        var clock = new MutableClock(); var cache = new ImageCache(TestRequests.dispatch(), com.example.TestRequests.vision(), clock);
        byte[] bytes = image(4); String hash = ImageValidationService.sha256(bytes); cache.put(hash, bytes);
        clock.advance(Duration.ofMinutes(29));
        try (var lease = cache.pin(List.of(new ImageRef("img1", hash)))) {
            clock.advance(Duration.ofHours(2)); cache.cleanup();
            assertEquals(List.of(hash), cache.missing(List.of(hash)));
            assertFalse(lease.payloads(List.of("img1")).isEmpty());
            assertThrows(DispatchException.class, () -> cache.pin(List.of(new ImageRef("img2", hash))));
        }
        cache.put(hash, bytes);
        clock.advance(Duration.ofMinutes(30));
        assertEquals(List.of(hash), cache.missing(List.of(hash)));
        cache.put(hash, bytes);
        for (int i = 0; i < 3; i++) {
            clock.advance(Duration.ofMinutes(29));
            try (var lease = cache.pin(List.of(new ImageRef("img1", hash)))) { assertNotNull(lease); }
        }
        clock.advance(Duration.ofMinutes(29));
        try (var lease = cache.pin(List.of(new ImageRef("img1", hash)))) { assertNotNull(lease); }
        clock.advance(Duration.ofMinutes(4));
        assertEquals(List.of(hash), cache.missing(List.of(hash)));
    }
    @Test void lruEvictsOnlyUnpinnedImagesAndFullPinnedCacheRejectsAdmission() throws Exception {
        var clock = new MutableClock(); byte[] one = image(1), two = image(2);
        var defaults = TestRequests.dispatch();
        var small = new DispatchProperties(Math.max(one.length, two.length), 1800, 7200, 600, 7200, 32, 67108864, 60, 4096, 8192);
        var cache = new ImageCache(small, com.example.TestRequests.vision(), clock);
        String a = ImageValidationService.sha256(one), b = ImageValidationService.sha256(two);
        cache.put(a, one);
        try (var pinned = cache.pin(List.of(new ImageRef("img1", a)))) {
            assertThrows(DispatchException.class, () -> cache.put(b, two));
        }
        cache.put(b, two);
        assertEquals(List.of(a), cache.missing(List.of(a, b)));
    }
}
