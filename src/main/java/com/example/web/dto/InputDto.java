package com.example.web.dto;

import java.util.List;
import java.util.stream.Collectors;

/** 用户输入：有序文字和图片引用；parts 存在时以 parts 为准。 */
public record InputDto(String text, List<ContentPartDto> parts) {
    public List<ContentPartDto> content() {
        return parts != null ? parts : List.of(ContentPartDto.text(text == null ? "" : text));
    }

    /** 本轮文字，供长度校验和模型请求使用。 */
    public String textOf() {
        return content().stream().filter(p -> "text".equals(p.type())).map(ContentPartDto::text)
                .collect(Collectors.joining("\n"));
    }
}
