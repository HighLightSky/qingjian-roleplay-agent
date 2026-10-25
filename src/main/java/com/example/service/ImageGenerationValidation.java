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
    private final VisionProperties vision;

    public ImageGenerationValidation(ImageGenerationProperties config, VisionProperties vision) {
        this.config = config;
        this.vision = vision;
    }

    public Submission validateRequest(GenerationRequest request) {
        if (request == null || request.source() == null)
            throw new IllegalArgumentException("生图请求缺少来源");
        StateValidation.id(request.runId());
        var source = request.source();
        StateValidation.id(source.planId());
        StateValidation.id(source.sessionId());
        StateValidation.id(source.assistantMessageId());
        if (source.sourceSeq() < 1 || source.sourceCheckpointVersion() < 1)
            throw new IllegalArgumentException("画面来源检查点无效");
        if (request.prompt() == null || request.prompt().isBlank())
            throw new IllegalArgumentException("生图提示词不能为空");
        if (request.referenceImages().size() + 1 > vision.getMaxImages())
            throw new IllegalArgumentException("参考图数量超限，黑色画布占用一个图片名额");
        for (var reference : request.referenceImages()) {
            ImageIds.requireValid(reference.assetId());
            ImageCache.hash(reference.sha256());
            ImageCache.hash(reference.sourceSha256());
            StateValidation.nonblank(reference.scope());
            if (reference.sourceGenerationId() != null)
                StateValidation.id(reference.sourceGenerationId());
        }
        int width = aligned(request.width()), height = aligned(request.height());
        if ((long) width * height > config.maxPixels())
            throw new IllegalArgumentException("黑色画布像素超出生图限制");
        String effectivePrompt = SceneImagePromptAssembler.assemble(request.prompt(), request.referenceImages());
        if (effectivePrompt.codePointCount(0, effectivePrompt.length()) > config.maxPromptCharacters())
            throw new IllegalArgumentException("包含参考说明的实际提示词长度超限");
        return new Submission(request.prompt(), effectivePrompt, width, height, request.referenceImages());
    }

    private int aligned(int value) {
        if (value < 1)
            throw new IllegalArgumentException("画面宽高必须为正整数");
        long aligned = ((long) value + config.dimensionAlignment() - 1) / config.dimensionAlignment()
                * config.dimensionAlignment();
        if (aligned > config.maxEdge())
            throw new IllegalArgumentException("画面宽高超出生图最长边限制");
        return (int) aligned;
    }

    public Image blackCanvas(Submission submission) throws IOException {
        var image = new java.awt.image.BufferedImage(submission.width(), submission.height(),
                java.awt.image.BufferedImage.TYPE_INT_RGB);
        var bytes = new ByteArrayOutputStream();
        ImageIO.write(image, "png", bytes);
        return new Image("黑色画布", "image/png", submission.width(), submission.height(), bytes.toByteArray());
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
