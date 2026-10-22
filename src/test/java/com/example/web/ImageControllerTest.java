package com.example.web;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.Map;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import com.example.MutableClock;
import com.example.TestRequests;
import com.example.config.VisionProperties;
import com.example.service.ContextLimits;
import com.example.service.ImageCache;
import com.example.service.ImageValidationService;
import com.example.web.dto.DispatchDtos.ImageRef;
import com.fasterxml.jackson.databind.ObjectMapper;

class ImageControllerTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final VisionProperties vision = new VisionProperties();
    private final ImageCache cache = new ImageCache(TestRequests.dispatch(), vision, new MutableClock());
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new ImageController(cache, vision))
            .setControllerAdvice(new ApiExceptionHandler()).build();

    private byte[] image(int color) throws Exception {
        var image = new BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB);
        image.setRGB(0, 0, color);
        var output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return output.toByteArray();
    }

    private String upload(byte[] bytes) throws Exception {
        String hash = ImageValidationService.sha256(bytes);
        mvc.perform(put("/api/images/" + hash).content(bytes)).andExpect(status().isOk());
        return hash;
    }

    @Test
    void statsAndClearOnlyAffectRequestedHashesAndClearIsIdempotent() throws Exception {
        byte[] first = image(1), second = image(2);
        String a = upload(first), b = upload(second);
        String body = mapper.writeValueAsString(Map.of("hashes", List.of(a, a, "0".repeat(64))));
        mvc.perform(post("/api/images/cache/stats").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk()).andExpect(jsonPath("$.imageCount").value(1))
                .andExpect(jsonPath("$.bytes").value(first.length))
                .andExpect(jsonPath("$.inUseImageCount").value(0)).andExpect(jsonPath("$.inUseBytes").value(0));
        mvc.perform(post("/api/images/cache/clear").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk()).andExpect(jsonPath("$.releasedImageCount").value(1))
                .andExpect(jsonPath("$.releasedBytes").value(first.length));
        mvc.perform(post("/api/images/cache/clear").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk()).andExpect(jsonPath("$.releasedImageCount").value(0))
                .andExpect(jsonPath("$.releasedBytes").value(0));
        assertEquals(List.of(a), cache.missing(List.of(a, b)));
        assertEquals(second.length, cache.stats(List.of(b)).bytes());
    }

    @Test
    void anyPinnedTargetRejectsTheWholeClearWithoutDeletingIdleTargets() throws Exception {
        byte[] first = image(3), second = image(4);
        String a = upload(first), b = upload(second);
        String body = mapper.writeValueAsString(Map.of("hashes", List.of(a, b)));
        try (var lease = cache.pin(List.of(new ImageRef("img1", b)))) {
            mvc.perform(post("/api/images/cache/stats").contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().isOk()).andExpect(jsonPath("$.inUseImageCount").value(1))
                    .andExpect(jsonPath("$.inUseBytes").value(second.length));
            mvc.perform(post("/api/images/cache/clear").contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("IMAGE_IN_USE"));
            assertEquals(2, cache.stats(List.of(a, b)).imageCount());
            assertFalse(lease.payloads(List.of("img1")).isEmpty());
        }
        mvc.perform(post("/api/images/cache/clear").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk()).andExpect(jsonPath("$.releasedImageCount").value(2))
                .andExpect(jsonPath("$.releasedBytes").value(first.length + second.length));
    }

    @ParameterizedTest
    @ValueSource(strings = {"stats", "clear"})
    void validatesRequestAtTheSharedBoundary(String action) throws Exception {
        String path = "/api/images/cache/" + action;
        for (String empty : List.of("{}", "{\"hashes\":null}", "{\"hashes\":[]}"))
            mvc.perform(post(path).contentType(MediaType.APPLICATION_JSON).content(empty)).andExpect(status().isOk());
        for (String invalid : List.of("{\"hashes\":[\"invalid\"]}", "{\"hashes\":[null]}"))
            mvc.perform(post(path).contentType(MediaType.APPLICATION_JSON).content(invalid))
                    .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_REQUEST"));
        var tooMany = java.util.Collections.nCopies(ContextLimits.COLLECTION_ITEMS + 1, "0".repeat(64));
        mvc.perform(post(path).contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("hashes", tooMany))))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_REQUEST"));
    }
}
