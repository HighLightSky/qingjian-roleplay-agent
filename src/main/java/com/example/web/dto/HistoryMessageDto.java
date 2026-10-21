package com.example.web.dto;

import java.util.List;

/** id 用于核验图片来源，parts 保留图文顺序；旧文字请求可只传 role/text。 */
public record HistoryMessageDto(String role, String text, String id, List<ContentPartDto> parts) {
    public HistoryMessageDto(String role, String text) { this(role, text, null, null); }
}
