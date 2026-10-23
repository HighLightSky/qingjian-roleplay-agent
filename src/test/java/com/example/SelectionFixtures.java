package com.example;

import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.*;
import java.util.stream.Stream;
import javax.imageio.ImageIO;

import org.junit.jupiter.params.provider.Arguments;

import com.example.web.dto.*;
import com.example.web.dto.VisualDtos.*;

/** 纯文字、聊天原图及角色照片的正交组合，所有来源和原件均可通过入口校验。 */
public final class SelectionFixtures {
    public enum History { NONE, TEXT, IMAGE }
    public enum Photo { NONE, FIRST, OBSERVED }
    public record Scenario(ChatApiRequest context, List<Payload> images, Set<String> expectedSelected) {}

    private SelectionFixtures() {}

    public static Stream<Arguments> cases() {
        return Arrays.stream(History.values()).flatMap(history -> Arrays.stream(Photo.values())
                .map(photo -> Arguments.of(history, photo)));
    }

    public static Scenario scenario(History history, Photo photo) throws Exception {
        List<HistoryMessageDto> messages = new ArrayList<>();
        List<Asset> catalog = new ArrayList<>();
        List<Payload> images = new ArrayList<>();
        if (photo != Photo.NONE) {
            Payload payload = image("img2", Color.RED);
            images.add(payload);
            var source = new CharacterPhotoSource("character", 1);
            var observation = photo == Photo.OBSERVED
                    ? new Observation("img2", "红色斗篷，耳饰未辨清", List.of("红色斗篷"), List.of(), List.of("耳饰花纹不清"), List.of(source), 1)
                    : null;
            catalog.add(asset(payload, List.of(source), observation));
        }
        if (history != History.NONE) {
            String text = history == History.IMAGE ? "这是之前上传的地图，右下角有一行小字。" : "我喜欢喝茶，请记住。";
            var parts = history == History.IMAGE
                    ? List.of(ContentPartDto.text(text), new ContentPartDto("image", null, "img1"))
                    : List.of(ContentPartDto.text(text));
            messages.add(new HistoryMessageDto("user", text, "old-user", parts, 1, "complete", 1));
            messages.add(new HistoryMessageDto("assistant", "[台词]我记下了。", "old-assistant", List.of(), 2, "complete", 1));
            if (history == History.IMAGE) {
                Payload payload = image("img1", Color.BLUE);
                images.add(payload);
                var source = new MessageSource("old-user", 1, text, 1, 1);
                var observation = new Observation("img1", "地图上标出了码头", List.of("蓝色道路"), List.of("PIER"),
                        List.of("右下角小字未辨清"), List.of(source), 1);
                catalog.add(asset(payload, List.of(source), observation));
            }
        }
        String input = history == History.IMAGE ? "请重新核对之前上传的第一张地图右下角未辨清的小字。"
                : photo == Photo.OBSERVED ? "请重新核对角色形象参考照片中耳饰未辨清的花纹。" : "你好，请根据角色设定打个招呼。";
        var context = new ChatApiRequest(new CharacterDto("林溪", "旧友", "旅馆老板", photo == Photo.NONE ? null : "img2", 1),
                TestRequests.state(List.of("用户喜欢喝茶")), TestRequests.summary(), messages, new InputDto(input, null),
                new InteractionSettingsDto(InteractionSettingsDto.ReplyLength.SHORT, InteractionSettingsDto.NarrativeMode.INTERACTIVE),
                new Context("session", catalog, null, List.of(), List.of()), "selection-fixture");
        Set<String> expected = history == History.IMAGE ? Set.of("img1") : photo == Photo.OBSERVED ? Set.of("img2") : Set.of();
        return new Scenario(context, List.copyOf(images), expected);
    }

    private static Asset asset(Payload payload, List<Source> sources, Observation observation) {
        return new Asset(payload.assetId(), payload.sha256(), "image/png", Base64.getDecoder()
                .decode(payload.dataUrl().substring(payload.dataUrl().indexOf(',') + 1)).length, 32, 32, sources, observation, List.of());
    }

    private static Payload image(String id, Color color) throws Exception {
        var image = new BufferedImage(32, 32, BufferedImage.TYPE_INT_RGB);
        var graphics = image.createGraphics();
        graphics.setColor(color);
        graphics.fillRect(0, 0, 32, 32);
        graphics.dispose();
        var bytes = new ByteArrayOutputStream();
        ImageIO.write(image, "png", bytes);
        byte[] data = bytes.toByteArray();
        return new Payload(id, com.example.service.ImageValidationService.sha256(data),
                "data:image/png;base64," + Base64.getEncoder().encodeToString(data));
    }
}
