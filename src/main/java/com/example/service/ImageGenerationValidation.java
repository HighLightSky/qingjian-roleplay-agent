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
    private final PoseValidation poses;

    public ImageGenerationValidation(ImageGenerationProperties config, VisionProperties vision, PoseValidation poses) {
        this.config = config;
        this.vision = vision;
        this.poses = poses;
    }

    public Submission validateRequest(GenerationRequest request) throws IOException {
        if (request == null || request.source() == null)
            throw new IllegalArgumentException("生图请求缺少来源");
        StateValidation.id(request.runId());
        var source = request.source();
        StateValidation.id(source.planId());
        StateValidation.id(source.sessionId());
        StateValidation.id(source.assistantMessageId());
        if (source.sourceSeq() < 1 || source.sourceCheckpointVersion() < 1)
            throw new IllegalArgumentException("画面来源检查点无效");
        return validateCanvasSubmission(request.prompt(), request.width(), request.height(), request.referenceImages(),
                request.poseEnabled(), request.poseQuery(), request.characterReferenceAssetId(), request.poseSelection());
    }

    public Submission validateDirectRequest(DirectGenerationRequest request) throws IOException {
        if (request == null)
            throw new IllegalArgumentException("生图请求不能为空");
        StateValidation.id(request.runId());
        if (request.poseEnabled()) {
            if (request.width() == null || request.height() == null)
                throw new IllegalArgumentException("姿势生图必须指定画面宽高");
            return validateCanvasSubmission(request.prompt(), request.width(), request.height(), request.referenceImages(),
                    true, request.poseQuery(), request.characterReferenceAssetId(), request.poseSelection());
        }
        validatePromptAndReferences(request.prompt(), request.referenceImages(), false);
        validatePose(false, request.poseQuery(), request.characterReferenceAssetId(), request.referenceImages(),
                request.poseSelection());
        if (request.referenceImages().isEmpty())
            throw new IllegalArgumentException("直接生图至少需要一张参考图，第一张为编辑目标");
        validateEffectivePrompt(request.prompt());
        return new Submission(request.prompt(), request.prompt(), null, null, request.referenceImages(), false, null, null, null);
    }

    private Submission validateCanvasSubmission(String prompt, int requestedWidth, int requestedHeight,
            List<InputImage> references, boolean poseEnabled, String poseQuery, String characterReferenceAssetId,
            PoseSelection poseSelection) throws IOException {
        validatePromptAndReferences(prompt, references, true);
        int width = aligned(requestedWidth), height = aligned(requestedHeight);
        if ((long) width * height > config.maxPixels())
            throw new IllegalArgumentException("画幅像素超出生图限制");
        validatePose(poseEnabled, poseQuery, characterReferenceAssetId, references, poseSelection);
        String effectivePrompt = SceneImagePromptAssembler.assemble(prompt, poseQuery, poseEnabled, references);
        validateEffectivePrompt(effectivePrompt);
        return new Submission(prompt, effectivePrompt, width, height, references, poseEnabled, poseQuery,
                characterReferenceAssetId, poseSelection);
    }

    private void validatePose(boolean enabled, String query, String characterReferenceAssetId,
            List<InputImage> references, PoseSelection selection) throws IOException {
        if (characterReferenceAssetId != null)
            ImageIds.requireValid(characterReferenceAssetId);
        if (enabled) {
            poses.query(query);
            poses.selection(selection);
            if (references.isEmpty() || !references.getFirst().assetId().equals(characterReferenceAssetId))
                throw new IllegalArgumentException("姿势生图必须将指定的人物参考图放在 image2");
        } else if (selection != null) {
            throw new IllegalArgumentException("关闭姿势参考时不能提交姿势候选");
        }
    }

    private void validateEffectivePrompt(String prompt) {
        if (prompt.codePointCount(0, prompt.length()) > config.maxPromptCharacters())
            throw new IllegalArgumentException("包含参考说明的实际提示词长度超限");
    }

    private void validatePromptAndReferences(String prompt, List<InputImage> references, boolean canvas) {
        if (prompt == null || prompt.isBlank())
            throw new IllegalArgumentException("生图提示词不能为空");
        if (references.size() + (canvas ? 1 : 0) > vision.getMaxImages())
            throw new IllegalArgumentException("生图参考图数量超限" + (canvas ? "，黑色画布占用一个图片名额" : ""));
        var ids = new HashSet<String>();
        for (var reference : references) {
            ImageIds.requireValid(reference.assetId());
            if (!ids.add(reference.assetId()))
                throw new IllegalArgumentException("参考图编号重复");
            ImageCache.hash(reference.sha256());
            ImageCache.hash(reference.sourceSha256());
            StateValidation.nonblank(reference.scope());
            if (reference.sourceGenerationId() != null)
                StateValidation.id(reference.sourceGenerationId());
        }
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
