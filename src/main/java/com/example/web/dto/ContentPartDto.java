package com.example.web.dto;

/** 用户或历史消息的有序内容；图片块保存本地资产 ID，不内嵌原图。 */
public record ContentPartDto(String type, String text, String assetId) {
    public static ContentPartDto text(String text) {
        return new ContentPartDto("text", text, null);
    }
}
