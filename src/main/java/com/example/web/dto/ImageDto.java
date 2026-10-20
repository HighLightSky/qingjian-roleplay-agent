package com.example.web.dto;

/**
 * 本轮输入的图片数据，仅在当前请求中使用，后端不保存图片。
 *
 * @param dataUrl 包含 MIME 类型和 Base64 数据的完整 data URL，例如 data:image/png;base64,...
 */
public record ImageDto(
        String dataUrl
) {}
