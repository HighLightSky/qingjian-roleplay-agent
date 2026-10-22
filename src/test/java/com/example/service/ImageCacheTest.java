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
    private byte[] image(int color) throws Exception {
        var image = new BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB);
        image.setRGB(0, 0, color);
        var out = new ByteArrayOutputStream(); ImageIO.write(image, "png", out); return out.toByteArray();
    }
    @Test void validatesOnceAndDeduplicatesContentAcrossAssetNames() throws Exception {
        var clock = new MutableClock(); var cache = new ImageCache(TestRequests.dispatch(), new VisionProperties(), clock);
        byte[] bytes = image(2); String hash = ImageValidationService.sha256(bytes);
        cache.put(hash, bytes); cache.put(hash, bytes);
        try (var lease = cache.pin(List.of(new ImageRef("img1", hash), new ImageRef("img2", hash)))) {
            assertEquals(lease.payloads(List.of("img1")).getFirst().dataUrl(), lease.payloads(List.of("img2")).getFirst().dataUrl());
        }
        assertThrows(IllegalArgumentException.class, () -> cache.put("0".repeat(64), bytes));
        assertThrows(IllegalArgumentException.class, () -> cache.put(ImageValidationService.sha256(new byte[]{1}), new byte[]{1}));
    }
    @Test void idleAndAbsoluteExpiryAreIndependentAndPinnedImagesSurvive() throws Exception {
        var clock = new MutableClock(); var cache = new ImageCache(TestRequests.dispatch(), new VisionProperties(), clock);
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
        var cache = new ImageCache(small, new VisionProperties(), clock);
        String a = ImageValidationService.sha256(one), b = ImageValidationService.sha256(two);
        cache.put(a, one);
        try (var pinned = cache.pin(List.of(new ImageRef("img1", a)))) {
            assertThrows(DispatchException.class, () -> cache.put(b, two));
        }
        cache.put(b, two);
        assertEquals(List.of(a), cache.missing(List.of(a, b)));
    }
}
