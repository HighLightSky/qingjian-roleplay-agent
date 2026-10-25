package com.example.service;

import java.io.*;
import java.util.*;
import javax.imageio.ImageIO;
import org.springframework.stereotype.Service;
import com.example.config.*;
import com.example.image.QwenImageClient.Image;
import com.example.web.dto.SceneImageDtos.*;

@Service
public class ImageGenerationValidation {
    private final ImageGenerationProperties config;
    private final SceneImagePlanService plans;

    public ImageGenerationValidation(ImageGenerationProperties config, SceneImagePlanService plans) {
        this.config = config;
        this.plans = plans;
    }

    public void validateRequest(GenerationRequest request) {
        if (request == null)
            throw new IllegalArgumentException("生图请求不能为空");
        StateValidation.id(request.runId());
        var plan = request.plan();
        if (plan == null || !"ready".equals(plan.status()) || request.character() == null)
            throw new IllegalArgumentException("只有完整的可执行画面计划才能生成");
        StateValidation.id(plan.id());
        StateValidation.id(plan.sessionId());
        StateValidation.id(plan.assistantMessageId());
        StateValidation.id(plan.sceneId());
        if (plan.sourceSeq() < 1 || plan.sourceCheckpointVersion() < 1
                || plan.profileVersion() != request.character().profileVersion())
            throw new IllegalArgumentException("画面来源版本无效");
        plans.validateReferences(plan.referenceImages(), request.character().appearancePhotoAssetId());
        if (request.images().size() != plan.referenceImages().size())
            throw new IllegalArgumentException("生图参考图片数量超限或不匹配");
        plans.validateTarget(plan.target());
        plans.validatePrompt(plan.prompt(), plan.referenceImages());
        if (!SceneImagePromptAssembler.summary(plan.prompt()).equals(plan.summary()))
            throw new IllegalArgumentException("生成摘要与画面提示词不一致");
        if (!plans.fingerprint(plan).equals(plan.fingerprint()))
            throw new IllegalArgumentException("画面计划指纹不一致");
        for (int i = 0; i < request.images().size(); i++) {
            var input = request.images().get(i);
            var reference = plan.referenceImages().get(i);
            if (!reference.assetId().equals(input.assetId()))
                throw new IllegalArgumentException("上传顺序与画面编号不一致");
            ImageCache.hash(input.sha256());
            ImageCache.hash(input.sourceSha256());
            if (!input.sourceSha256().equals(reference.sourceSha256()))
                throw new IllegalArgumentException("参考图原件与冻结计划不一致");
            if ((i == 0 || reference.roles().contains("identity")) && !input.sha256().equals(input.sourceSha256()))
                throw new IllegalArgumentException("底图和身份参考必须使用原图");
        }
    }

    public void validateInputImages(List<Image> images) {
        long pixels = 0;
        for (var image : images) {
            long count = (long) image.width() * image.height();
            if (image.bytes().length > config.maxImageBytes() || count > config.maxPixels()
                    || image.width() > config.maxEdge() || image.height() > config.maxEdge())
                throw new IllegalArgumentException("生图参考超过单图体积或像素限制：" + image.assetId());
            pixels += count;
        }
        if (pixels > config.maxTotalPixels())
            throw new IllegalArgumentException("生图参考总像素超限");
    }

    public void validateOutput(byte[] bytes) throws IOException {
        if (bytes.length < 33 || bytes.length > config.maxOutputBytes())
            throw new IOException("生成 PNG 字节不完整或体积超限");
        try (var input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext())
                throw new IOException("生成 PNG 无法解码");
            var reader = readers.next();
            try {
                reader.setInput(input);
                if (!"png".equalsIgnoreCase(reader.getFormatName()) || reader.getWidth(0) < 1 || reader.getHeight(0) < 1
                        || (long) reader.getWidth(0) * reader.getHeight(0) > config.maxOutputPixels())
                    throw new IOException("生成 PNG 格式或像素超限");
                // IEND 必须完整，不能把仅能解码部分像素的截断 PNG 当作结果。
                if (java.nio.ByteBuffer.wrap(bytes, bytes.length - 12, 12).getInt() != 0
                        || java.nio.ByteBuffer.wrap(bytes, bytes.length - 8, 4).getInt() != 0x49454e44
                        || reader.read(0) == null)
                    throw new IOException("生成 PNG 不完整");
            } finally {
                reader.dispose();
            }
        }
    }
}
